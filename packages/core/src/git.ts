import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDataLayout } from './init.ts';
import { ownerOfPath, type Writer } from './layout.ts';

export type GitIdentity = { name: string; email: string };

export type SyncResult = {
  /** Sha of the commit made from local changes, as it stands in HEAD's history; null if none survived. */
  committed: string | null;
  /** True when the remote branch equals local HEAD after the call. `pullRepo` never pushes and reports false. */
  pushed: boolean;
  /** Paths settled by the owner-wins rule, each once, sorted. */
  resolved: string[];
};

/** Options of `syncRepo` / `pullRepo`. `beforePush` and `beforeIntegrate` are internal and test-only. */
export type SyncOptions = {
  /** Pull-and-push attempts when the remote moves under us (default 3). */
  maxAttempts?: number;
  /** INTERNAL, TEST-ONLY: runs right before each push (the remote can be moved here). */
  beforePush?: () => Promise<void>;
  /** INTERNAL, TEST-ONLY: runs after the fetch, right before the pulled changes are applied. */
  beforeIntegrate?: () => Promise<void>;
};

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
  // The reflog of origin/main records every tip the remote had, so a rewrite on the host can be recognised (R5).
  '-c',
  'core.logAllRefUpdates=true',
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

/** Another process is syncing this checkout right now. Nothing was touched; try again shortly. */
export class SyncBusyError extends Error {
  constructor(message = 'Another sync is already running on this data repo. Try again in a moment.') {
    super(message);
    this.name = 'SyncBusyError';
  }
}

/** Hide credentials in URLs: everything between `://` and the last `@` before the host. */
function redact(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/g, '$1***@');
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

const SECRET_PATH = /(^|\/)(cookies?|secrets?)(\/|\.|$)|\.cookies?\.json$|storage-state|wake[-_]?token|(^|\/)\.env/i;
const NETSCAPE = '# Netscape HTTP Cookie File';

/** Finds the cookie needles in a stream of text pieces, including a needle split across two pieces. */
class NeedleMatcher {
  private tail = '';
  private netscape = false;
  private sameSite = false;
  private httpOnly = false;

  get hit(): boolean {
    return this.netscape || (this.sameSite && this.httpOnly);
  }

  scan(text: string): void {
    const s = this.tail + text;
    if (s.includes(NETSCAPE)) this.netscape = true;
    if (s.includes('"sameSite"')) this.sameSite = true;
    if (s.includes('"httpOnly"')) this.httpOnly = true;
    this.tail = s.slice(-(NETSCAPE.length - 1));
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
  const byName = new Set(blobs.filter((b) => SECRET_PATH.test(b.path)).map((b) => b.path));
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

function assertRemoteString(remote: string): void {
  if (remote.startsWith('-')) throw new GitError('That remote address is not valid: it starts with a dash.');
}

async function setIdentity(dir: string, identity: GitIdentity): Promise<void> {
  await git(dir, ['config', 'user.name', identity.name]);
  await git(dir, ['config', 'user.email', identity.email]);
}

/** A relative local path would be resolved against the repo once stored in its config; make it absolute. */
function absoluteIfLocal(remote: string): string {
  return fs.existsSync(path.resolve(remote)) ? path.resolve(remote) : remote;
}

async function assertTopLevel(dir: string): Promise<void> {
  const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  if (fs.realpathSync(top) !== fs.realpathSync(dir)) {
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

/** The relative paths `initDataLayout` writes. */
function layoutPaths(scratchParent: string): Set<string> {
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'cob-layout-'));
  try {
    initDataLayout(scratch);
    const out = new Set<string>();
    const walk = (rel: string) => {
      for (const name of fs.readdirSync(path.join(scratch, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        if (fs.statSync(path.join(scratch, r)).isDirectory()) walk(r);
        else out.add(r);
      }
    };
    walk('');
    return out;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

type InitTarget =
  | { kind: 'fresh' }
  | { kind: 'not-empty' }
  | { kind: 'foreign' }
  /** Ours, interrupted before the init commit: `leftovers` are layout files a killed call wrote. */
  | { kind: 'uncommitted'; gitDir: string; leftovers: string[] }
  /** Ours, with the init commit made; the first push may not have happened. */
  | { kind: 'committed'; gitDir: string; commit: string };

/** What is in `dir` already: nothing, a repo `initPrivateRepo` made (proven by its marker), or something else. */
async function inspectInitTarget(dir: string): Promise<InitTarget> {
  if (!fs.existsSync(dir)) return { kind: 'fresh' };
  const entries = fs.readdirSync(dir);
  if (!entries.includes('.git')) return { kind: entries.length === 0 ? 'fresh' : 'not-empty' };
  let isRepo = false;
  try {
    isRepo = fs.realpathSync((await git(dir, ['rev-parse', '--show-toplevel'])).trim()) === fs.realpathSync(dir);
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
    const layout = layoutPaths(gitDir);
    const present = splitZ(await run(dir, ['ls-files', '-o', '-z'], { latin1: true })).map(display);
    return present.every((p) => layout.has(p)) ? { kind: 'uncommitted', gitDir, leftovers: present } : { kind: 'not-empty' };
  }
  if (head === null) return { kind: 'foreign' };
  const roots = (await git(dir, ['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter(Boolean);
  return roots.length === 1 && roots[0] === marker.commit ? { kind: 'committed', gitDir, commit: marker.commit } : { kind: 'foreign' };
}

/** Make the init commit from the layout: the marker names it before `main` points at it. */
async function commitLayout(dir: string, gitDir: string): Promise<void> {
  initDataLayout(dir);
  await git(dir, ['add', '-A']);
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

/**
 * Create a private data repo in `dir` (created if missing): branch `main`, local identity, the starting
 * layout in one commit, and, when `remote` is given, `origin` with `main` pushed and tracked.
 * A repo this function created (proven by the marker it writes in the git dir) is resumed: a call that was
 * interrupted finishes the layout commit and the first push, even if more commits were made since.
 * A folder that is already a repository this function did not create is refused and left unchanged.
 */
export async function initPrivateRepo(dir: string, opts: { identity: GitIdentity; remote?: string }): Promise<void> {
  assertIdentity(opts.identity);
  if (opts.remote !== undefined) assertRemoteString(opts.remote);
  const remote = opts.remote === undefined ? undefined : absoluteIfLocal(opts.remote);

  const target = await inspectInitTarget(dir);
  if (target.kind === 'not-empty') throw new Error(`Cannot set up a data repo in ${dir}: the folder is not empty.`);
  if (target.kind === 'foreign') {
    throw new GitError(`${dir} is already a git repository that this app did not create; it was not changed.`);
  }

  // Fail before touching the folder, so a wrong address can be fixed and tried again.
  const remoteMain = remote === undefined ? '' : await remoteMainOf(process.cwd(), remote);
  if (remoteMain && target.kind !== 'committed') {
    throw new GitError(`The remote already has a ${BRANCH} branch; use an empty repo.`);
  }

  if (target.kind === 'fresh') {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeInitMarker(path.join(dir, '.git'), null);
    await git(dir, ['init', '-q', '-b', BRANCH]);
    await setIdentity(dir, opts.identity);
    await commitLayout(dir, (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim());
  } else if (target.kind === 'uncommitted') {
    for (const rel of target.leftovers) fs.rmSync(path.join(dir, rel), { force: true });
    for (const name of fs.readdirSync(dir)) {
      if (name !== '.git') fs.rmSync(path.join(dir, name), { recursive: true, force: true }); // empty layout folders only
    }
    await setIdentity(dir, opts.identity);
    await commitLayout(dir, target.gitDir);
  } else {
    await setIdentity(dir, opts.identity);
  }

  if (remote === undefined) return;
  const hasOrigin = await git(dir, ['remote', 'get-url', REMOTE]).then(
    () => true,
    () => false,
  );
  await git(dir, hasOrigin ? ['remote', 'set-url', REMOTE, remote] : ['remote', 'add', REMOTE, remote]);
  if (remoteMain) {
    // Resuming: done already if the remote holds our init commit; anything else is someone else's main.
    await git(dir, ['fetch', '-q', REMOTE, BRANCH]);
    const commit = target.kind === 'committed' ? target.commit : '';
    if (!(await isAncestor(dir, commit, `refs/remotes/${REMOTE}/${BRANCH}`))) {
      throw new GitError(`The remote already has a ${BRANCH} branch; use an empty repo.`);
    }
    await git(dir, ['branch', '-q', `--set-upstream-to=${REMOTE}/${BRANCH}`, BRANCH]);
    return;
  }
  assertUnpushedClean(dir, null);
  await git(dir, ['push', '-q', '-u', REMOTE, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
}

/** Clone the user's data repo into `dir` (which must not exist or must be empty, as for `git clone`). */
export async function cloneDataRepo(remote: string, dir: string, identity: GitIdentity): Promise<void> {
  assertIdentity(identity);
  assertRemoteString(remote);
  const target = path.resolve(dir);
  await git(process.cwd(), ['clone', '-q', '--branch', BRANCH, '--', remote, target]);
  await assertTopLevel(target);
  await setIdentity(target, identity);
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

/**
 * A lock is stale when its holder process is gone or it is older than 10 minutes. A lock written by this
 * process is live exactly while some acquisition in this process (any copy of the module) holds its token.
 */
function lockIsStale(file: string): boolean {
  let info: { pid?: unknown; at?: unknown; token?: unknown };
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown; at?: unknown; token?: unknown };
  } catch {
    // Being written right now, or unreadable: give a writer a moment, then call it stale.
    try {
      return Date.now() - fs.statSync(file).mtimeMs > 5000;
    } catch {
      return true;
    }
  }
  if (typeof info.pid !== 'number' || typeof info.at !== 'number') return true;
  if (Date.now() - info.at > LOCK_STALE_MS) return true;
  if (info.pid === process.pid) return typeof info.token !== 'string' || heldLocks.get(file) !== info.token;
  return !processAlive(info.pid);
}

async function withLock<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(gitDir, 'cob-sync.lock');
  const token = randomBytes(16).toString('hex');
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' });
      acquired = true;
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
      if (!lockIsStale(file)) throw new SyncBusyError();
      fs.rmSync(file, { force: true });
    }
  }
  if (!acquired) throw new SyncBusyError();
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
// Recovering a rebase that something else left behind
// ---------------------------------------------------------------------------

/** The folder of a rebase in progress (`rebase-merge` or `rebase-apply`), or null. */
async function rebaseStateDir(dir: string): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply']);
  for (const p of out.split('\n').filter(Boolean)) {
    const abs = path.resolve(dir, p);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** Untracked files that the repo's own .gitignore files do not ignore (byte strings). */
async function untrackedPaths(dir: string): Promise<string[]> {
  const out = await run(dir, ['ls-files', '-o', '-z', '--exclude-per-directory=.gitignore'], { latin1: true });
  return splitZ(out).filter((p) => !p.endsWith('/'));
}

/** `kind:sha` of a tree or index entry: `f` regular file, `l` symlink, `g` gitlink. */
type Key = string;
const NONE: Key = 'none';
const entKey = (mode: string, sha: string): Key => `${mode === '120000' ? 'l' : mode === '160000' ? 'g' : 'f'}:${sha}`;

async function treeKeys(dir: string, rev: string): Promise<Map<string, Key>> {
  const map = new Map<string, Key>();
  for (const entry of splitZ(await run(dir, ['ls-tree', '-r', '-z', '--full-tree', rev], { latin1: true }))) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(entry);
    if (m) map.set(m[3]!, entKey(m[1]!, m[2]!));
  }
  return map;
}

type IndexState = { stage0: Key | null; stages: Key[] };

async function indexKeys(dir: string): Promise<Map<string, IndexState>> {
  const map = new Map<string, IndexState>();
  for (const entry of splitZ(await run(dir, ['ls-files', '-s', '-z'], { latin1: true }))) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(entry);
    if (!m) continue;
    const st = map.get(m[4]!) ?? { stage0: null, stages: [] };
    if (m[3] === '0') st.stage0 = entKey(m[1]!, m[2]!);
    else st.stages.push(entKey(m[1]!, m[2]!));
    map.set(m[4]!, st);
  }
  return map;
}

/** The key of what is on disk at `rel`: a file's or symlink's blob id, `none`, or `dir` for a folder. */
async function worktreeKey(dir: string, rel: string, objectFormat: 'sha1' | 'sha256'): Promise<Key> {
  const abs = absPath(dir, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return NONE;
  }
  if (st.isDirectory()) return 'dir';
  const hash = createHash(objectFormat);
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(abs, { encoding: 'buffer' });
    hash.update(`blob ${target.length}\0`);
    hash.update(target);
    return `l:${hash.digest('hex')}`;
  }
  if (!st.isFile()) return 'other';
  hash.update(`blob ${st.size}\0`);
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      total += n;
    }
    if (total !== st.size) return 'changing';
  } finally {
    fs.closeSync(fd);
  }
  return `f:${hash.digest('hex')}`;
}

function readState(stateDir: string, name: string): string | null {
  try {
    return fs.readFileSync(path.join(stateDir, name), 'utf8').trim();
  } catch {
    return null;
  }
}

function recoveryRefused(why: string, paths: string[] = []): GitError {
  return new GitError(
    `A git rebase is in progress in this data repo and it could not be cleared safely, so nothing was synced and ` +
      `no file was changed: ${why}${paths.length ? ` (${paths.map(display).join(', ')})` : ''}. ` +
      'Finish it with `git rebase --continue`, or keep a copy of your edits and run `git rebase --abort`, then sync again.',
  );
}

/**
 * A sync never starts a rebase, but the user's own git (or a process killed by an older version) can leave
 * one behind. Clear it without losing an edit, and without `git rebase --abort`, which resets the files.
 *
 * The rebase wrote its own state to disk: the detached HEAD's files, and, after a conflict, the merge result
 * with conflict markers (git records that tree as `AUTO_MERGE`). A path whose file and staged content are one
 * of those versions, or the branch's own version, is untouched: it goes back to the branch's version. Any
 * other path holds the user's edit (a new or changed file, a resolved conflict, a deletion) and is left on
 * disk exactly as it is, so the next commit picks it up. The branch, which the rebase never moved, stays
 * where it was; HEAD goes back to it and the index is reset to it. If an edit cannot be kept this way
 * (staged content that differs from the file on disk, commits made during the rebase, a file and a folder
 * of the same name), nothing is changed and `GitError` explains why.
 */
async function recoverRebase(dir: string, gitDir: string): Promise<void> {
  const stateDir = await rebaseStateDir(dir);
  if (stateDir === null) return;
  const headName = readState(stateDir, 'head-name');
  const orig = readState(stateDir, 'orig-head');
  const onto = readState(stateDir, 'onto');
  if (headName !== `refs/heads/${BRANCH}`) throw recoveryRefused(`it is rebasing ${headName ?? 'an unknown branch'}, not ${BRANCH}`);
  const mainSha = (await git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]).catch(() => '')).trim();
  if (!orig || mainSha !== orig) throw recoveryRefused(`${BRANCH} has moved since the rebase started`);
  const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
  if (!head) throw recoveryRefused('HEAD is unreadable');

  // Commits made by hand on the detached HEAD would be dropped: refuse.
  const rewritten = [readState(stateDir, 'rewritten-list'), readState(stateDir, 'rewritten')]
    .flatMap((t) => (t ?? '').split('\n'))
    .flatMap((line) => line.trim().split(/\s+/))
    .filter((s) => /^[0-9a-f]{40,64}$/.test(s));
  const exclude = [orig, ...(onto ? [onto] : []), ...rewritten].map((s) => `^${s}`).join('\n');
  const extra = (await run(dir, ['rev-list', '--stdin'], { input: `${head}\n${exclude}\n` })).trim();
  if (extra) throw recoveryRefused('commits were made during the rebase that are not on any branch');

  const objectFormat = (await git(dir, ['rev-parse', '--show-object-format']).catch(() => 'sha1')).trim() === 'sha256' ? 'sha256' : 'sha1';
  const autoMerge = (await git(dir, ['rev-parse', '--verify', '-q', 'AUTO_MERGE']).catch(() => '')).trim();
  const O = await treeKeys(dir, orig);
  const H = await treeKeys(dir, head);
  const A = autoMerge ? await treeKeys(dir, autoMerge) : null;
  const index = await indexKeys(dir);
  const candidates = new Set<string>([...O.keys(), ...H.keys(), ...(A ? A.keys() : []), ...index.keys()]);
  const look = new Set<string>();
  for (const p of candidates) {
    const o = O.get(p) ?? NONE;
    const ix = index.get(p);
    if ((H.get(p) ?? NONE) !== o || (A && (A.get(p) ?? NONE) !== o) || !ix || ix.stages.length > 0 || ix.stage0 !== o) look.add(p);
  }
  for (const p of splitZ(await run(dir, ['diff-files', '--name-only', '-z'], { latin1: true }))) look.add(p);
  for (const p of await untrackedPaths(dir)) look.add(p);

  const keep: string[] = [];
  const restore: { rel: string; to: Key }[] = [];
  const unsafe: string[] = [];
  for (const p of [...look].sort()) {
    const o = O.get(p) ?? NONE;
    const ix = index.get(p);
    const known = new Set<Key>([o, H.get(p) ?? NONE, ...(A ? [A.get(p) ?? NONE] : []), ...(ix?.stages ?? [])]);
    if ([...known].some((k) => k.startsWith('g:'))) continue; // never touch a submodule entry
    let wt = await worktreeKey(dir, p, objectFormat);
    if (wt === 'dir') wt = NONE;
    if (wt === 'other' || wt === 'changing') {
      unsafe.push(p);
      continue;
    }
    const staged = ix === undefined ? NONE : ix.stages.length > 0 ? null : ix.stage0!;
    if (ix && ix.stages.length > 0 && !A && !known.has(wt)) {
      unsafe.push(p); // a conflict without AUTO_MERGE: the markers cannot be told apart from an edit
      continue;
    }
    const edited = !known.has(wt);
    if (staged !== null && staged !== wt && !known.has(staged)) {
      unsafe.push(p); // staged content that is not on disk would be lost
      continue;
    }
    if (edited) keep.push(p);
    else if (wt !== o) restore.push({ rel: p, to: o });
  }
  if (unsafe.length > 0) throw recoveryRefused('some changes exist only in the index, or files are changing', unsafe);
  const kept = new Set(keep);
  const clashes = restore
    .filter((r) => r.to !== NONE)
    .filter((r) => keep.some((k) => k.startsWith(`${r.rel}/`)) || ancestors(r.rel).some((a) => kept.has(a)))
    .map((r) => r.rel);
  if (clashes.length > 0) throw recoveryRefused('a file and a folder of the same name', clashes);

  // Put untouched paths back to the branch's version: removals first, then files from a scratch index.
  for (const r of restore.filter((x) => x.to === NONE)) {
    fs.rmSync(absPath(dir, r.rel), { force: true });
    for (const a of ancestors(r.rel).reverse()) {
      try {
        fs.rmdirSync(absPath(dir, a));
      } catch {
        break; // not empty, or gone
      }
    }
  }
  const back = restore.filter((x) => x.to !== NONE).map((x) => x.rel);
  if (back.length > 0) {
    for (const rel of back) {
      // The rebase's version goes; checkout-index then writes the branch's version (it never overwrites).
      try {
        if (fs.lstatSync(absPath(dir, rel)).isDirectory()) fs.rmdirSync(absPath(dir, rel));
        else fs.rmSync(absPath(dir, rel), { force: true });
      } catch {
        // absent, or a folder that is not empty (checkout-index then reports it)
      }
    }
    const scratchIndex = path.join(gitDir, `cob-index-${randomBytes(4).toString('hex')}`);
    try {
      await run(dir, ['read-tree', orig], { env: { GIT_INDEX_FILE: scratchIndex } });
      await run(dir, ['checkout-index', '-z', '--stdin'], { env: { GIT_INDEX_FILE: scratchIndex }, input: pathInput(back) });
    } finally {
      fs.rmSync(scratchIndex, { force: true });
    }
  }
  // Back on the branch, with the index at its commit; the files on disk are now the user's edits only.
  await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);
  await git(dir, ['read-tree', orig]);
  await git(dir, ['update-index', '-q', '--refresh']).catch(() => undefined);
  for (const name of ['REBASE_HEAD', 'AUTO_MERGE', 'MERGE_MSG']) fs.rmSync(path.join(gitDir, name), { force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
}

/** Parent folders of a path, nearest last: `a/b/c` gives `a`, `a/b`. */
function ancestors(rel: string): string[] {
  const out: string[] = [];
  let slash = rel.indexOf('/');
  while (slash > 0) {
    out.push(rel.slice(0, slash));
    slash = rel.indexOf('/', slash + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guard: one call at a time, in the right repo, on the right branch
// ---------------------------------------------------------------------------

async function guarded<T>(dir: string, fn: (gitDir: string) => Promise<T>): Promise<T> {
  let key: string;
  try {
    key = fs.realpathSync(dir);
  } catch (err) {
    throw new GitError(`The data repo folder ${dir} cannot be opened (${(err as { code?: string }).code ?? 'error'}); nothing was synced.`);
  }
  return enqueue(key, async () => {
    await assertTopLevel(dir);
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
    return withLock(gitDir, async () => {
      await recoverRebase(dir, gitDir);
      const ref = await headRef(dir);
      if (ref !== `refs/heads/${BRANCH}`) {
        throw new GitError(
          `This data repo is not on the ${BRANCH} branch (${ref ?? 'detached HEAD'}); nothing was synced. Switch back to ${BRANCH}.`,
        );
      }
      return fn(gitDir);
    });
  });
}

// ---------------------------------------------------------------------------
// Step 1: commit local changes
// ---------------------------------------------------------------------------

/** The temp name `DataRepo` writes before renaming: `<file>.tmp-<6 hex>`. Untracked ones are never added. */
const TEMP_FILE = /\.tmp-[0-9a-f]{6}$/;

type Made = { sha: string };

/** Stage tracked changes, plus untracked files the repo's own .gitignore does not ignore (and no in-flight temp files). */
async function stage(dir: string): Promise<void> {
  await git(dir, ['add', '-u']);
  const fresh = (await untrackedPaths(dir)).filter((p) => !TEMP_FILE.test(p));
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

/**
 * Every tip `origin/main` has had in this checkout: its reflog (every fetch and push records one), plus the
 * tip before and after this call's fetch. A commit reachable from any of them was on the remote once.
 */
async function knownRemoteTips(dir: string, before: string | null): Promise<string[]> {
  const ref = `refs/remotes/${REMOTE}/${BRANCH}`;
  const logged = await git(dir, ['reflog', 'show', '--no-abbrev', '--format=%H', ref, '--']).then(
    (s) => s.split('\n').filter((l) => /^[0-9a-f]{40,64}$/.test(l)),
    () => [] as string[],
  );
  const tips = new Set([...(before ? [before] : []), ...logged]);
  // Only commits that still exist can be excluded (old reflog entries may point at pruned objects).
  const exist = await run(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${[...tips].join('\n')}\n` });
  return exist
    .split('\n')
    .map((l) => l.split(' '))
    .filter(([, type]) => type === 'commit')
    .map(([sha]) => sha!);
}

/**
 * Make local main contain the remote's main. The remote's history wins for anything that was ever pushed:
 * only local commits never seen on `origin/main` are replayed, path by path, on top of the remote's tip;
 * commits that were on the remote once and are gone from it now (a history rewrite on the git host) are
 * dropped. The merge is built from git objects only; the working tree is then moved with `reset --keep`.
 * If the user changed (or deleted) a file the move would touch, it returns 'busy' and changes nothing.
 */
async function integrate(
  dir: string,
  gitDir: string,
  writer: Writer,
  resolved: Set<string>,
  rewrites: Map<string, string | null>,
  before: string | null,
): Promise<Integration> {
  const local = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const upstream = (await git(dir, ['rev-parse', `refs/remotes/${REMOTE}/${BRANCH}`])).trim();
  if (local === upstream) return 'done';
  const tips = [upstream, ...(await knownRemoteTips(dir, before))];
  const listed = await run(dir, ['rev-list', '--reverse', '--first-parent', '--stdin'], {
    input: `${local}\n${tips.map((t) => `^${t}`).join('\n')}\n`,
  });
  let target = upstream;
  for (const c of listed.split('\n').filter(Boolean)) {
    const parent = await git(dir, ['rev-parse', '--verify', '-q', `${c}^`]).then(
      (s) => s.trim(),
      () => '',
    );
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

/** Move HEAD, the index and the files from `local` to `target`, unless that would touch a file the user changed. */
async function moveTo(dir: string, local: string, target: string): Promise<Integration> {
  const moving = await changedBetween(dir, local, target);
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

type Progress = { resolved: Set<string>; rewrites: Map<string, string | null>; made: Made[] };

/** The remote's state after a fetch: its tip, or null when it has no `main` yet (nothing was ever pushed). */
type RemoteState = { tip: string | null };

const NO_REMOTE_MAIN = /couldn't find remote ref/i;

async function fetchRemote(dir: string): Promise<RemoteState> {
  try {
    await git(dir, ['fetch', '-q', REMOTE, BRANCH]);
  } catch (err) {
    if (err instanceof GitError && NO_REMOTE_MAIN.test(err.stderr)) return { tip: null };
    throw err;
  }
  return { tip: (await git(dir, ['rev-parse', `refs/remotes/${REMOTE}/${BRANCH}`])).trim() };
}

async function trackingTip(dir: string): Promise<string | null> {
  return git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/${REMOTE}/${BRANCH}`]).then(
    (s) => s.trim() || null,
    () => null,
  );
}

/** Commit what changed, fetch, and integrate; repeat if files kept changing under us. */
async function settle(
  dir: string,
  gitDir: string,
  writer: Writer,
  message: string,
  p: Progress,
  opts: SyncOptions,
): Promise<RemoteState> {
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    const made = await stageAndCommit(dir, message);
    if (made) p.made.push(made);
    const before = await trackingTip(dir);
    const remote = await fetchRemote(dir);
    await opts.beforeIntegrate?.();
    if (remote.tip === null) return remote; // nothing on the remote yet: nothing to bring in
    if ((await integrate(dir, gitDir, writer, p.resolved, p.rewrites, before)) === 'done') return remote;
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

/** Commit local changes as `sync: local changes before pull`, then pull with owner-wins conflict resolution. Never pushes. */
export async function pullRepo(dir: string, writer: Writer, opts: SyncOptions = {}): Promise<SyncResult> {
  return guarded(dir, async (gitDir) => {
    const p: Progress = { resolved: new Set(), rewrites: new Map(), made: [] };
    await settle(dir, gitDir, writer, 'sync: local changes before pull', p, opts);
    return { committed: await lastSurvivor(dir, p), pushed: false, resolved: sorted(p.resolved) };
  });
}

/** A push the remote refused because it moved. */
const NON_FAST_FORWARD = /\[rejected\]|fetch first/;
/** A push that lost a race for the ref lock; retried, but an error if it never goes through. */
const LOCK_RACE = /cannot lock ref|failed to update ref/;

/**
 * Commit local changes with `message`, pull with owner-wins conflict resolution, and push.
 * When the remote moves between pull and push, pull and push again, up to `maxAttempts` times;
 * then give up with `pushed: false` (the commit stays local and goes out on the next sync).
 * Any other push failure is a `GitError`. A remote with no `main` yet gets its first push.
 */
export async function syncRepo(dir: string, writer: Writer, message: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_ATTEMPTS));
  return guarded(dir, async (gitDir) => {
    const p: Progress = { resolved: new Set(), rewrites: new Map(), made: [] };
    let pushed = false;
    let lastRace: GitError | null = null;
    for (let attempt = 1; attempt <= maxAttempts && !pushed; attempt++) {
      const remote = await settle(dir, gitDir, writer, message, p, opts);
      const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      if (head === remote.tip) {
        pushed = true;
        break;
      }
      assertUnpushedClean(dir, remote.tip);
      await opts.beforePush?.();
      try {
        await git(dir, ['push', ...(remote.tip === null ? ['-u'] : []), REMOTE, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`]);
        pushed = true;
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        if (NON_FAST_FORWARD.test(err.stderr)) lastRace = null;
        else if (LOCK_RACE.test(err.stderr)) lastRace = err;
        else throw err;
      }
    }
    if (!pushed && lastRace) throw lastRace;
    return { committed: await lastSurvivor(dir, p), pushed, resolved: sorted(p.resolved) };
  });
}
