// Path layer of DataRepo. Internal: not exported from index.ts.
//
// Rules this module keeps:
// - A repo path is a repo-relative string with `/` separators. The store builds such strings itself
//   (`<kind dir>/<id>.json`, singleton paths) and never derives them from `path.relative`, so they
//   are the same on every OS. A caller-supplied path is held to the same contract.
// - Native paths (`\` on Windows) only exist after `resolveRepoPath`, and are only handed to node:fs.
// - Everything that depends on the OS takes a `PathApi` (`path.posix` or `path.win32`) and a `GuardFs`,
//   so tests can run the same code under Windows rules on any machine.
import fs from 'node:fs';
import nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { UnsafeNameError } from './ids.ts';

export type PathApi = nodePath.PlatformPath;

/** The few file-system questions the path guard asks. `null` means "there is nothing at that path". */
export type GuardFs = {
  lstat(p: string): { isSymbolicLink(): boolean; isDirectory(): boolean } | null;
  realpath(p: string): string | null;
};

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export const nodeGuardFs: GuardFs = {
  lstat(p) {
    try {
      return fs.lstatSync(p);
    } catch (e) {
      if (MISSING.has((e as NodeJS.ErrnoException).code ?? '')) return null;
      throw e;
    }
  },
  realpath(p) {
    try {
      return fs.realpathSync.native(p);
    } catch (e) {
      if (MISSING.has((e as NodeJS.ErrnoException).code ?? '')) return null;
      throw e;
    }
  },
};

export type PathOptions = {
  /** Allow the path to be an existing directory (for list and listBlobs). */
  allowExistingDirectory?: boolean;
  /** Allow the empty string, which names the repo root (for listBlobs and readBlob). */
  allowRepoRoot?: boolean;
};

function unsafe(relPath: string): UnsafeNameError {
  return new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
}

/** Only a name that ends in `.tmp-` plus six lower-case hex digits is a temp file this module wrote. */
export function isTmpArtifactName(name: string): boolean {
  return /\.tmp-[0-9a-f]{6}$/.test(name);
}

/** True when any segment names `.git`. Letter case and trailing dots or spaces (which Windows drops) are ignored. */
export function hasGitSegment(relPath: string): boolean {
  return relPath.split('/').some((part) => part.replace(/[. ]+$/, '').toLowerCase() === '.git');
}

/**
 * Lexical checks on a repo-relative path, before anything is resolved. They are the same on every OS,
 * so a path is judged the same way wherever it is read. Throws `UnsafeNameError`.
 */
export function assertRepoRelPath(api: PathApi, relPath: string, options: PathOptions = {}): void {
  if (relPath.includes('\\')) throw unsafe(relPath);
  if (relPath === '') {
    if (options.allowRepoRoot) return;
    throw unsafe(relPath);
  }
  if (relPath === '.' || relPath === './') throw unsafe(relPath);
  // Absolute (`/x`), UNC (`//host/share`) and drive forms (`C:x`, `C:/x`).
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) throw new UnsafeNameError(`path escapes repo: ${JSON.stringify(relPath)}`);
  // Under Windows rules a colon inside a name opens an alternate data stream.
  if (api.sep === '\\' && relPath.includes(':')) throw unsafe(relPath);
  if (hasGitSegment(relPath)) throw unsafe(relPath);
}

function escapes(api: PathApi, from: string, to: string): boolean {
  const rel = api.relative(from, to);
  return api.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${api.sep}`);
}

/**
 * Turn a repo-relative `/` path into a native absolute path, or throw `UnsafeNameError` when it
 * leaves the repo, or when the repo dir, a directory on the way, or the target is a symbolic link
 * (a dangling one included), or when it names an existing directory that is not allowed.
 */
export function resolveRepoPath(
  api: PathApi,
  probe: GuardFs,
  repoDir: string,
  relPath: string,
  options: PathOptions = {},
): string {
  assertRepoRelPath(api, relPath, options);
  const root = api.resolve(repoDir);
  const abs = api.resolve(root, relPath);
  if (escapes(api, root, abs)) throw new UnsafeNameError(`path escapes repo: ${JSON.stringify(relPath)}`);
  const below = api.relative(root, abs);
  if (below === '' && relPath !== '') throw unsafe(relPath); // `profile/..` and the like are not the root

  const rootReal = probe.realpath(root);
  if (rootReal === null) return abs; // the repo dir is not there yet: nothing can be linked
  // The repo dir itself may be reached through a link; only what is below it is checked.

  // Walk down from the repo dir, one segment at a time, without following links.
  let current = root;
  let anchor = root; // deepest path that exists
  const parts = below === '' ? [] : below.split(api.sep);
  for (let i = 0; i < parts.length; i++) {
    current = api.join(current, parts[i]!);
    const st = probe.lstat(current);
    if (st === null) break; // nothing below this point exists, so nothing below it can be a link
    if (st.isSymbolicLink()) throw new UnsafeNameError(`symbolic link in repo path: ${parts.slice(0, i + 1).join('/')}`);
    anchor = current;
    if (i === parts.length - 1 && st.isDirectory() && !options.allowExistingDirectory) {
      throw new UnsafeNameError(`path is a directory: ${JSON.stringify(relPath)}`);
    }
  }

  const anchorReal = probe.realpath(anchor);
  if (anchorReal === null || escapes(api, rootReal, anchorReal)) throw new UnsafeNameError('path escapes repo via symlink');
  return abs;
}

/** Check one directory entry found by `readdir` in an already checked directory. */
export function assertEntryIsPlainFile(probe: GuardFs, absFile: string, relPath: string): void {
  const st = probe.lstat(absFile);
  if (st === null) return;
  if (st.isSymbolicLink()) throw new UnsafeNameError(`symbolic link in repo path: ${relPath}`);
  if (st.isDirectory()) throw new UnsafeNameError(`path is a directory: ${JSON.stringify(relPath)}`);
}

/** The repo-relative path of a record, built by the store from its kind dir and id (both `/` strings). */
export function recordRelPath(kindDir: string, id: string): string {
  return `${kindDir}/${id}.json`;
}

/** Write through a temp file next to the target and rename it into place. A failed write leaves no temp file. */
export function atomicWrite(absPath: string, data: string | Uint8Array): void {
  const dir = nodePath.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = nodePath.join(dir, `${nodePath.basename(absPath)}.tmp-${randomBytes(3).toString('hex')}`);
  try {
    if (typeof data === 'string') fs.writeFileSync(tmp, data, 'utf8');
    else fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, absPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw e;
  }
}
