import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSafeId, UnsafeNameError } from './ids.ts';
import { KINDS, SINGLETONS, type KindName, type KindType, type SingletonName, type SingletonType, type Writer } from './layout.ts';
import { RepoMetaSchema, SCHEMA_VERSION } from './schema.ts';
import type { Application, Command, DayLog, Transcript } from './schema.ts';

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

function assertInsideRepo(repoDir: string, relPath: string): string {
  const abs = path.resolve(repoDir, relPath);
  const root = path.resolve(repoDir);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new UnsafeNameError(`path escapes repo: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

export class DataRepo {
  readonly dir: string;
  readonly writer: Writer;

  constructor(dir: string, writer: Writer) {
    this.dir = dir;
    this.writer = writer;
    const metaPath = path.join(dir, 'cob.json');
    if (fs.existsSync(metaPath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(metaPath, 'utf8');
      } catch {
        throw new UnsupportedSchemaError('This data repo could not be read.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new UnsupportedSchemaError('This data repo could not be read.');
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
  }

  get<K extends KindName>(kind: K, id: string): KindType<K> | null {
    assertSafeId(id);
    const file = kindFilePath(this.dir, kind, id);
    if (!fs.existsSync(file)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`invalid JSON in ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const result = KINDS[kind].schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`schema validation failed for ${file}`);
    }
    return result.data as KindType<K>;
  }

  list<K extends KindName>(kind: K): { items: KindType<K>[]; errors: RepoReadError[] } {
    const entry = KINDS[kind];
    const kindDir = path.join(this.dir, entry.dir);
    const items: KindType<K>[] = [];
    const errors: RepoReadError[] = [];
    if (!fs.existsSync(kindDir)) return { items, errors };
    for (const name of fs.readdirSync(kindDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(kindDir, name);
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (e) {
        errors.push({ file, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        errors.push({ file, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const result = entry.schema.safeParse(parsed);
      if (!result.success) {
        errors.push({ file, error: result.error.message });
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
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
    const tmp = path.join(dir, `${path.basename(file)}.tmp-${randomBytes(3).toString('hex')}`);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  }

  delete<K extends KindName>(kind: K, id: string): void {
    assertSafeId(id);
    if (kind === 'command') throw new OwnershipError('commands may not be deleted');
    const entry = KINDS[kind];
    if (this.writer !== entry.owner) {
      throw new OwnershipError(`${this.writer} may not delete ${kind}`);
    }
    const file = kindFilePath(this.dir, kind, id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  getSingleton<S extends SingletonName>(name: S): SingletonType<S> | null {
    const entry = SINGLETONS[name];
    const file = path.join(this.dir, entry.path);
    if (!fs.existsSync(file)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
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
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify(parsed.data, null, 2)}\n`;
    const tmp = path.join(dir, `${path.basename(file)}.tmp-${randomBytes(3).toString('hex')}`);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  }

  writeBlob(relPath: string, bytes: Uint8Array): void {
    const abs = assertInsideRepo(this.dir, relPath);
    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${abs}.tmp-${randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, abs);
  }

  readBlob(relPath: string): Buffer | null {
    const abs = assertInsideRepo(this.dir, relPath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
  }

  listBlobs(relDir: string): string[] {
    const abs = assertInsideRepo(this.dir, relDir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs);
  }

  deleteBlob(relPath: string): void {
    const abs = assertInsideRepo(this.dir, relPath);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
}

export { SCHEMA_VERSION };
