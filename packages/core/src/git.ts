import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDataLayout } from './init.ts';
import { ownerOfPath, type Writer } from './layout.ts';
import { isOsJunk, isSecretLookingPath, isTmpArtifactName } from './names.ts';
import { repositoryKey } from './remote-key.ts';
import { realPath } from './repo-paths.ts';
import { RepoMetaSchema, SCHEMA_VERSION } from './schema.ts';

export type GitIdentity = { name: string; email: string };

export type SyncResult = {
  /** Sha of the commit made from local changes, as it stands in HEAD's history; null if none survived. */
  committed: string | null;
  /** True when the remote branch equals local HEAD after the call. `pullRepo` never pushes and reports false. */
  pushed: boolean;
  /** Paths settled by the owner-wins rule, each once, sorted. */
  resolved: string[];
  /**
   * Set only when the call followed a host rewind it was allowed to follow (`acceptRewind`) and that dropped
   * commits from local `main`: how many, and the local ref that keeps them reachable (never pushed). Otherwise null.
   */
  rewound: { dropped: number; keptUnder: string } | null;
};

/** Options of `pullRepo`. */
export type PullOptions = {
  /**
   * Follow the remote when the git host's `main` went back and local `main` would lose commits that were once
   * on it (R5). Without it (or `restoreHost`) the call throws `HostRewoundError` and changes nothing (R53).
   */
  acceptRewind?: boolean;
  /**
   * The other answer to `HostRewoundError`: the rollback was a mistake. When the host's tip is an ancestor of
   * local `main`, local `main` is pushed back to the host as a fast-forward (never forced; the secret guard
   * runs as on every push), `pullRepo` included. When the host's history was rewritten instead, `GitError`,
   * and nothing changes. Not together with `acceptRewind`.
   */
  restoreHost?: boolean;
};

/** Options of `syncRepo`. */
export type SyncOptions = PullOptions & {
  /** Pull-and-push attempts when the remote moves under us (default 3). */
  maxAttempts?: number;
};

const REWIND_ANSWERS =
  'If the host was rolled back on purpose, sync again accepting the rollback (acceptRewind). If it was a mistake, ' +
  'sync again restoring the host (restoreHost): this puts the commits back on the host.';

/** The oldest git this code runs on: `git log --diff-merges=first-parent` (the push guard) needs 2.31. */
export const MIN_GIT_VERSION = '2.31.0';

/** Hooks the tests use to step into a call. Not part of any exported type, and not exported from the package. */
type TestHooks = {
  /** Runs right before each push (the remote can be moved here). */
  beforePush?: () => Promise<void>;
  /** Runs after the fetch, right before the pulled changes are applied. */
  beforeIntegrate?: () => Promise<void>;
};
const TEST_HOOKS = Symbol.for('company-of-bots.core.git.test-hooks.v1');

/** INTERNAL, TEST-ONLY (not exported from the package): a copy of `opts` that also runs `hooks`. */
export function withTestHooks(hooks: TestHooks, opts: SyncOptions = {}): SyncOptions {
  return Object.assign({ ...opts }, { [TEST_HOOKS]: hooks });
}

function hooksOf(opts: PullOptions): TestHooks {
  return (opts as Record<symbol, TestHooks | undefined>)[TEST_HOOKS] ?? {};
}

const BRANCH = 'main';
const REMOTE = 'origin';
const DEFAULT_ATTEMPTS = 3;
/** How often a call re-commits and re-integrates because files kept changing under it. */
const MAX_CYCLES = 5;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
/** Blobs are copied to a scratch file for scanning in groups of about this size. */
const SCAN_GROUP_BYTES = 64 * 1024 * 1024;
const COMMIT_MESSAGE_INIT = 'Initialize private data repo';

/** Flags on every call so the user's own git config cannot change what we read or write, and no hook ever runs. */
const BASE_FLAGS = [
  '-c',
  'core.quotePath=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  `core.hooksPath=${os.devNull}`,
];
/**
 * Set in the local config of every checkout core makes (init and clone): no line-ending or attribute
 * conversion from the user's global config, so files are committed and written byte for byte (R16).
 * A checkout the user's own git made keeps the conversion it was written with (R24).
 */
const BYTE_EXACT_CONFIG: [string, string][] = [
  ['core.autocrlf', 'false'],
  ['core.attributesFile', os.devNull],
];
/**
 * Env on every call: never prompt (the process is unattended), never open an editor,
 * treat every pathspec as a literal path, and use English messages we can match on.
 */
const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_LITERAL_PATHSPECS: '1',
  LC_ALL: 'C',
};
/** Variables that move a call to another repository, work tree, index or object store, or inject config. */
const RELOCATING_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitError extends Error {
  readonly stderr: string;
  readonly args: string[];
  /** Process exit code, or null when git was killed or could not start. */
  readonly exitCode: number | null;

  constructor(message: string, details: { stderr?: string; args?: string[]; exitCode?: number | null } = {}) {
    super(message);
    this.name = 'GitError';
    this.stderr = details.stderr ?? '';
    this.args = details.args ?? [];
    this.exitCode = details.exitCode ?? null;
  }
}

export class SecretLeakError extends Error {
  readonly paths: string[];

  constructor(paths: string[], hint?: string) {
    super(
      `Refusing to sync files that look like cookies or secrets: ${paths.join(', ')}. ` +
        (hint ?? 'Move them out of the data repo, then sync again.'),
    );
    this.name = 'SecretLeakError';
    this.paths = paths;
  }
}

/**
 * The git host's `main` went back (a restore from backup, a scrub by reset, a force-push), so following it
 * would drop commits from local `main` that were once on the host. Nothing was changed: HEAD, `main`, the
 * index, the files and the remote are as they were. The agent stops its run and asks the user; the call is
 * repeated with `acceptRewind: true` once the user agrees. The commits stay reachable under `keptUnder`.
 */
export class HostRewoundError extends GitError {
  readonly dropped: number;
  readonly keptUnder: string;

  constructor(dropped: number, keptUnder: string) {
    super(
      `The git host's ${BRANCH} branch went back: ${dropped} commit${dropped === 1 ? '' : 's'} this data repo has, ` +
        'which were on the host before, are no longer there (it was restored from a backup, reset, or force-pushed). ' +
        `Nothing was synced and nothing was changed. ${REWIND_ANSWERS} Either way the commits stay kept in this ` +
        `folder under ${keptUnder}.`,
    );
    this.name = 'HostRewoundError';
    this.dropped = dropped;
    this.keptUnder = keptUnder;
  }
}

/** Another process is syncing this checkout right now. Nothing was touched; try again shortly. */
export class SyncBusyError extends Error {
  constructor(message = 'Another sync is already running on this data repo. Try again in a moment.') {
    super(message);
    this.name = 'SyncBusyError';
  }
}

/**
 * Hide credentials in remote addresses. In a URL: everything between `://` and the last `@` in it (so a password
 * holding `/` or `@`, and a token in a path segment before an `@`, go too), and the whole query string
 * (`?access_token=…`). In an scp-like address: a `user:password@` before `host:`. Anywhere: a token in a
 * format the big git hosts use (`ghp_…`, `github_pat_…`, `glpat-…`), as some put one in a path segment.
 */
function redact(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|gl(?:pat|dt|ptt|rt|oas)-[A-Za-z0-9_-]{8,})/g, '***')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s'"<>]*)/g, (_m, scheme: string, rest: string) => {
      const at = rest.lastIndexOf('@');
      let r = at < 0 ? rest : `***@${rest.slice(at + 1)}`;
      const q = r.indexOf('?');
      if (q >= 0) r = `${r.slice(0, q)}?***`;
      return scheme + r;
    })
    .replace(/(^|[\s'"(=])[^\s'"@/:]+:(?!\/\/)[^\s'"@]*@(?=[^\s'"@/:]+:)/g, '$1***@');
}

function failure(args: string[], err: unknown, stderrText: string): GitError {
  const e = err as { code?: unknown; killed?: boolean; message?: string };
  const stderr = redact(stderrText);
  const exitCode = typeof e.code === 'number' ? e.code : null;
  const detail = stderr.trim() || (e.killed ? 'the command timed out' : redact((e.message ?? 'unknown error').split('\n')[0] ?? ''));
  return new GitError(`git ${redact(args.join(' '))} failed: ${detail}`, { stderr, args: args.map(redact), exitCode });
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (RELOCATING_ENV.has(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return { ...env, ...BASE_ENV, ...extra };
}

type RunOptions = { input?: string | Buffer; latin1?: boolean; env?: Record<string, string> };

function run(cwd: string, args: string[], o: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...BASE_FLAGS, ...args],
      { cwd, env: childEnv(o.env), maxBuffer: Infinity, timeout: COMMAND_TIMEOUT_MS, encoding: o.latin1 ? 'latin1' : 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(failure(args, err, String(stderr)));
        else resolve(String(stdout));
      },
    );
    if (o.input !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(o.input);
    }
  });
}

/** Run git in `dir`. Resolves with stdout; rejects with `GitError` carrying stderr. */
export function git(dir: string, args: string[], env?: Record<string, string>): Promise<string> {
  return run(dir, args, { env });
}

function runSync(cwd: string, args: string[], o: { input?: string | Buffer; stdout?: number; env?: Record<string, string> } = {}): Buffer {
  try {
    return execFileSync('git', [...BASE_FLAGS, ...args], {
      cwd,
      env: childEnv(o.env),
      maxBuffer: Infinity,
      timeout: COMMAND_TIMEOUT_MS,
      input: o.input,
      stdio: ['pipe', o.stdout ?? 'pipe', 'pipe'],
    }) as Buffer;
  } catch (err) {
    const e = err as { stderr?: Buffer | string | null };
    throw failure(args, err, e.stderr ? e.stderr.toString('latin1') : '');
  }
}

/**
 * Paths are carried as "byte strings": one char per byte (latin1), so a file name that is not valid UTF-8
 * survives a round trip through git unchanged. Paths go to git on stdin (NUL-separated), never in argv.
 */
const toBytes = (utf8: string): string => Buffer.from(utf8, 'utf8').toString('latin1');
const display = (bytes: string): string => Buffer.from(bytes, 'latin1').toString('utf8');
const splitZ = (out: string): string[] => out.split('\0').filter((s) => s.length > 0);
const pathInput = (paths: string[]): Buffer => Buffer.from(paths.map((p) => `${p}\0`).join(''), 'latin1');
const PATHSPEC_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

function absPath(dir: string, bytes: string): Buffer {
  return Buffer.concat([Buffer.from(dir), Buffer.from('/'), Buffer.from(bytes, 'latin1')]);
}

type RawEntry = { oldMode: string; newMode: string; oldSha: string; newSha: string; status: string; path: string };

/** Parse `--raw -z --no-renames --no-abbrev` output. */
function parseRaw(out: string): RawEntry[] {
  const tokens = out.split('\0');
  const entries: RawEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(tokens[i]!);
    if (!m) continue;
    entries.push({ oldMode: m[1]!, newMode: m[2]!, oldSha: m[3]!, newSha: m[4]!, status: m[5]!, path: tokens[i + 1] ?? '' });
    i++;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Secret guard
// ---------------------------------------------------------------------------

const NETSCAPE = '# Netscape HTTP Cookie File';
/** A browser's cookie database: an SQLite file whose schema has a `cookies` (Chromium) or `moz_cookies` (Firefox) table. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';
const COOKIE_TABLE = /CREATE TABLE\s+["'`[]?(?:moz_)?cookies["'`\]]?\s*\(/i;
/** Text kept from the end of one piece so that a needle split across two pieces is still found. */
const NEEDLE_TAIL = 64;

/** Finds the cookie needles in a stream of text pieces, including a needle split across two pieces. */
class NeedleMatcher {
  private tail = '';
  private netscape = false;
  private sameSite = false;
  private httpOnly = false;
  private sqlite = false;
  private cookieTable = false;

  get hit(): boolean {
    return this.netscape || (this.sameSite && this.httpOnly) || (this.sqlite && this.cookieTable);
  }

  scan(text: string): void {
    const s = this.tail + text;
    if (s.includes(NETSCAPE)) this.netscape = true;
    if (s.includes('"sameSite"')) this.sameSite = true;
    if (s.includes('"httpOnly"')) this.httpOnly = true;
    if (s.includes(SQLITE_MAGIC)) this.sqlite = true;
    if (COOKIE_TABLE.test(s)) this.cookieTable = true;
    this.tail = s.slice(-NEEDLE_TAIL);
  }
}

/** Decodes UTF-16 (LE or BE) from a byte stream and feeds the text to a matcher, carrying an odd byte over. */
class Utf16Decoder {
  readonly matcher = new NeedleMatcher();
  private odd: Buffer = Buffer.alloc(0);
  private readonly be: boolean;
  private skip: number;

  constructor(be: boolean, skip: number) {
    this.be = be;
    this.skip = skip;
  }

  feed(data: Buffer): void {
    if (this.skip > 0) {
      const n = Math.min(this.skip, data.length);
      this.skip -= n;
      data = data.subarray(n);
    }
    const all = this.odd.length > 0 ? Buffer.concat([this.odd, data]) : data;
    const even = all.length - (all.length % 2);
    this.odd = Buffer.from(all.subarray(even));
    const body = Buffer.from(all.subarray(0, even));
    if (this.be) body.swap16();
    this.matcher.scan(body.toString('utf16le'));
  }
}

/**
 * Looks for cookie-shaped content in a stream of chunks: the Netscape header, or both `"sameSite"` and
 * `"httpOnly"`. Matches across chunk boundaries. The raw bytes are always searched; when the content starts
 * with a UTF-16 BOM (LE or BE), the decoded text is searched as well (at both byte alignments, in case an
 * odd byte was slipped in), so no form can hide another.
 */
class CookieScanner {
  private readonly raw = new NeedleMatcher();
  private utf16: Utf16Decoder[] = [];
  /** Leading bytes held back until we know whether there is a BOM. */
  private head: Buffer | null = Buffer.alloc(0);

  get hit(): boolean {
    return this.raw.hit || this.utf16.some((d) => d.matcher.hit);
  }

  feed(chunk: Buffer): void {
    let data = Buffer.from(chunk);
    if (this.head !== null) {
      data = Buffer.concat([this.head, data]);
      if (data.length < 2) {
        this.head = data;
        return;
      }
      this.head = null;
      this.raw.scan(data.subarray(0, 2).toString('latin1'));
      if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
        const be = data[0] === 0xfe;
        this.utf16 = [new Utf16Decoder(be, 0), new Utf16Decoder(be, 1)];
      }
      data = data.subarray(2);
    }
    this.raw.scan(data.toString('latin1'));
    for (const d of this.utf16) d.feed(data);
  }

  end(): void {
    if (this.head !== null && this.head.length > 0) this.raw.scan(this.head.toString('latin1'));
    this.head = null;
  }
}

function absoluteGitDir(dir: string): string {
  return runSync(dir, ['rev-parse', '--absolute-git-dir']).toString('utf8').trim();
}

/** Parse the output of `git cat-file --batch` from a file, in chunks; adds the shas whose content looks like cookies. */
function scanBatchFile(file: string, hits: Set<string>): void {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let state: 'header' | 'body' | 'newline' = 'header';
    let header = '';
    let remaining = 0;
    let current: { sha: string; scanner: CookieScanner } | null = null;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      let i = 0;
      while (i < n) {
        if (state === 'header') {
          const nl = buf.subarray(0, n).indexOf(0x0a, i);
          const end = nl < 0 ? n : nl;
          header += buf.toString('latin1', i, end);
          if (nl < 0) break;
          i = nl + 1;
          const [sha, type, size] = header.split(' ');
          header = '';
          if (!sha || type === 'missing' || size === undefined) continue;
          remaining = Number(size);
          current = { sha, scanner: new CookieScanner() };
          state = 'body';
          if (remaining === 0) {
            current.scanner.end();
            state = 'newline';
          }
        } else if (state === 'body') {
          const take = Math.min(remaining, n - i);
          current!.scanner.feed(buf.subarray(i, i + take));
          i += take;
          remaining -= take;
          if (remaining === 0) {
            current!.scanner.end();
            if (current!.scanner.hit) hits.add(current!.sha);
            state = 'newline';
          }
        } else {
          i += 1;
          state = 'header';
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** The blobs (by sha) whose content looks like cookies. Any size: content is streamed through a scratch file. */
function scanBlobs(dir: string, shas: string[]): Set<string> {
  const hits = new Set<string>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return hits;
  const sizes = new Map<string, number>();
  const check = runSync(dir, ['cat-file', '--batch-check'], { input: `${unique.join('\n')}\n` }).toString('latin1');
  for (const line of check.split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (sha && type === 'blob' && size !== undefined) sizes.set(sha, Number(size));
  }
  const scratch = fs.mkdtempSync(path.join(absoluteGitDir(dir), 'cob-scan-'));
  try {
    let group: string[] = [];
    let total = 0;
    const flush = () => {
      if (group.length === 0) return;
      const file = path.join(scratch, 'batch');
      const fd = fs.openSync(file, 'w');
      try {
        runSync(dir, ['cat-file', '--batch'], { input: `${group.join('\n')}\n`, stdout: fd });
      } finally {
        fs.closeSync(fd);
      }
      scanBatchFile(file, hits);
      fs.rmSync(file, { force: true });
      group = [];
      total = 0;
    };
    for (const sha of unique) {
      const size = sizes.get(sha);
      if (size === undefined) continue;
      if (group.length > 0 && total + size > SCAN_GROUP_BYTES) flush();
      group.push(sha);
      total += size;
    }
    flush();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return hits;
}

type BlobRef = { path: string; sha: string };

/** Paths (as byte strings) that look like secrets by name or by content. Deletions never come in here. */
function secretPaths(dir: string, blobs: BlobRef[]): string[] {
  const byName = new Set(blobs.filter((b) => isSecretLookingPath(b.path)).map((b) => b.path));
  const rest = blobs.filter((b) => !byName.has(b.path));
  const hitShas = scanBlobs(dir, rest.map((b) => b.sha));
  const hits = new Set(byName);
  for (const b of rest) if (hitShas.has(b.sha)) hits.add(b.path);
  return blobs.map((b) => b.path).filter((p, i, all) => hits.has(p) && all.indexOf(p) === i);
}

/** Unstage `paths` (byte strings), keeping them in the working tree. */
function unstage(dir: string, paths: string[]): void {
  runSync(dir, ['reset', '-q', ...PATHSPEC_STDIN], { input: pathInput(paths) });
}

/**
 * Throw `SecretLeakError` if any staged path (that is not a deletion) or its staged content looks like cookies
 * or secrets. The offending paths are unstaged first and stay in the working tree. Deleting a path is never refused.
 */
export function assertNoSecrets(dir: string, stagedPaths: string[]): void {
  const wanted = new Set(stagedPaths.map(toBytes));
  const blobs: BlobRef[] = [];
  for (const entry of splitZ(runSync(dir, ['ls-files', '-s', '-z']).toString('latin1'))) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(entry);
    if (m && m[3] === '0' && m[1] !== '160000' && wanted.has(m[4]!)) blobs.push({ path: m[4]!, sha: m[2]! });
  }
  const hits = secretPaths(dir, blobs);
  if (hits.length === 0) return;
  unstage(dir, hits);
  throw new SecretLeakError(hits.map(display));
}

/**
 * Before any push: every path added or changed by the commits about to go out must pass the guard too.
 * `from` is the remote's current tip, or null on a first push (everything from the empty tree up to HEAD).
 */
function assertUnpushedClean(dir: string, from: string | null): void {
  const out = runSync(dir, [
    'log',
    '--raw',
    '-z',
    '--root',
    '--diff-merges=first-parent',
    '--no-color',
    '--no-renames',
    '--no-abbrev',
    '--diff-filter=d',
    '--format=',
    from === null ? 'HEAD' : `${from}..HEAD`,
  ]).toString('latin1');
  const blobs = parseRaw(out)
    .filter((e) => e.newMode !== '160000')
    .map((e) => ({ path: e.path, sha: e.newSha }));
  const hits = secretPaths(dir, blobs);
  if (hits.length > 0) {
    throw new SecretLeakError(
      hits.map(display),
      'They are in commits that have not been pushed, so nothing was pushed. Undo those commits ' +
        `(for example \`git reset --soft ${from === null ? '<first commit>' : 'origin/main'}\`), remove the files, and sync again.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Init and clone
// ---------------------------------------------------------------------------

function assertIdentity(identity: GitIdentity): void {
  if (!identity.name.trim() || !identity.email.trim()) {
    throw new Error('A git name and email are needed to save changes to your data repo.');
  }
}

/** The git found on PATH, checked once per PATH: older than `MIN_GIT_VERSION` is a `GitError` before anything runs. */
const versionChecks = new Map<string, Promise<void>>();

function olderThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

async function checkGitVersion(): Promise<void> {
  let out: string;
  try {
    out = await new Promise<string>((resolve, reject) =>
      execFile('git', ['--version'], { env: childEnv(), timeout: COMMAND_TIMEOUT_MS }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)),
      ),
    );
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw new GitError(
      code === 'ENOENT'
        ? `git was not found. Install git ${MIN_GIT_VERSION} or newer; nothing was changed.`
        : `git could not be run to check its version; nothing was changed.`,
    );
  }
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  const found = m ? `${m[1]}.${m[2]}.${m[3] ?? '0'}` : out.trim() || 'of an unknown version';
  const toNumbers = (v: string) => v.split('.').map(Number);
  if (!m || olderThan(toNumbers(found), toNumbers(MIN_GIT_VERSION))) {
    throw new GitError(`git ${found} was found, but this app needs git ${MIN_GIT_VERSION} or newer. Update git; nothing was changed.`);
  }
}

function assertGitVersion(): Promise<void> {
  const key = process.env.PATH ?? '';
  let check = versionChecks.get(key);
  if (!check) {
    check = checkGitVersion();
    versionChecks.set(key, check);
    check.catch(() => versionChecks.delete(key)); // a refused git is checked again next time (it may be updated)
  }
  return check;
}

function assertRemoteString(remote: string): void {
  if (remote.startsWith('-')) throw new GitError('That remote address is not valid: it starts with a dash.');
}

async function setByteExact(dir: string): Promise<void> {
  for (const [key, value] of BYTE_EXACT_CONFIG) await git(dir, ['config', key, value]);
}

async function setIdentity(dir: string, identity: GitIdentity): Promise<void> {
  await git(dir, ['config', 'user.name', identity.name]);
  await git(dir, ['config', 'user.email', identity.email]);
}

/** A relative local path would be resolved against the repo once stored in its config; make it absolute. */
function absoluteIfLocal(remote: string): string {
  return fs.existsSync(path.resolve(remote)) ? path.resolve(remote) : remote;
}

/**
 * Whether two spellings name one folder, compared through the OS's resolver (as lane A's path layer does), so a
 * lower-case drive letter, an 8.3 short name or another letter case is the same folder as git's canonical path.
 */
export function sameFolder(a: string, b: string, resolve: (p: string) => string = realPath): boolean {
  return resolve(a) === resolve(b);
}

async function assertTopLevel(dir: string): Promise<void> {
  const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  if (!sameFolder(top, dir)) {
    throw new GitError(`${dir} is not the top folder of its own git repository (it sits inside ${top}); nothing was changed.`);
  }
}

async function headRef(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['symbolic-ref', '-q', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
  try {
    await git(dir, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return false;
    throw err;
  }
}

/**
 * The marker `initPrivateRepo` writes inside the git dir. It is written before `git init` runs (so a repo
 * without it was never ours) and records the init commit before the branch points at it.
 */
const INIT_MARKER = 'cob-init.json';
type InitMarker = { app: 'company-of-bots'; commit: string | null };

function readInitMarker(gitDir: string): InitMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(gitDir, INIT_MARKER), 'utf8')) as Partial<InitMarker>;
    if (m.app !== 'company-of-bots') return null;
    if (m.commit !== null && (typeof m.commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(m.commit))) return null;
    return { app: m.app, commit: m.commit };
  } catch {
    return null;
  }
}

function writeInitMarker(gitDir: string, commit: string | null): void {
  const file = path.join(gitDir, INIT_MARKER);
  const temp = `${file}.${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, JSON.stringify({ app: 'company-of-bots', commit } satisfies InitMarker) + '\n');
  fs.renameSync(temp, file);
}

/** What `initDataLayout` writes: relative path → bytes. Generated in a scratch folder under `scratchParent`. */
function layoutFiles(scratchParent: string): Map<string, Buffer> {
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'cob-layout-'));
  try {
    initDataLayout(scratch);
    const out = new Map<string, Buffer>();
    const walk = (rel: string) => {
      for (const name of fs.readdirSync(path.join(scratch, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        if (fs.statSync(path.join(scratch, r)).isDirectory()) walk(r);
        else out.set(r, fs.readFileSync(path.join(scratch, r)));
      }
    };
    walk('');
    return out;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A layout file found when resuming an init killed before its commit. It is kept as it is when it holds
 * exactly what init writes, or is complete JSON (DataRepo writes JSON atomically, so the app may have saved
 * its own version since). Anything else (a half-written text file, a user's edit) refuses the resume.
 */
function keepableLayoutFile(abs: string, expected: Buffer): boolean {
  const bytes = fs.readFileSync(abs);
  if (bytes.equals(expected)) return true;
  if (!abs.endsWith('.json')) return false;
  try {
    JSON.parse(bytes.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

type InitTarget =
  | { kind: 'fresh' }
  | { kind: 'not-empty' }
  | { kind: 'foreign' }
  /** Ours, interrupted before the init commit, but holding a file init would not keep: refused (R18). */
  | { kind: 'resume-blocked'; path: string }
  /** Ours, interrupted before the init commit. Layout files already there are kept; the rest are written. */
  | { kind: 'uncommitted'; gitDir: string; layout: Map<string, Buffer> }
  /** Ours, with the init commit made; the first push may not have happened. */
  | { kind: 'committed'; gitDir: string; commit: string };

/** What is in `dir` already: nothing, a repo `initPrivateRepo` made (proven by its marker), or something else. Read-only. */
async function inspectInitTarget(dir: string): Promise<InitTarget> {
  if (!fs.existsSync(dir)) return { kind: 'fresh' };
  const entries = fs.readdirSync(dir);
  if (!entries.includes('.git')) return { kind: entries.length === 0 ? 'fresh' : 'not-empty' };
  let isRepo = false;
  try {
    isRepo = sameFolder((await git(dir, ['rev-parse', '--show-toplevel'])).trim(), dir);
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    // A `.git` that is not a repository yet: only one a killed call left (holding just our marker) is ours.
    const dotGit = path.join(dir, '.git');
    const ours = fs.statSync(dotGit).isDirectory() && fs.readdirSync(dotGit).every((n) => n === INIT_MARKER);
    return { kind: entries.length === 1 && ours ? 'fresh' : 'not-empty' };
  }
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
  const marker = readInitMarker(gitDir);
  if (marker === null) return { kind: 'foreign' };
  if ((await headRef(dir)) !== `refs/heads/${BRANCH}`) return { kind: 'foreign' };
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    (s) => s.trim(),
    () => null,
  );
  if (marker.commit === null) {
    if (head !== null) return { kind: 'foreign' };
    const layout = layoutFiles(gitDir);
    const present = splitZ(await run(dir, ['ls-files', '-o', '-z'], { latin1: true })).filter((p) => !isTmpArtifactName(p));
    for (const p of present) {
      const expected = layout.get(display(p));
      if (expected === undefined || !keepableLayoutFile(absPath(dir, p).toString(), expected)) return { kind: 'resume-blocked', path: display(p) };
    }
    return { kind: 'uncommitted', gitDir, layout };
  }
  if (head === null) return { kind: 'foreign' };
  const roots = (await git(dir, ['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter(Boolean);
  return roots.length === 1 && roots[0] === marker.commit ? { kind: 'committed', gitDir, commit: marker.commit } : { kind: 'foreign' };
}

/**
 * Write the layout files that are missing (never replacing one that is there) and make the init commit
 * from exactly those paths. The marker names the commit before `main` points at it.
 */
async function commitLayout(dir: string, gitDir: string, layout: Map<string, Buffer>): Promise<void> {
  for (const [rel, bytes] of layout) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes, { flag: 'wx' });
  }
  await run(dir, ['update-index', '--add', '-z', '--stdin'], { input: pathInput([...layout.keys()].map(toBytes)) });
  const tree = (await git(dir, ['write-tree'])).trim();
  const commit = (await run(dir, ['commit-tree', tree, '-F', '-'], { input: `${COMMIT_MESSAGE_INIT}\n` })).trim();
  writeInitMarker(gitDir, commit);
  await git(dir, ['update-ref', `refs/heads/${BRANCH}`, commit, ZERO_SHA]);
}

/** The remote's `main` sha, or '' when it has none. */
async function remoteMainOf(cwd: string, remote: string): Promise<string> {
  const heads = await git(cwd, ['ls-remote', '--heads', '--', remote, `refs/heads/${BRANCH}`]);
  return heads.trim().split(/\s+/)[0] ?? '';
}

const REMOTE_HAS_MAIN = `The remote already has a ${BRANCH} branch that is not this data repo's; use an empty repo. Nothing was changed.`;

/**
 * Create a private data repo in `dir` (created if missing): branch `main`, local identity, the starting
 * layout in one commit, and, when `remote` is given, `origin` with `main` pushed and tracked.
 * A repo this function created (proven by the marker it writes in the git dir) is resumed: a call that was
 * interrupted finishes the layout commit and the first push, even if more commits were made since.
 * Every check runs before anything is written: a refused call (a folder that is not empty, a repository
 * this function did not create, a remote whose `main` is not this repo's, a bad remote string, a secret in
 * the history) changes nothing, not even `origin` or the identity.
 */
export async function initPrivateRepo(dir: string, opts: { identity: GitIdentity; remote?: string }): Promise<void> {
  assertIdentity(opts.identity);
  if (opts.remote !== undefined) assertRemoteString(opts.remote);
  await assertGitVersion();
  const remote = opts.remote === undefined ? undefined : absoluteIfLocal(opts.remote);

  const target = await inspectInitTarget(dir);
  if (target.kind === 'not-empty') throw new Error(`Cannot set up a data repo in ${dir}: the folder is not empty.`);
  if (target.kind === 'foreign') {
    throw new GitError(`${dir} is already a git repository that this app did not create; it was not changed.`);
  }
  if (target.kind === 'resume-blocked') {
    throw new GitError(
      `Cannot finish setting up the data repo in ${dir}: the folder is not empty (${target.path} is not a file set-up ` +
        'would keep). Nothing was changed.',
    );
  }

  // Checks first, read-only.
  const remoteMain = remote === undefined ? '' : await remoteMainOf(process.cwd(), remote);
  if (remoteMain && target.kind !== 'committed') throw new GitError(REMOTE_HAS_MAIN);
  if (remote !== undefined && target.kind === 'committed') {
    if (remoteMain) {
      // Done already only if the remote holds our init commit. Objects only: no ref, no FETCH_HEAD, no config.
      await git(dir, ['fetch', '-q', '--no-write-fetch-head', remote, `refs/heads/${BRANCH}`]);
      if (!(await isAncestor(dir, target.commit, remoteMain))) throw new GitError(REMOTE_HAS_MAIN);
    } else {
      assertUnpushedClean(dir, null);
    }
  }

  // Changes.
  if (target.kind === 'fresh') {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeInitMarker(path.join(dir, '.git'), null);
    await git(dir, ['init', '-q', '-b', BRANCH]);
    await setByteExact(dir);
    await setIdentity(dir, opts.identity);
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
    await commitLayout(dir, gitDir, layoutFiles(gitDir));
  } else if (target.kind === 'uncommitted') {
    await setByteExact(dir);
    await setIdentity(dir, opts.identity);
    await commitLayout(dir, target.gitDir, target.layout);
  } else {
    await setByteExact(dir);
    await setIdentity(dir, opts.identity);
  }

  if (remote === undefined) return;
  const hasOrigin = await git(dir, ['remote', 'get-url', REMOTE]).then(
    () => true,
    () => false,
  );
  await git(dir, hasOrigin ? ['remote', 'set-url', REMOTE, remote] : ['remote', 'add', REMOTE, remote]);
  const address = await originAddress(dir);
  if (remoteMain) {
    await git(dir, ['update-ref', '-m', 'cob: init found its commit on the remote', `refs/remotes/${REMOTE}/${BRANCH}`, remoteMain]);
    await git(dir, ['branch', '-q', `--set-upstream-to=${REMOTE}/${BRANCH}`, BRANCH]);
    await recordSeen(dir, address, remoteMain);
    return;
  }
  assertUnpushedClean(dir, null);
  await git(dir, ['push', '-q', '-u', REMOTE, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
  await recordSeen(dir, address, (await git(dir, ['rev-parse', 'HEAD'])).trim());
}

/** The sha of the `cob.json` blob at `rev`, or null when `rev` has none, or has one that is not a plain file. */
async function cobJsonBlob(dir: string, rev: string): Promise<string | null> {
  const out = await git(dir, ['ls-tree', '-z', rev, '--', 'cob.json']).catch(() => '');
  const m = /^(100644|100755) blob ([0-9a-f]+)\tcob\.json\0?$/.exec(out);
  return m ? m[2]! : null;
}

const NOT_A_DATA_REPO =
  'It is not a Company of Bots data repo (its main branch has no cob.json), so nothing was synced and nothing ' +
  'was changed. Check that this is the address of your private data repo, not of the app’s code.';
const UNREADABLE_COB_JSON = 'Its cob.json cannot be read, so it is not a data repo this app can open. Nothing was changed.';

/** Refuse `rev` unless it holds a `cob.json` of the format version this app reads (the rule `DataRepo` applies). */
async function assertDataRepoAt(dir: string, rev: string): Promise<void> {
  const blob = await cobJsonBlob(dir, rev);
  if (blob === null) throw new GitError(NOT_A_DATA_REPO);
  let parsed: unknown;
  try {
    const text = await git(dir, ['cat-file', 'blob', blob]);
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new GitError(UNREADABLE_COB_JSON);
  }
  const meta = RepoMetaSchema.safeParse(parsed);
  if (!meta.success) throw new GitError(UNREADABLE_COB_JSON);
  if (meta.data.schemaVersion !== SCHEMA_VERSION) {
    throw new GitError(
      `This data repo uses format version ${meta.data.schemaVersion}; this app supports version ${SCHEMA_VERSION}. ` +
        'Update the app. Nothing was changed.',
    );
  }
}

/** Undo a clone: remove the folder, or, when it was there (empty) before the call, only what the clone put in it. */
function removeClone(target: string, existed: boolean): void {
  if (!existed) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  for (const name of fs.readdirSync(target)) fs.rmSync(path.join(target, name), { recursive: true, force: true });
}

/**
 * Clone the user's data repo into `dir` (which must not exist or must be empty, as for `git clone`). A
 * repository whose `main` has no `cob.json`, or one of another format version, is refused (`GitError`): the
 * clone is removed, and a folder that was there before the call is left as it was. Nothing is pushed.
 */
export async function cloneDataRepo(remote: string, dir: string, identity: GitIdentity): Promise<void> {
  assertIdentity(identity);
  assertRemoteString(remote);
  await assertGitVersion();
  const target = path.resolve(dir);
  const existed = fs.existsSync(target);
  const config = BYTE_EXACT_CONFIG.flatMap(([key, value]) => ['--config', `${key}=${value}`]);
  await git(process.cwd(), ['clone', '-q', ...config, '--branch', BRANCH, '--', remote, target]);
  try {
    await assertTopLevel(target);
    await assertDataRepoAt(target, 'HEAD');
  } catch (err) {
    removeClone(target, existed);
    throw err;
  }
  await setIdentity(target, identity);
  const tip = (await git(target, ['rev-parse', '--verify', '-q', `refs/remotes/${REMOTE}/${BRANCH}`]).catch(() => '')).trim();
  if (tip) await recordSeen(target, await originAddress(target), tip);
}

// ---------------------------------------------------------------------------
// Serialising calls: an in-process queue per checkout, and a lock file across processes
// ---------------------------------------------------------------------------

/**
 * Process-wide state, shared by every copy of this module loaded in the process (a bundler duplicate, a hot
 * reload): the per-checkout queues, and the token of each lock file a call in this process holds right now.
 */
type SharedState = { queues: Map<string, Promise<unknown>>; held: Map<string, string> };
const SHARED_KEY = Symbol.for('company-of-bots.core.git.sync-state.v1');
const shared: SharedState = ((globalThis as Record<symbol, unknown>)[SHARED_KEY] as SharedState | undefined) ?? {
  queues: new Map(),
  held: new Map(),
};
(globalThis as Record<symbol, unknown>)[SHARED_KEY] = shared;
const queues = shared.queues;
const heldLocks = shared.held;

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(
    () => fn(),
    () => fn(),
  );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/** The lock file's text, or null when there is none. */
function readLock(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A lock (whose text is `text`) is stale when its holder process is gone or it is older than `maxAge`. A lock
 * written by this process is live exactly while some acquisition in this process (any copy of the module)
 * holds its token. Text that is not a lock yet (being written, or damaged) is stale once the file is 5 s old.
 */
function lockIsStale(file: string, text: string, maxAge = LOCK_STALE_MS): boolean {
  let info: { pid?: unknown; at?: unknown; token?: unknown };
  try {
    info = JSON.parse(text) as { pid?: unknown; at?: unknown; token?: unknown };
  } catch {
    try {
      return Date.now() - fs.statSync(file).mtimeMs > 5000;
    } catch {
      return true;
    }
  }
  if (typeof info.pid !== 'number' || typeof info.at !== 'number') return true;
  if (Date.now() - info.at > maxAge) return true;
  if (info.pid === process.pid) return typeof info.token !== 'string' || heldLocks.get(file) !== info.token;
  return !processAlive(info.pid);
}

/** Create `file` holding `text`, only if it does not exist (atomic). False when it exists. */
function createExclusive(file: string, text: string): boolean {
  try {
    fs.writeFileSync(file, text, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') return false;
    throw err;
  }
}

/** A takeover holds its guard for a few file operations; one older than this was left by a killed process. */
const GUARD_STALE_MS = 30 * 1000;

/**
 * Take over the stale lock whose text is `stale`, or throw `SyncBusyError`. Of the processes that find the same
 * stale lock at once, exactly one takes it over: only the one that creates the takeover guard (atomically) may
 * remove the lock, and it does so only while the lock still holds the text it judged stale.
 */
function takeOver(file: string, stale: string, mine: string): void {
  const guard = `${file}.takeover`;
  const guardText = JSON.stringify({ pid: process.pid, at: Date.now(), token: randomBytes(16).toString('hex') });
  if (!createExclusive(guard, guardText)) {
    // Another process is taking over right now. A guard left by a killed takeover is removed for the next call.
    const left = readLock(guard);
    if (left !== null && lockIsStale(guard, left, GUARD_STALE_MS) && readLock(guard) === left) fs.rmSync(guard, { force: true });
    throw new SyncBusyError();
  }
  try {
    if (readLock(file) !== stale) throw new SyncBusyError(); // taken over (and maybe released) by another process meanwhile
    fs.rmSync(file, { force: true });
    if (!createExclusive(file, mine)) throw new SyncBusyError(); // a newcomer created it in between: it holds it
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

/** INTERNAL (not exported from the package): run `fn` holding the cross-process lock of the git dir `gitDir`. */
export async function withLock<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(gitDir, 'cob-sync.lock');
  const token = randomBytes(16).toString('hex');
  const mine = JSON.stringify({ pid: process.pid, at: Date.now(), token });
  if (!createExclusive(file, mine)) {
    const found = readLock(file);
    if (found === null) {
      if (!createExclusive(file, mine)) throw new SyncBusyError(); // released just now, and taken by another
    } else {
      if (!lockIsStale(file, found)) throw new SyncBusyError();
      takeOver(file, found, mine);
    }
  }
  heldLocks.set(file, token);
  try {
    return await fn();
  } finally {
    if (heldLocks.get(file) === token) heldLocks.delete(file);
    try {
      const mine = (JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string }).token === token;
      if (mine) fs.rmSync(file, { force: true });
    } catch {
      // Already gone.
    }
  }
}

// ---------------------------------------------------------------------------
// Git operations the user started by hand
// ---------------------------------------------------------------------------

/** Untracked files that the repo's own .gitignore files do not ignore (byte strings). */
async function untrackedPaths(dir: string): Promise<string[]> {
  const out = await run(dir, ['ls-files', '-o', '-z', '--exclude-per-directory=.gitignore'], { latin1: true });
  return splitZ(out).filter((p) => !p.endsWith('/'));
}

/** The file or folder in the git dir that marks each operation, and how the user finishes it. */
const OPERATIONS: { mark: string; name: string; finish: string }[] = [
  { mark: 'rebase-merge', name: 'A rebase', finish: '`git rebase --continue` (after resolving any conflict) or `git rebase --abort`' },
  { mark: 'rebase-apply', name: 'A rebase', finish: '`git rebase --continue` (after resolving any conflict) or `git rebase --abort`' },
  { mark: 'MERGE_HEAD', name: 'A merge', finish: '`git merge --continue` (after resolving the conflict and `git add`) or `git merge --abort`' },
  { mark: 'CHERRY_PICK_HEAD', name: 'A cherry-pick', finish: '`git cherry-pick --continue` (after resolving the conflict) or `git cherry-pick --abort`' },
  { mark: 'REVERT_HEAD', name: 'A revert', finish: '`git revert --continue` (after resolving the conflict) or `git revert --abort`' },
  { mark: 'sequencer', name: 'A cherry-pick or revert', finish: '`git cherry-pick --continue` / `git revert --continue`, or `--abort`' },
];

/**
 * Sync never starts a rebase, merge, cherry-pick, revert or `am`, so one in progress is the user's own.
 * Clearing it automatically has always risked dropping some of the user's work, so it is refused: nothing
 * is fetched, committed or pushed, and the operation, HEAD, the index and every file stay as they are.
 */
async function assertNoOperation(dir: string): Promise<void> {
  const out = await git(dir, ['rev-parse', ...OPERATIONS.flatMap((o) => ['--git-path', o.mark])]);
  const marks = out.split('\n').filter(Boolean);
  for (let i = 0; i < OPERATIONS.length; i++) {
    const abs = path.resolve(dir, marks[i] ?? '');
    if (!marks[i] || !fs.existsSync(abs)) continue;
    let { name, finish } = OPERATIONS[i]!;
    if (OPERATIONS[i]!.mark === 'rebase-apply' && fs.existsSync(path.join(abs, 'applying'))) {
      name = 'A `git am`';
      finish = '`git am --continue` (after resolving the conflict), `git am --skip`, or `git am --abort`';
    }
    throw new GitError(
      `${name} started with git is still in progress in this data repo, so nothing was synced and nothing was changed. ` +
        `Finish it with ${finish}, then sync again.`,
    );
  }
  // A conflict with no operation behind it (`git stash pop`, `git checkout -m`): its markers must not be committed.
  const unmerged = [...new Set(splitZ(await run(dir, ['ls-files', '-u', '-z'], { latin1: true })).map((e) => e.replace(/^[^\t]*\t/, '')))];
  if (unmerged.length > 0) {
    throw new GitError(
      `Files in this data repo have unresolved conflicts (${unmerged.map(display).join(', ')}), left for example by ` +
        '`git stash pop` or `git checkout -m`, so nothing was synced and nothing was changed. Resolve each file and ' +
        '`git add` it (or `git checkout HEAD -- <file>` to drop the conflict), then sync again.',
    );
  }
}

// ---------------------------------------------------------------------------
// Guard: one call at a time, in the right repo, on the right branch
// ---------------------------------------------------------------------------

async function guarded<T>(dir: string, fn: (gitDir: string) => Promise<T>): Promise<T> {
  await assertGitVersion();
  let key: string;
  try {
    key = realPath(dir);
  } catch (err) {
    throw new GitError(`The data repo folder ${dir} cannot be opened (${(err as { code?: string }).code ?? 'error'}); nothing was synced.`);
  }
  return enqueue(key, async () => {
    await assertTopLevel(dir);
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
    return withLock(gitDir, async () => {
      await assertNoOperation(dir);
      const ref = await headRef(dir);
      if (ref !== `refs/heads/${BRANCH}`) {
        throw new GitError(
          `This data repo is not on the ${BRANCH} branch (${ref ?? 'detached HEAD'}); nothing was synced. Switch back to ${BRANCH}.`,
        );
      }
      // Every checkout core makes has cob.json from its first commit. Without one this is some other repository
      // (the app's code, say): syncing would put private records on it (F5).
      if ((await cobJsonBlob(dir, 'HEAD')) === null) throw new GitError(`${dir}: ${NOT_A_DATA_REPO}`);
      return fn(gitDir);
    });
  });
}

// ---------------------------------------------------------------------------
// Step 1: commit local changes
// ---------------------------------------------------------------------------

type Made = { sha: string };

/**
 * Stage tracked changes, plus untracked files the repo's own .gitignore does not ignore. Never added: the temp
 * files `DataRepo` writes before renaming (`<file>.tmp-<6 hex>`), and the operating system's own files
 * (`.DS_Store`, `Thumbs.db`, `desktop.ini`).
 */
async function stage(dir: string): Promise<void> {
  await git(dir, ['add', '-u']);
  const fresh = (await untrackedPaths(dir)).filter((p) => !isTmpArtifactName(p) && !isOsJunk(p));
  // update-index (not add) so that ambient excludes, which `git add` consults, cannot refuse a path.
  if (fresh.length > 0) await run(dir, ['update-index', '--add', '-z', '--stdin'], { input: pathInput(fresh) });
}

async function stageAndCommit(dir: string, message: string): Promise<Made | null> {
  let failed: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await stage(dir);
      failed = undefined;
      break;
    } catch (err) {
      failed = err; // a file vanished between listing and adding: look again
    }
  }
  if (failed) throw failed;
  const staged = parseRaw(await run(dir, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev'], { latin1: true }));
  if (staged.length === 0) return null;
  const blobs = staged.filter((e) => e.status !== 'D' && e.newMode !== '160000').map((e) => ({ path: e.path, sha: e.newSha }));
  const hits = secretPaths(dir, blobs);
  if (hits.length > 0) {
    await git(dir, ['reset', '-q']);
    throw new SecretLeakError(hits.map(display));
  }
  await git(dir, ['commit', '-q', '-m', message.trim() || 'sync']);
  return { sha: (await git(dir, ['rev-parse', 'HEAD'])).trim() };
}

// ---------------------------------------------------------------------------
// Steps 2-3: bring in the remote's commits; owner wins whole files
// ---------------------------------------------------------------------------

type Ent = { mode: string; sha: string } | null;

async function diffTree(dir: string, a: string, b: string): Promise<Map<string, Ent>> {
  const out = await run(dir, ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-abbrev', a, b], { latin1: true });
  const map = new Map<string, Ent>();
  for (const e of parseRaw(out)) map.set(e.path, e.newMode === '000000' ? null : { mode: e.newMode, sha: e.newSha });
  return map;
}

const sameEnt = (a: Ent, b: Ent): boolean => (a === null || b === null ? a === b : a.mode === b.mode && a.sha === b.sha);

const ZERO_SHA = '0'.repeat(40);

/** Paths that cannot both exist: a file and a folder of the same name. */
function fileFolderClashes(finalPaths: Set<string>, added: string[]): string[] {
  const folders = new Set<string>();
  for (const p of finalPaths) {
    let slash = p.lastIndexOf('/');
    while (slash > 0) {
      folders.add(p.slice(0, slash));
      slash = p.lastIndexOf('/', slash - 1);
    }
  }
  const clashes = new Set<string>();
  for (const p of added) {
    if (folders.has(p)) clashes.add(p);
    let slash = p.lastIndexOf('/');
    while (slash > 0) {
      const parent = p.slice(0, slash);
      if (finalPaths.has(parent)) {
        clashes.add(parent);
        clashes.add(p);
      }
      slash = p.lastIndexOf('/', slash - 1);
    }
  }
  return [...clashes];
}

/**
 * Replay commit `c` (made on top of `parent`) onto `tip`, path by path. A path changed on only one side takes
 * that side. A path changed on both sides, differently, goes whole to its owner. Returns the new tip, or null
 * when nothing of the commit is left.
 */
async function replayCommit(
  dir: string,
  gitDir: string,
  writer: Writer,
  c: string,
  parent: string,
  tip: string,
  resolved: Set<string>,
): Promise<string | null> {
  const theirs = await diffTree(dir, parent, c);
  if (theirs.size === 0) return null;
  const ours = await diffTree(dir, parent, tip);
  const updates = new Map<string, Ent>();
  for (const [file, mine] of theirs) {
    const upstream = ours.get(file);
    if (upstream === undefined) {
      updates.set(file, mine);
    } else if (!sameEnt(upstream, mine)) {
      resolved.add(file);
      updates.set(file, (ownerOfPath(display(file)) ?? 'app') === writer ? mine : upstream);
    }
  }
  if (updates.size === 0) return null;

  const index = path.join(gitDir, `cob-index-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await run(dir, ['read-tree', tip], { env });
    const finalPaths = new Set(splitZ(await run(dir, ['ls-files', '-z'], { env, latin1: true })));
    const added: string[] = [];
    for (const [file, ent] of updates) {
      if (ent === null) finalPaths.delete(file);
      else {
        finalPaths.add(file);
        added.push(file);
      }
    }
    const clashes = fileFolderClashes(finalPaths, added);
    if (clashes.length > 0) {
      throw new GitError(
        `A file and a folder have the same name (${clashes.map(display).join(', ')}), so the two sides cannot be merged. ` +
          'Nothing was pushed and your files are unchanged. Rename one of them and sync again.',
      );
    }
    const lines = [...updates].map(([file, ent]) => `${ent ? ent.mode : '0'} ${ent ? ent.sha : ZERO_SHA}\t${file}\0`).join('');
    await run(dir, ['update-index', '-z', '--index-info'], { env, input: Buffer.from(lines, 'latin1') });
    const tree = (await run(dir, ['write-tree'], { env })).trim();
    if (tree === (await git(dir, ['rev-parse', `${tip}^{tree}`])).trim()) return null;
    const raw = await git(dir, ['cat-file', 'commit', c]);
    const split = raw.indexOf('\n\n');
    const headers = split < 0 ? raw : raw.slice(0, split);
    const message = split < 0 ? '' : raw.slice(split + 2);
    const author = /^author (.*) <(.*)> (\d+ [+-]\d{4})$/m.exec(headers);
    const authorEnv: Record<string, string> = author
      ? { GIT_AUTHOR_NAME: author[1]!, GIT_AUTHOR_EMAIL: author[2]!, GIT_AUTHOR_DATE: author[3]! }
      : {};
    return (await run(dir, ['commit-tree', tree, '-p', tip, '-F', '-'], { input: message, env: authorEnv })).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

type Integration = 'done' | 'busy';

// --- Remote tips seen, per remote address ------------------------------------------------------------
//
// `refs/cob/seen/<hash of the address>` keeps every tip `origin/main` has had at that address reachable:
// it is the tip itself while the remote only moves forward, and a commit with the old record and the new
// tip as parents (on an empty tree) when the remote's history was rewritten. So a commit that was once on
// the remote is recognised even after the host drops it (R5), without relying on the reflog (R19); it is
// never garbage-collected (R20); and the record of one address says nothing about another (R15).
// These refs are never pushed: every push names `main` only.

const SEEN_PREFIX = 'refs/cob/seen/';
const SEEN_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'company-of-bots',
  GIT_AUTHOR_EMAIL: 'sync@company-of-bots.invalid',
  GIT_COMMITTER_NAME: 'company-of-bots',
  GIT_COMMITTER_EMAIL: 'sync@company-of-bots.invalid',
};

function seenRef(dir: string, address: string): string {
  return SEEN_PREFIX + createHash('sha256').update(repositoryKey(address, dir)).digest('hex').slice(0, 32);
}

/** `origin`'s address as configured (its first URL). Throws `GitError` if there is no `origin`. */
async function originAddress(dir: string): Promise<string> {
  const expanded = (await git(dir, ['remote', 'get-url', REMOTE])).trim();
  const raw = await git(dir, ['config', '--get-all', `remote.${REMOTE}.url`]).then(
    (s) => s.split('\n')[0]!.trim(),
    () => '',
  );
  return raw || expanded;
}

const SEEN_SUBJECT = 'cob: tips seen on origin/main';

/**
 * Every value the tracking ref has had that still exists, oldest first: the old and the new value of each
 * reflog entry (a plain clone logs nothing, so its starting tip shows only as the old value of the first
 * fetch after it), then the ref itself.
 */
async function trackingValues(dir: string): Promise<string[]> {
  const tracking = `refs/remotes/${REMOTE}/${BRANCH}`;
  const values: string[] = [];
  const logFile = path.resolve(dir, (await git(dir, ['rev-parse', '--git-path', `logs/${tracking}`])).trim());
  let text: string | null = null;
  try {
    text = fs.readFileSync(logFile, 'latin1');
  } catch {
    text = null;
  }
  if (text !== null) {
    for (const line of text.split('\n')) {
      const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) /.exec(line);
      if (m) values.push(m[1]!, m[2]!);
    }
  } else {
    // A ref store without log files: the new values are all git will show.
    const logged = await git(dir, ['reflog', 'show', '--no-abbrev', '--format=%H', tracking, '--']).catch(() => '');
    values.push(...logged.split('\n').filter((l) => /^[0-9a-f]{40,64}$/.test(l)).reverse());
  }
  const tip = await revOrNull(dir, tracking);
  if (tip !== null) values.push(tip);
  const unique = [...new Set(values.filter((v) => !/^0+$/.test(v)))];
  if (unique.length === 0) return [];
  const types = await run(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${unique.join('\n')}\n` });
  const commits = new Set(types.split('\n').filter((l) => l.endsWith(' commit')).map((l) => l.split(' ')[0]!));
  return unique.filter((v) => commits.has(v));
}

/** The real tips a record holds: the record itself, or the parents of the commits recordSeen made. */
async function recordTips(dir: string, record: string): Promise<string[]> {
  // `recordSeen` makes each of its commits with the old record as first parent and a real tip as second, so the
  // first-parent line from the record walks every one of them, and ends at the first real tip. One process.
  const out: string[] = [];
  const log = await git(dir, ['log', '--first-parent', '--format=%H%x00%P%x00%ae%x00%s', record]);
  for (const line of log.split('\n')) {
    const [c, parents, email, subject] = line.split('\0');
    if (!c) continue;
    if (email === SEEN_IDENTITY.GIT_AUTHOR_EMAIL && subject === SEEN_SUBJECT) {
      out.push(...(parents ?? '').split(' ').filter(Boolean).slice(1));
    } else {
      out.push(c);
      break;
    }
  }
  return [...new Set(out)];
}

/**
 * Tips that count as seen at `address` though the record does not hold them yet. Read-only: the caller
 * records them. Read before anything moves the tracking ref.
 * - No record for any repository (the user's own clone, older code, `refs/cob/` removed): every value the
 *   tracking ref has had (R23).
 * - A record for this repository: the values the user's own `git fetch` or `git pull` moved the tracking
 *   ref to, forward from a tip the record holds (R26). Every value is looked at, however many moves the
 *   user's git made since (no window, R50), in a fixed number of git processes: a no-op sync on a checkout with a
 *   long reflog costs what it costs on a young one.
 * - A record for another repository only: nothing; the tracking ref may hold that repository's history (R15).
 */
async function seedTips(dir: string, address: string): Promise<string[]> {
  const record = await revOrNull(dir, seenRef(dir, address));
  if (record === null) {
    if ((await git(dir, ['for-each-ref', '--count=1', '--format=%(refname)', SEEN_PREFIX])).trim()) return [];
    return trackingValues(dir);
  }
  const values = await trackingValues(dir);
  if (values.length === 0) return [];
  // The values the record does not hold yet: exactly those among the commits reachable from the values and not
  // from the record. After core's own fetches only, there are none, and this one walk is all a sync pays.
  const outside = new Set((await run(dir, ['rev-list', '--stdin'], { input: `${values.join('\n')}\n^${record}\n` })).split('\n'));
  const candidates = values.filter((v) => outside.has(v));
  if (candidates.length === 0) return [];
  // Of those, the ones forward from a tip the record holds: a known tip is among their ancestors. One walk of
  // their history, children before parents, then settled from the parents up.
  const known = new Set(await recordTips(dir, record));
  const walk = await run(dir, ['rev-list', '--topo-order', '--parents', '--stdin'], { input: `${candidates.join('\n')}\n` });
  const lines = walk.split('\n').filter(Boolean).reverse();
  const forward = new Set<string>();
  for (const line of lines) {
    const [c, ...parents] = line.split(' ');
    if (parents.some((q) => known.has(q) || forward.has(q))) forward.add(c!);
  }
  return candidates.filter((v) => forward.has(v));
}

async function revOrNull(dir: string, rev: string): Promise<string | null> {
  return git(dir, ['rev-parse', '--verify', '-q', rev]).then(
    (s) => s.trim() || null,
    () => null,
  );
}

/** Add `tip` to what this checkout has seen on `origin/main` at `address`. */
async function recordSeen(dir: string, address: string, tip: string): Promise<void> {
  const ref = seenRef(dir, address);
  const old = await revOrNull(dir, ref);
  if (old === null) {
    await git(dir, ['update-ref', ref, tip, ZERO_SHA]);
    return;
  }
  if (old === tip || (await isAncestor(dir, tip, old))) return;
  if (await isAncestor(dir, old, tip)) {
    await git(dir, ['update-ref', ref, tip, old]);
    return;
  }
  const emptyTree = (await run(dir, ['mktree'], { input: '' })).trim();
  const both = (
    await run(dir, ['commit-tree', emptyTree, '-p', old, '-p', tip, '-F', '-'], {
      input: `${SEEN_SUBJECT}\n`,
      env: SEEN_IDENTITY,
    })
  ).trim();
  await git(dir, ['update-ref', ref, both, old]);
}

/**
 * Make local main contain the remote's main. The remote's history wins for anything that was ever on it at
 * this address: only local commits never seen there are replayed, path by path, on top of the remote's tip;
 * commits that were on the remote once and are gone from it now (a rewrite on the git host) are dropped
 * from `main` (they stay reachable under the seen ref). The merge is built from git objects only; the
 * working tree is then moved with `reset --keep`. If the user changed (or deleted) a file the move would
 * touch, it returns 'busy' and changes nothing.
 */
async function integrate(
  dir: string,
  gitDir: string,
  writer: Writer,
  resolved: Set<string>,
  rewrites: Map<string, string | null>,
  remote: { address: string; tip: string },
): Promise<Integration> {
  const local = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const upstream = remote.tip;
  if (local === upstream) return 'done';
  const seen = await revOrNull(dir, seenRef(dir, remote.address));
  const tips = [upstream, ...(seen ? [seen] : [])];
  const listed = await run(dir, ['rev-list', '--reverse', '--first-parent', '--stdin'], {
    input: `${local}\n${tips.map((t) => `^${t}`).join('\n')}\n`,
  });
  let target = upstream;
  for (const c of listed.split('\n').filter(Boolean)) {
    const parent = await revOrNull(dir, `${c}^`);
    if (!parent) throw new GitError('This data repo and its remote have no history in common; nothing was synced.');
    if (parent === target) {
      target = c; // already on top: keep the commit as it is
      continue;
    }
    const next = await replayCommit(dir, gitDir, writer, c, parent, target, resolved);
    rewrites.set(c, next);
    if (next !== null) target = next;
  }
  if (target === local) return 'done';
  return moveTo(dir, local, target);
}

/** Paths that differ between two commits. */
async function changedBetween(dir: string, a: string, b: string): Promise<Set<string>> {
  return new Set((await diffTree(dir, a, b)).keys());
}

/** Paths whose file on disk or staged content differs from HEAD (including a deleted file). */
async function dirtyPaths(dir: string): Promise<Set<string>> {
  await git(dir, ['update-index', '-q', '--refresh']).catch(() => undefined); // same bytes rewritten: not a change
  const out = await run(dir, ['diff-index', '-z', '--name-only', '--no-renames', 'HEAD'], { latin1: true });
  return new Set(splitZ(out));
}

/**
 * An OS file (`.DS_Store`, `Thumbs.db`, `desktop.ini`) in the way of the move, untracked or changed, gives way to
 * the incoming version: sync never commits such a file, so waiting for it would stall every later sync (G1).
 * The OS makes a new one when it needs it.
 */
async function clearOsJunkInWay(dir: string, local: string, moving: Set<string>): Promise<void> {
  const junk = [...moving].filter(isOsJunk);
  if (junk.length === 0) return;
  const dirty = await dirtyPaths(dir);
  const untracked = new Set(await untrackedPaths(dir));
  const inWay = junk.filter((p) => dirty.has(p) || untracked.has(p));
  if (inWay.length === 0) return;
  const inHead = new Set(splitZ(await run(dir, ['ls-tree', '-r', '-z', '--name-only', local], { latin1: true })));
  const tracked = inWay.filter((p) => inHead.has(p));
  const loose = inWay.filter((p) => !inHead.has(p));
  if (tracked.length > 0) await run(dir, ['checkout', '-q', local, ...PATHSPEC_STDIN], { input: pathInput(tracked) });
  if (loose.length > 0) {
    const drop = loose.map((p) => `0 ${ZERO_SHA}\t${p}\0`).join(''); // out of the index if it was staged by hand
    await run(dir, ['update-index', '-z', '--index-info'], { input: Buffer.from(drop, 'latin1') });
    for (const p of loose) fs.rmSync(absPath(dir, p).toString(), { force: true });
  }
}

/** Move HEAD, the index and the files from `local` to `target`, unless that would touch a file the user changed. */
async function moveTo(dir: string, local: string, target: string): Promise<Integration> {
  const moving = await changedBetween(dir, local, target);
  await clearOsJunkInWay(dir, local, moving);
  for (const p of await dirtyPaths(dir)) if (moving.has(p)) return 'busy';
  for (let attempt = 0; ; attempt++) {
    try {
      await git(dir, ['reset', '-q', '--keep', target]);
      return 'done';
    } catch (err) {
      for (const p of await dirtyPaths(dir)) if (moving.has(p)) return 'busy';
      if ((await untrackedPaths(dir)).some((p) => moving.has(p))) return 'busy';
      if (attempt >= 1) throw err;
    }
  }
}

/** The commit we made, as it now stands in HEAD; null if it was dropped as empty. */
async function survivor(dir: string, made: Made, rewrites: Map<string, string | null>): Promise<string | null> {
  let sha: string | null = made.sha;
  for (let i = 0; i < 100 && sha !== null; i++) {
    if (await isAncestor(dir, sha, 'HEAD')) return sha;
    const next = rewrites.get(sha);
    sha = next === undefined ? null : next;
  }
  return null;
}

type Progress = {
  resolved: Set<string>;
  rewrites: Map<string, string | null>;
  made: Made[];
  /** Commits an accepted host rewind dropped from local `main` (each once), and the ref that keeps them. */
  dropped: Set<string>;
  keptUnder: string | null;
  /** The tip `restoreHost` pushed back to the host, if it did. */
  restoredTo: string | null;
};

const newProgress = (): Progress => ({ resolved: new Set(), rewrites: new Map(), made: [], dropped: new Set(), keptUnder: null, restoredTo: null });

const rewoundOf = (p: Progress): SyncResult['rewound'] =>
  p.dropped.size > 0 && p.keptUnder !== null ? { dropped: p.dropped.size, keptUnder: p.keptUnder } : null;

/**
 * How many commits on local `main` (HEAD) were once on `origin/main` at this address (the seen record holds
 * them) and are not in the remote's history now: what following the remote would drop. Read-only. Zero when
 * the remote holds HEAD, or when it only lacks commits never pushed (a host rewrite of commits this checkout
 * never had drops nothing here).
 */
async function droppedByRemote(dir: string, remote: { address: string; tip: string }): Promise<string[]> {
  const local = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  if (local === remote.tip) return [];
  const ahead = (await run(dir, ['rev-list', '--stdin'], { input: `${local}\n^${remote.tip}\n` })).split('\n').filter(Boolean);
  if (ahead.length === 0) return [];
  const seen = await revOrNull(dir, seenRef(dir, remote.address));
  if (seen === null) return [];
  const neverPushed = new Set(
    (await run(dir, ['rev-list', '--stdin'], { input: `${local}\n^${remote.tip}\n^${seen}\n` })).split('\n').filter(Boolean),
  );
  return ahead.filter((c) => !neverPushed.has(c));
}

/**
 * `restoreHost`: the host's rollback was a mistake. Push local `main` (HEAD, before any new local commit) back
 * as a fast-forward, after the secret guard, and record it. A host whose history was rewritten (its tip is not
 * an ancestor of local `main`) cannot be restored that way: `GitError`, and nothing changes.
 */
async function restoreHostTo(dir: string, remote: { address: string; tip: string }): Promise<string> {
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  if (!(await isAncestor(dir, remote.tip, head))) {
    throw new GitError(
      `The git host's ${BRANCH} branch was rewritten, not rolled back: its history is not an earlier point of this data ` +
        'repo, so it cannot be restored by a sync. Nothing was synced and nothing was changed. To follow the host ' +
        'instead, sync again accepting the rollback (acceptRewind).',
    );
  }
  assertUnpushedClean(dir, remote.tip);
  await git(dir, ['push', REMOTE, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
  await git(dir, ['update-ref', '-m', 'cob: restore host', `refs/remotes/${REMOTE}/${BRANCH}`, head]);
  await recordSeen(dir, remote.address, head);
  return head;
}

/** The remote after a fetch: its address, and its tip, or null when it has no `main` yet (a first push). */
type RemoteState = { address: string; tip: string | null };

/** The remote is not one this checkout can sync with (R15, R17). Nothing was changed. */
class RemoteRefused extends GitError {}

const NO_REMOTE_MAIN = /couldn't find remote ref/i;

/**
 * Fetch the remote's `main` without touching any ref, then check it before anything changes:
 * - no `main`, though this checkout has had one from this address: refused (R17);
 * - a `main` sharing no commit with local `main` (a different repository): refused (R15).
 * Only then is `origin/main` moved and the tip recorded as seen.
 */
async function fetchRemote(dir: string): Promise<RemoteState> {
  const address = await originAddress(dir);
  const seeds = await seedTips(dir, address);
  let tip: string | null;
  try {
    await git(dir, ['fetch', '-q', '--refmap=', REMOTE, `refs/heads/${BRANCH}`]);
    tip = (await git(dir, ['rev-parse', '--verify', '-q', 'FETCH_HEAD^{commit}'])).trim();
  } catch (err) {
    if (!(err instanceof GitError) || !NO_REMOTE_MAIN.test(err.stderr)) throw err;
    tip = null;
  }
  if (tip === null) {
    if (seeds.length > 0 || (await revOrNull(dir, seenRef(dir, address))) !== null) {
      // Keep what was counted, so the user's own `git fetch --prune` cannot erase it before the next sync (R23).
      for (const seed of seeds) await recordSeen(dir, address, seed);
      throw new RemoteRefused(
        `The remote's ${BRANCH} branch is gone (it was deleted, or the repo was recreated on the git host), so nothing ` +
          'was synced and nothing was pushed. Your data is still here. To upload it again, set up the remote again.',
      );
    }
    return { address, tip: null };
  }
  const base = await git(dir, ['merge-base', 'HEAD', tip]).then(
    (s) => s.trim(),
    () => '',
  );
  if (!base) {
    throw new RemoteRefused(
      `This data repo and the remote at ${redact(address)} have no history in common (is it the right repository?); ` +
        'nothing was synced and nothing was changed.',
    );
  }
  for (const seed of seeds) await recordSeen(dir, address, seed);
  await git(dir, ['update-ref', '-m', 'cob: fetch', `refs/remotes/${REMOTE}/${BRANCH}`, tip]);
  await recordSeen(dir, address, tip);
  return { address, tip };
}

/**
 * Fetch, commit what changed, and integrate; repeat if files kept changing under us. When the remote went back
 * so that local `main` would lose once-pushed commits, nothing is committed or moved: `HostRewoundError`, unless
 * `opts.acceptRewind`, in which case the remote is followed (R5) and the drop is counted in `p.rewound`.
 */
async function settle(
  dir: string,
  gitDir: string,
  writer: Writer,
  message: string,
  p: Progress,
  opts: SyncOptions,
): Promise<RemoteState> {
  const hooks = hooksOf(opts);
  if (opts.acceptRewind && opts.restoreHost) {
    throw new GitError('acceptRewind and restoreHost are two different answers to a host rollback; pass one of them.');
  }
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    let remote: RemoteState;
    try {
      remote = await fetchRemote(dir);
    } catch (err) {
      // An unreachable remote: local changes are still committed, so they are safe. A refused remote: nothing changes.
      if (cycle === 0 && !(err instanceof RemoteRefused)) {
        const made = await stageAndCommit(dir, message);
        if (made) p.made.push(made);
      }
      throw err;
    }
    if (remote.tip !== null) {
      const dropped = await droppedByRemote(dir, { address: remote.address, tip: remote.tip });
      if (dropped.length > 0) {
        const keptUnder = seenRef(dir, remote.address);
        if (opts.restoreHost) {
          p.restoredTo = await restoreHostTo(dir, { address: remote.address, tip: remote.tip });
          remote = { address: remote.address, tip: p.restoredTo };
        } else if (opts.acceptRewind) {
          for (const c of dropped) p.dropped.add(c);
          p.keptUnder = keptUnder;
        } else {
          throw new HostRewoundError(dropped.length, keptUnder);
        }
      }
    }
    const made = await stageAndCommit(dir, message);
    if (made) p.made.push(made);
    await hooks.beforeIntegrate?.();
    if (remote.tip === null) return remote; // nothing on the remote yet: nothing to bring in
    const r = await integrate(dir, gitDir, writer, p.resolved, p.rewrites, { address: remote.address, tip: remote.tip });
    if (r === 'done') return remote;
  }
  throw new GitError('Files in the data repo kept changing while syncing. Nothing was lost; try again.');
}

async function lastSurvivor(dir: string, p: Progress): Promise<string | null> {
  for (const made of [...p.made].reverse()) {
    const sha = await survivor(dir, made, p.rewrites);
    if (sha) return sha;
  }
  return null;
}

const sorted = (set: Set<string>) => [...set].map(display).sort();

/**
 * Commit local changes as `sync: local changes before pull`, then pull with owner-wins conflict resolution.
 * Never pushes. A host rewind is `HostRewoundError` unless `opts.acceptRewind` (see `syncRepo`).
 */
export async function pullRepo(dir: string, writer: Writer, opts: PullOptions = {}): Promise<SyncResult> {
  return guarded(dir, async (gitDir) => {
    const p = newProgress();
    const remote = await settle(dir, gitDir, writer, 'sync: local changes before pull', p, opts);
    // pullRepo pushes only to restore the host (`restoreHost`); `pushed` then says whether the host equals HEAD.
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const pushed = p.restoredTo !== null && remote.tip === head;
    return { committed: await lastSurvivor(dir, p), pushed, resolved: sorted(p.resolved), rewound: rewoundOf(p) };
  });
}

/** A push the remote refused because it moved. */
const NON_FAST_FORWARD = /\[rejected\]|fetch first/;
/**
 * A push that lost a race for the ref lock: the remote's ref moved between reading and locking ("is at <sha> but
 * expected <sha>"). Treated like a non-fast-forward: retried, then `pushed: false`.
 */
const LOCK_RACE = /is at [0-9a-f]{7,} but expected [0-9a-f]{7,}/;
/** Any other lock or ref-update failure (a lock file left by a crashed git on the host, say): retried, then `GitError`. */
const LOCK_FAILURE = /cannot lock ref|failed to update ref|failed to lock/;

/**
 * Commit local changes with `message`, pull with owner-wins conflict resolution, and push.
 * When the remote moves between pull and push (a non-fast-forward, or a lost race for the ref lock), pull and
 * push again, up to `maxAttempts` times; then give up with `pushed: false` (the commit stays local and goes out
 * on the next sync). Any other push failure is a `GitError`. A remote with no `main` gets a first push only if
 * this checkout never had `main` from that address (R2, R17).
 *
 * When the git host's `main` went back, so that local `main` would lose commits that were once on it (a restore,
 * a scrub by reset, a force-push), the call throws `HostRewoundError` and changes nothing (R53). Called again with
 * `acceptRewind: true`, it follows the remote: the dropped commits stay reachable under `refs/cob/seen/…`, and
 * `rewound` reports how many there were and that ref (R5, R20).
 */
export async function syncRepo(dir: string, writer: Writer, message: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_ATTEMPTS));
  const hooks = hooksOf(opts);
  return guarded(dir, async (gitDir) => {
    const p = newProgress();
    let pushed = false;
    let lockFailure: GitError | null = null;
    for (let attempt = 1; attempt <= maxAttempts && !pushed; attempt++) {
      const remote = await settle(dir, gitDir, writer, message, p, opts);
      const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      if (head === remote.tip) {
        pushed = true;
        break;
      }
      assertUnpushedClean(dir, remote.tip);
      await hooks.beforePush?.();
      try {
        await git(dir, ['push', ...(remote.tip === null ? ['-u'] : []), REMOTE, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
        pushed = true;
        await recordSeen(dir, remote.address, head);
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        if (NON_FAST_FORWARD.test(err.stderr) || LOCK_RACE.test(err.stderr)) lockFailure = null;
        else if (LOCK_FAILURE.test(err.stderr)) lockFailure = err;
        else throw err;
      }
    }
    if (!pushed && lockFailure) throw lockFailure;
    return { committed: await lastSurvivor(dir, p), pushed, resolved: sorted(p.resolved), rewound: rewoundOf(p) };
  });
}
