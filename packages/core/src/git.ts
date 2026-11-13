import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

const BRANCH = 'main';
const REMOTE = 'origin';
const MAX_ROUNDS = 50;
const DEFAULT_ATTEMPTS = 3;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;
/** Files larger than this are not scanned for cookie-shaped content (cookie files are small). */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Flags on every call so the user's own git config cannot change what we read or write. */
const BASE_FLAGS = ['-c', 'core.quotePath=false', '-c', 'commit.gpgsign=false'];
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

export class GitError extends Error {
  readonly stderr: string;
  readonly stdout: string;
  readonly args: string[];
  /** Process exit code, or null when git was killed or could not start. */
  readonly exitCode: number | null;

  constructor(message: string, details: { stderr?: string; stdout?: string; args?: string[]; exitCode?: number | null } = {}) {
    super(message);
    this.name = 'GitError';
    this.stderr = details.stderr ?? '';
    this.stdout = details.stdout ?? '';
    this.args = details.args ?? [];
    this.exitCode = details.exitCode ?? null;
  }
}

export class SecretLeakError extends Error {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(
      `Refusing to commit files that look like cookies or secrets: ${paths.join(', ')}. ` +
        'Move them out of the data repo, then sync again.',
    );
    this.name = 'SecretLeakError';
    this.paths = paths;
  }
}

/** Hide credentials in URLs (https://user:token@host/...) before they reach an error message. */
function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1***@');
}

function failure(args: string[], err: unknown): GitError {
  const e = err as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: string };
  const stderr = redact(String(e.stderr ?? ''));
  const stdout = redact(String(e.stdout ?? ''));
  const exitCode = typeof e.code === 'number' ? e.code : null;
  const detail = stderr.trim() || stdout.trim() || redact(e.message ?? 'unknown error');
  return new GitError(`git ${redact(args.join(' '))} failed: ${detail}`, { stderr, stdout, args: args.map(redact), exitCode });
}

function execOptions(cwd: string, env?: Record<string, string>) {
  return {
    cwd,
    env: { ...process.env, ...BASE_ENV, ...env },
    maxBuffer: MAX_BUFFER,
    timeout: COMMAND_TIMEOUT_MS,
  };
}

/** Run git in `dir`. Resolves with stdout; rejects with `GitError` carrying stderr. */
export function git(dir: string, args: string[], env?: Record<string, string>): Promise<string> {
  const full = [...BASE_FLAGS, ...args];
  return new Promise((resolve, reject) => {
    execFile('git', full, { ...execOptions(dir, env), encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(failure(args, Object.assign(err, { stdout, stderr })));
      else resolve(stdout);
    });
  });
}

function gitSyncBuffer(dir: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync('git', [...BASE_FLAGS, ...args], { ...execOptions(dir), input, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw failure(args, err);
  }
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Secret guard
// ---------------------------------------------------------------------------

const SECRET_PATH = /(^|\/)(cookies?|secrets?)(\/|\.|$)|\.cookies?\.json$|storage-state|wake[-_]?token|(^|\/)\.env/i;

function looksLikeCookies(content: string): boolean {
  return (
    content.includes('# Netscape HTTP Cookie File') || (content.includes('"sameSite"') && content.includes('"httpOnly"'))
  );
}

/** Staged (index) content of each path, for files small enough to scan. Paths absent from the index are skipped. */
function readStagedContent(dir: string, paths: string[]): Map<string, string> {
  const shaOf = new Map<string, string>();
  const listing = gitSyncBuffer(dir, ['ls-files', '-s', '-z', '--', ...paths]).toString('utf8');
  for (const entry of splitZ(listing)) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(entry);
    if (m && m[3] === '0' && m[1] !== '160000') shaOf.set(m[4]!, m[2]!);
  }
  const shas = [...new Set(shaOf.values())];
  const out = new Map<string, string>();
  if (shas.length === 0) return out;

  const sizes = new Map<string, number>();
  for (const line of gitSyncBuffer(dir, ['cat-file', '--batch-check'], `${shas.join('\n')}\n`).toString('utf8').split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (sha && type === 'blob' && size !== undefined) sizes.set(sha, Number(size));
  }
  const scan = shas.filter((s) => (sizes.get(s) ?? Infinity) <= MAX_SCAN_BYTES);
  if (scan.length === 0) return out;

  const batch = gitSyncBuffer(dir, ['cat-file', '--batch'], `${scan.join('\n')}\n`);
  const contentOf = new Map<string, string>();
  let pos = 0;
  while (pos < batch.length) {
    const nl = batch.indexOf(0x0a, pos);
    if (nl < 0) break;
    const [sha, , size] = batch.toString('latin1', pos, nl).split(' ');
    const n = Number(size);
    if (!sha || Number.isNaN(n)) {
      pos = nl + 1; // "<sha> missing"
      continue;
    }
    contentOf.set(sha, batch.toString('latin1', nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  for (const [p, sha] of shaOf) {
    const c = contentOf.get(sha);
    if (c !== undefined) out.set(p, c);
  }
  return out;
}

/**
 * Throw `SecretLeakError` if any staged path or its staged content looks like cookies or secrets.
 * The offending paths are unstaged first (`git reset -q -- <paths>`) and stay in the working tree.
 */
export function assertNoSecrets(dir: string, stagedPaths: string[]): void {
  const hits = new Set(stagedPaths.filter((p) => SECRET_PATH.test(p)));
  const rest = stagedPaths.filter((p) => !hits.has(p));
  if (rest.length > 0) {
    for (const [p, content] of readStagedContent(dir, rest)) {
      if (looksLikeCookies(content)) hits.add(p);
    }
  }
  if (hits.size === 0) return;
  const paths = stagedPaths.filter((p) => hits.has(p));
  gitSyncBuffer(dir, ['reset', '-q', '--', ...paths]);
  throw new SecretLeakError(paths);
}

// ---------------------------------------------------------------------------
// Init and clone
// ---------------------------------------------------------------------------

function assertIdentity(identity: GitIdentity): void {
  if (!identity.name.trim() || !identity.email.trim()) {
    throw new Error('A git name and email are needed to save changes to your data repo.');
  }
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
 * Create a private data repo in `dir` (created if missing): branch `main`, local identity, the starting
 * layout in one commit, and, when `remote` is given, `origin` with `main` pushed and tracked.
 */
export async function initPrivateRepo(dir: string, opts: { identity: GitIdentity; remote?: string }): Promise<void> {
  assertIdentity(opts.identity);
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name !== '.git')) {
    throw new Error(`Cannot set up a data repo in ${dir}: the folder is not empty.`);
  }
  const remote = opts.remote === undefined ? undefined : absoluteIfLocal(opts.remote);
  if (remote !== undefined) {
    // Fail before touching the folder, so a wrong address can be fixed and tried again.
    const heads = await git(process.cwd(), ['ls-remote', '--heads', remote, `refs/heads/${BRANCH}`]);
    if (heads.trim()) throw new GitError(`The remote already has a ${BRANCH} branch; use an empty repo.`, { args: ['ls-remote'] });
  }

  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', BRANCH]);
  await setIdentity(dir, opts.identity);
  initDataLayout(dir);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'Initialize private data repo']);
  if (remote !== undefined) {
    await git(dir, ['remote', 'add', REMOTE, remote]);
    await git(dir, ['push', '-q', '-u', REMOTE, BRANCH]);
  }
}

/** Clone the user's data repo into `dir` (which must not exist or must be empty, as for `git clone`). */
export async function cloneDataRepo(remote: string, dir: string, identity: GitIdentity): Promise<void> {
  assertIdentity(identity);
  const target = path.resolve(dir);
  await git(process.cwd(), ['clone', '-q', '--branch', BRANCH, '--', remote, target]);
  await setIdentity(target, identity);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function rebaseInProgress(dir: string): Promise<boolean> {
  const out = await git(dir, ['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply']);
  return out
    .split('\n')
    .filter(Boolean)
    .some((p) => fs.existsSync(path.resolve(dir, p)));
}

/**
 * Run `fn` and guarantee no exit path leaves a rebase in progress, including one left by a crashed earlier run.
 * Aborting restores every local commit, so nothing is lost.
 */
async function guarded<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  if (await rebaseInProgress(dir)) await git(dir, ['rebase', '--abort']);
  let failed = false;
  try {
    return await fn();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (await rebaseInProgress(dir)) {
      try {
        await git(dir, ['rebase', '--abort']);
      } catch (abortErr) {
        if (!failed) throw abortErr;
      }
    }
  }
}

type Made = { sha: string; stamp: string };

async function stampOf(dir: string, rev: string): Promise<string> {
  return git(dir, ['show', '-s', '--format=%at%x00%B', rev]);
}

/** Step 1: stage everything, refuse secrets, commit if anything is staged. */
async function stageAndCommit(dir: string, message: string): Promise<Made | null> {
  await git(dir, ['add', '-A']);
  const staged = splitZ(await git(dir, ['diff', '--cached', '--name-only', '-z', '--no-renames']));
  if (staged.length === 0) return null;
  try {
    assertNoSecrets(dir, staged);
  } catch (err) {
    if (err instanceof SecretLeakError) await git(dir, ['reset', '-q']);
    throw err;
  }
  await git(dir, ['commit', '-q', '-m', message.trim() || 'sync']);
  const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  return { sha, stamp: await stampOf(dir, 'HEAD') };
}

/** The commit we made, as it now stands in HEAD. A rebase rewrites its sha; an emptied commit is gone. */
async function survivor(dir: string, made: Made | null): Promise<string | null> {
  if (made === null) return null;
  try {
    await git(dir, ['merge-base', '--is-ancestor', made.sha, 'HEAD']);
    return made.sha;
  } catch (err) {
    if (!(err instanceof GitError) || err.exitCode !== 1) throw err;
  }
  // Rebased commits keep author time and message, and ours is always replayed last, so it would be HEAD.
  if ((await stampOf(dir, 'HEAD')) !== made.stamp) return null;
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

async function unmerged(dir: string): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  for (const entry of splitZ(await git(dir, ['ls-files', '-u', '-z']))) {
    const m = /^\d+ [0-9a-f]+ (\d)\t([\s\S]*)$/.exec(entry);
    if (!m) throw new GitError(`unexpected conflict entry: ${JSON.stringify(entry)}`);
    const stages = out.get(m[2]!) ?? new Set<number>();
    stages.add(Number(m[1]));
    out.set(m[2]!, stages);
  }
  return out;
}

/** Settle each conflicted path by who owns it. During a rebase, stage 2 is upstream and stage 3 is our commit. */
async function resolveConflicts(dir: string, writer: Writer, resolved: Set<string>): Promise<void> {
  for (const [file, stages] of await unmerged(dir)) {
    const owner = ownerOfPath(file) ?? 'app';
    const stage = owner === writer ? 3 : 2;
    if (stages.has(stage)) {
      await git(dir, ['checkout', stage === 3 ? '--theirs' : '--ours', '--', file]);
      await git(dir, ['add', '--', file]);
    } else {
      // The owner's side deleted the file.
      await git(dir, ['rm', '-q', '--', file]);
    }
    resolved.add(file);
  }
}

async function indexMatchesHead(dir: string): Promise<boolean> {
  try {
    await git(dir, ['diff', '--cached', '--quiet']);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return false;
    throw err;
  }
}

/** Run a rebase step. It may legitimately stop again on the next commit's conflict; anything else is an error. */
async function rebaseStep(dir: string, args: string[]): Promise<void> {
  try {
    await git(dir, args, { GIT_EDITOR: 'true' });
  } catch (err) {
    if (err instanceof GitError && (await rebaseInProgress(dir)) && (await unmerged(dir)).size > 0) return;
    throw err;
  }
}

/** Steps 2–3: pull with rebase, then settle conflicts commit by commit until the rebase is done. */
async function pullAndResolve(dir: string, writer: Writer, resolved: Set<string>): Promise<void> {
  try {
    await git(dir, ['pull', '--rebase', '--no-autostash', REMOTE, BRANCH]);
  } catch (err) {
    if (!(await rebaseInProgress(dir))) throw err;
  }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!(await rebaseInProgress(dir))) return;
    await resolveConflicts(dir, writer, resolved);
    if (await indexMatchesHead(dir)) {
      await rebaseStep(dir, ['rebase', '--skip']);
      continue;
    }
    try {
      await rebaseStep(dir, ['rebase', '--continue']);
    } catch (err) {
      if (err instanceof GitError && /nothing to commit|no changes/i.test(`${err.stdout}\n${err.stderr}`)) {
        await rebaseStep(dir, ['rebase', '--skip']);
      } else {
        throw err;
      }
    }
  }
  if (await rebaseInProgress(dir)) {
    throw new GitError(`Could not settle the conflicts after ${MAX_ROUNDS} rounds; the sync was undone.`);
  }
}

async function remoteEqualsHead(dir: string): Promise<boolean> {
  const [head, remote] = (await git(dir, ['rev-parse', 'HEAD', `refs/remotes/${REMOTE}/${BRANCH}`])).trim().split('\n');
  return head === remote;
}

/**
 * A push the remote refused because it moved: `[rejected]` / `fetch first` when it moved before the push
 * began, or a lock failure when another push landed while ours was in flight.
 */
const RACE = /\[rejected\]|fetch first|cannot lock ref|failed to update ref/;

const sorted = (set: Set<string>) => [...set].sort();

/** Commit local changes as `sync: local changes before pull`, then pull with owner-wins conflict resolution. Never pushes. */
export async function pullRepo(dir: string, writer: Writer): Promise<SyncResult> {
  return guarded(dir, async () => {
    const made = await stageAndCommit(dir, 'sync: local changes before pull');
    const resolved = new Set<string>();
    await pullAndResolve(dir, writer, resolved);
    return { committed: await survivor(dir, made), pushed: false, resolved: sorted(resolved) };
  });
}

/**
 * Commit local changes with `message`, pull with owner-wins conflict resolution, and push.
 * When the remote moves between pull and push, pull and push again, up to `maxAttempts` times;
 * then give up with `pushed: false` (the commit stays local and goes out on the next sync).
 */
export async function syncRepo(
  dir: string,
  writer: Writer,
  message: string,
  opts: { maxAttempts?: number } = {},
): Promise<SyncResult> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_ATTEMPTS));
  return guarded(dir, async () => {
    const made = await stageAndCommit(dir, message);
    const resolved = new Set<string>();
    let pushed = false;
    for (let attempt = 1; attempt <= maxAttempts && !pushed; attempt++) {
      await pullAndResolve(dir, writer, resolved);
      if (await remoteEqualsHead(dir)) {
        pushed = true;
        break;
      }
      try {
        await git(dir, ['push', REMOTE, BRANCH]);
        pushed = true;
      } catch (err) {
        if (!(err instanceof GitError) || !RACE.test(err.stderr)) throw err;
      }
    }
    return { committed: await survivor(dir, made), pushed, resolved: sorted(resolved) };
  });
}
