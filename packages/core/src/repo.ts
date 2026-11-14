import fs from 'node:fs';
import path from 'node:path';
import { assertSafeId } from './ids.ts';
import { KINDS, SINGLETONS, type KindName, type KindType, type SingletonName, type SingletonType, type Writer } from './layout.ts';
import {
  assertEntryIsPlainFile,
  atomicWrite,
  isTmpArtifactName,
  nodeGuardFs,
  recordRelPath,
  resolveRepoPath,
  type PathOptions,
} from './repo-paths.ts';
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

const BLOB_RESUME = /^profile\/resumes\/([^/]+)$/;
const BLOB_RESUME_TEXT = /^profile\/resume-text\/([^/]+)$/;

function assertBlobWriteDeletePath(relPath: string, writer: Writer): void {
  const match = BLOB_RESUME.exec(relPath) ?? BLOB_RESUME_TEXT.exec(relPath);
  const name = match?.[1];
  if (!name || name === '.' || name === '..') {
    throw new OwnershipError(`blob path not allowed: ${JSON.stringify(relPath)}`);
  }
  if (writer !== 'app') {
    throw new OwnershipError(`only the app may write resume blobs`);
  }
}

function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
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

  /** Native absolute path for a repo-relative `/` path, or `UnsafeNameError`. Every method goes through here. */
  private resolve(relPath: string, options: PathOptions = {}): string {
    return resolveRepoPath(path, nodeGuardFs, this.dir, relPath, options);
  }

  get<K extends KindName>(kind: K, id: string): KindType<K> | null {
    assertSafeId(id);
    const file = this.resolve(recordRelPath(KINDS[kind].dir, id));
    if (lstatOrNull(file) === null) return null;
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
    const items: KindType<K>[] = [];
    const errors: RepoReadError[] = [];

    // The kind directory is checked once. Each entry then needs only its own check.
    let kindDir: string;
    try {
      kindDir = this.resolve(entry.dir, { allowExistingDirectory: true });
    } catch (e) {
      errors.push({ file: path.join(this.dir, entry.dir), error: e instanceof Error ? e.message : String(e) });
      return { items, errors };
    }
    let names: string[];
    try {
      names = fs.readdirSync(kindDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { items, errors };
      throw e;
    }

    for (const name of names) {
      if (!name.endsWith('.json') || isTmpArtifactName(name)) continue;
      const file = path.join(kindDir, name);
      try {
        assertEntryIsPlainFile(nodeGuardFs, file, `${entry.dir}/${name}`);
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

  private assertCanWrite(kind: KindName, id: string, file: string): void {
    const entry = KINDS[kind];
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

    const file = this.resolve(recordRelPath(KINDS[kind].dir, id));
    this.assertCanWrite(kind, id, file);
    const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
    atomicWrite(file, body);
  }

  delete<K extends KindName>(kind: K, id: string): void {
    assertSafeId(id);
    const file = this.resolve(recordRelPath(KINDS[kind].dir, id));
    if (kind === 'command') throw new OwnershipError('commands may not be deleted');
    const entry = KINDS[kind];
    if (this.writer !== entry.owner) {
      throw new OwnershipError(`${this.writer} may not delete ${kind}`);
    }
    if (lstatOrNull(file) === null) return;
    fs.unlinkSync(file);
  }

  getSingleton<S extends SingletonName>(name: S): SingletonType<S> | null {
    const entry = SINGLETONS[name];
    const file = this.resolve(entry.path);
    if (lstatOrNull(file) === null) return null;
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
    const file = this.resolve(entry.path);
    const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
    atomicWrite(file, body);
  }

  // Blob paths are repo-relative with `/`, on every OS. Escapes, absolute and drive paths, `\` and `.git`
  // are refused by `resolve` before the ownership check runs.

  writeBlob(relPath: string, bytes: Uint8Array): void {
    const abs = this.resolve(relPath);
    assertBlobWriteDeletePath(relPath, this.writer);
    atomicWrite(abs, bytes);
  }

  readBlob(relPath: string): Buffer | null {
    const abs = this.resolve(relPath, { allowExistingDirectory: true, allowRepoRoot: relPath === '' });
    const st = lstatOrNull(abs);
    if (st === null || st.isDirectory()) return null;
    return fs.readFileSync(abs);
  }

  listBlobs(relDir: string): string[] {
    const abs = this.resolve(relDir, { allowExistingDirectory: true, allowRepoRoot: relDir === '' });
    let names: string[];
    try {
      names = fs.readdirSync(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw e;
    }
    return names.filter((n) => !isTmpArtifactName(n));
  }

  deleteBlob(relPath: string): void {
    const abs = this.resolve(relPath);
    assertBlobWriteDeletePath(relPath, this.writer);
    if (lstatOrNull(abs) !== null) fs.unlinkSync(abs);
  }
}

export { SCHEMA_VERSION };
