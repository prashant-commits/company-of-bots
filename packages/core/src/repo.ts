import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSafeId, UnsafeNameError } from './ids.ts';
import { KINDS, SINGLETONS, type KindName, type KindType, type SingletonName, type SingletonType, type Writer } from './layout.ts';
import { RepoMetaSchema, SCHEMA_VERSION } from './schema.ts';
import type { DayLog, Transcript } from './schema.ts';

export type RepoReadError = { file: string; error: string };

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

function recordFileId(kind: KindName, record: KindType<KindName>): string {
  if (kind === 'transcript') return (record as Transcript).interviewId;
  if (kind === 'dayLog') return (record as DayLog).day;
  return (record as { id: string }).id;
}

function kindFilePath(dir: string, kind: KindName, id: string): string {
  const entry = KINDS[kind];
  return path.join(dir, entry.dir, `${id}.json`);
}

function relFromRepo(repoDir: string, abs: string): string {
  return path.relative(repoDir, abs).split(path.sep).join('/');
}

function hasGitSegment(relPath: string): boolean {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .some((part) => part.toLowerCase() === '.git');
}

function isTmpArtifactName(name: string): boolean {
  return /\.tmp-[0-9a-f]{6}$/.test(name);
}

function assertNoBackslash(relPath: string): void {
  if (relPath.includes('\\')) {
    throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
  }
}

type PathOptions = {
  /** Allow resolving to an existing directory (for list/listBlobs). */
  allowExistingDirectory?: boolean;
  /** Allow resolving exactly to the repo root (for listBlobs on ''). */
  allowRepoRoot?: boolean;
};

function assertSafeRepoPath(repoDir: string, relPath: string, options: PathOptions = {}): string {
  assertNoBackslash(relPath);
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized === '' || normalized === '.' || normalized === './') {
    if (options.allowRepoRoot && normalized === '') {
      const root = path.resolve(repoDir);
      assertPathNoSymlinkEscape(repoDir, root);
      return root;
    }
    throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
  }

  if (hasGitSegment(normalized)) {
    throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
  }

  const abs = path.resolve(repoDir, relPath);
  const root = path.resolve(repoDir);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new UnsafeNameError(`path escapes repo: ${JSON.stringify(relPath)}`);
  }

  if (abs === root && !options.allowRepoRoot) {
    throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
  }

  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs);
    if (stat.isDirectory() && !options.allowExistingDirectory) {
      throw new UnsafeNameError(`path is a directory: ${JSON.stringify(relPath)}`);
    }
  }

  assertPathNoSymlinkEscape(repoDir, abs);
  return abs;
}

function assertPathNoSymlinkEscape(repoDir: string, absPath: string): void {
  const root = path.resolve(repoDir);
  if (!fs.existsSync(root)) {
    return;
  }
  const rootReal = fs.realpathSync.native(root);

  let current = root;
  const rel = path.relative(root, absPath);
  if (rel !== '' && rel !== '.') {
    for (const part of rel.split(path.sep)) {
      if (!part || part === '.') continue;
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new UnsafeNameError(`symbolic link in repo path: ${relFromRepo(repoDir, current)}`);
        }
      } catch (e) {
        if (e instanceof UnsafeNameError) throw e;
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw e;
      }
    }
  }

  let anchor = absPath;
  while (!fs.existsSync(anchor)) {
    if (anchor === root) break;
    anchor = path.dirname(anchor);
  }
  if (!fs.existsSync(anchor)) {
    return;
  }
  try {
    const anchorReal = fs.realpathSync.native(anchor);
    if (anchorReal !== rootReal && !anchorReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new UnsafeNameError(`path escapes repo via symlink`);
    }
  } catch (e) {
    if (e instanceof UnsafeNameError) throw e;
    try {
      if (fs.lstatSync(anchor).isSymbolicLink()) {
        throw new UnsafeNameError(`symbolic link in repo path: ${relFromRepo(repoDir, anchor)}`);
      }
    } catch (inner) {
      if (inner instanceof UnsafeNameError) throw inner;
    }
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new UnsafeNameError(`symbolic link in repo path: ${relFromRepo(repoDir, absPath)}`);
    }
    throw e;
  }
}

const BLOB_RESUME = /^profile\/resumes\/([^/]+)$/;
const BLOB_RESUME_TEXT = /^profile\/resume-text\/([^/]+)$/;

function assertBlobWriteDeletePath(relPath: string, writer: Writer): string {
  assertNoBackslash(relPath);
  const p = relPath.replace(/\\/g, '/');
  const match = BLOB_RESUME.exec(p) ?? BLOB_RESUME_TEXT.exec(p);
  const name = match?.[1];
  if (!name || name === '.' || name === '..') {
    throw new OwnershipError(`blob path not allowed: ${JSON.stringify(relPath)}`);
  }
  if (writer !== 'app') {
    throw new OwnershipError(`only the app may write resume blobs`);
  }
  return p;
}

function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function recordStemMatches(kind: KindName, filePath: string, record: KindType<KindName>): boolean {
  const stem = path.basename(filePath, '.json');
  return stem === recordFileId(kind, record);
}

/** Parse JSON text from disk, ignoring a leading UTF-8 BOM if present. */
function parseJsonUtf8(raw: string): unknown {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(text);
}

function atomicWrite(absPath: string, data: string | Uint8Array): void {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(absPath)}.tmp-${randomBytes(3).toString('hex')}`);
  try {
    if (typeof data === 'string') fs.writeFileSync(tmp, data, 'utf8');
    else fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, absPath);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw e;
  }
}

function readCobJsonMeta(dir: string): void {
  const metaPath = path.join(dir, 'cob.json');
  if (!fs.existsSync(metaPath)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, 'utf8');
  } catch {
    throw new UnsupportedSchemaError('This data repo could not be read.');
  }

  let parsed: unknown;
  try {
    parsed = parseJsonUtf8(raw);
  } catch {
    throw new UnsupportedSchemaError('This data repo could not be read.');
  }

  if (typeof parsed === 'object' && parsed !== null && 'schemaVersion' in parsed) {
    const version = (parsed as { schemaVersion: unknown }).schemaVersion;
    if (typeof version === 'number' && version !== SCHEMA_VERSION) {
      throw new UnsupportedSchemaError(
        `This data repo uses format version ${version}; this app supports version 1. Update the app.`,
      );
    }
  }

  const meta = RepoMetaSchema.safeParse(parsed);
  if (!meta.success) {
    throw new UnsupportedSchemaError('This data repo could not be read.');
  }
  if (meta.data.schemaVersion !== SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(
      `This data repo uses format version ${meta.data.schemaVersion}; this app supports version 1. Update the app.`,
    );
  }
}

export class DataRepo {
  readonly dir: string;
  readonly writer: Writer;

  constructor(dir: string, writer: Writer) {
    this.dir = dir;
    this.writer = writer;
    readCobJsonMeta(dir);
  }

  get<K extends KindName>(kind: K, id: string): KindType<K> | null {
    assertSafeId(id);
    const file = kindFilePath(this.dir, kind, id);
    const lst = lstatOrNull(file);
    if (lst === null) return null;
    assertSafeRepoPath(this.dir, path.relative(this.dir, file));
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonUtf8(raw);
    } catch (e) {
      throw new Error(`invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const result = KINDS[kind].schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`schema validation failed for ${file}`);
    }
    if (!recordStemMatches(kind, file, result.data as KindType<KindName>)) {
      throw new Error(`record id does not match file name for ${file}`);
    }
    return result.data as KindType<K>;
  }

  list<K extends KindName>(kind: K): { items: KindType<K>[]; errors: RepoReadError[] } {
    const entry = KINDS[kind];
    const kindDir = path.join(this.dir, entry.dir);
    const items: KindType<K>[] = [];
    const errors: RepoReadError[] = [];
    if (!fs.existsSync(kindDir)) return { items, errors };

    try {
      assertSafeRepoPath(this.dir, entry.dir, { allowExistingDirectory: true });
    } catch (e) {
      errors.push({
        file: kindDir,
        error: e instanceof Error ? e.message : String(e),
      });
      return { items, errors };
    }

    for (const name of fs.readdirSync(kindDir)) {
      if (!name.endsWith('.json') || isTmpArtifactName(name)) continue;
      const file = path.join(kindDir, name);
      try {
        assertSafeRepoPath(this.dir, path.relative(this.dir, file));
      } catch (e) {
        errors.push({ file, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (e) {
        errors.push({ file, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseJsonUtf8(raw);
      } catch (e) {
        errors.push({ file, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const result = entry.schema.safeParse(parsed);
      if (!result.success) {
        errors.push({ file, error: result.error.message });
        continue;
      }
      if (!recordStemMatches(kind, file, result.data as KindType<KindName>)) {
        errors.push({ file, error: `record id does not match file name` });
        continue;
      }
      items.push(result.data as KindType<K>);
    }
    items.sort((a, b) => {
      const aid = recordFileId(kind, a as KindType<KindName>);
      const bid = recordFileId(kind, b as KindType<KindName>);
      return aid < bid ? -1 : aid > bid ? 1 : 0;
    });
    return { items, errors };
  }

  private assertCanWrite(kind: KindName, id: string): void {
    const entry = KINDS[kind];
    const file = kindFilePath(this.dir, kind, id);
    const exists = fs.existsSync(file);

    if (entry.owner === 'command') {
      if (this.writer === 'app') {
        if (exists) throw new OwnershipError(`app may not update command ${id}`);
      } else if (this.writer === 'agent') {
        if (!exists) throw new OwnershipError(`agent may not create command ${id}`);
      }
      return;
    }

    const owner = entry.owner;
    if (this.writer !== owner) {
      throw new OwnershipError(`${this.writer} may not write ${kind} owned by ${owner}`);
    }
  }

  put<K extends KindName>(kind: K, record: KindType<K>): void {
    const parsed = KINDS[kind].schema.safeParse(record);
    if (!parsed.success) throw parsed.error;
    const id = recordFileId(kind, record);
    assertSafeId(id);
    this.assertCanWrite(kind, id);

    const file = kindFilePath(this.dir, kind, id);
    assertSafeRepoPath(this.dir, path.relative(this.dir, file));
    const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
    atomicWrite(file, body);
  }

  delete<K extends KindName>(kind: K, id: string): void {
    assertSafeId(id);
    if (kind === 'command') throw new OwnershipError('commands may not be deleted');
    const entry = KINDS[kind];
    if (this.writer !== entry.owner) {
      throw new OwnershipError(`${this.writer} may not delete ${kind}`);
    }
    const file = kindFilePath(this.dir, kind, id);
    const lst = lstatOrNull(file);
    if (lst === null) return;
    assertSafeRepoPath(this.dir, path.relative(this.dir, file));
    fs.unlinkSync(file);
  }

  getSingleton<S extends SingletonName>(name: S): SingletonType<S> | null {
    const entry = SINGLETONS[name];
    const file = path.join(this.dir, entry.path);
    const lst = lstatOrNull(file);
    if (lst === null) return null;
    assertSafeRepoPath(this.dir, entry.path);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonUtf8(raw);
    } catch {
      throw new Error(`invalid JSON in ${file}`);
    }
    const result = entry.schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`schema validation failed for ${file}`);
    }
    return result.data as SingletonType<S>;
  }

  putSingleton<S extends SingletonName>(name: S, value: SingletonType<S>): void {
    const entry = SINGLETONS[name];
    if (this.writer !== entry.owner) {
      throw new OwnershipError(`${this.writer} may not write singleton ${name}`);
    }
    const parsed = entry.schema.safeParse(value);
    if (!parsed.success) throw parsed.error;
    const file = path.join(this.dir, entry.path);
    assertSafeRepoPath(this.dir, entry.path);
    const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
    atomicWrite(file, body);
  }

  writeBlob(relPath: string, bytes: Uint8Array): void {
    assertNoBackslash(relPath);
    if (hasGitSegment(relPath.replace(/\\/g, '/'))) {
      throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
    }
    const abs = assertSafeRepoPath(this.dir, relPath);
    assertBlobWriteDeletePath(relPath, this.writer);
    atomicWrite(abs, bytes);
  }

  readBlob(relPath: string): Buffer | null {
    assertNoBackslash(relPath);
    if (!fs.existsSync(path.resolve(this.dir))) return null;
    if (hasGitSegment(relPath.replace(/\\/g, '/'))) {
      throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
    }
    const abs = assertSafeRepoPath(this.dir, relPath, {
      allowExistingDirectory: true,
      allowRepoRoot: relPath.replace(/\\/g, '/') === '',
    });
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return null;
    return fs.readFileSync(abs);
  }

  listBlobs(relDir: string): string[] {
    assertNoBackslash(relDir);
    if (!fs.existsSync(path.resolve(this.dir))) return [];
    if (hasGitSegment(relDir.replace(/\\/g, '/'))) {
      throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relDir)}`);
    }
    const abs = assertSafeRepoPath(this.dir, relDir, {
      allowExistingDirectory: true,
      allowRepoRoot: relDir.replace(/\\/g, '/') === '',
    });
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs).filter((n) => !isTmpArtifactName(n));
  }

  deleteBlob(relPath: string): void {
    assertNoBackslash(relPath);
    if (hasGitSegment(relPath.replace(/\\/g, '/'))) {
      throw new UnsafeNameError(`unsafe repo path: ${JSON.stringify(relPath)}`);
    }
    const abs = assertSafeRepoPath(this.dir, relPath);
    assertBlobWriteDeletePath(relPath, this.writer);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
}

export { SCHEMA_VERSION };
