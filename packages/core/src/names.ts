// Name rules shared by the store (DataRepo, the record writers) and the sync layer (git.ts), so that a name
// one lane accepts is never refused by another. Internal: not exported from index.ts.
import { randomBytes } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** A record id (or point id, application id): letters, digits, `.`, `_` and `-`, and not `.` or `..`. */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id) && id !== '.' && id !== '..';
}

const TEMP_SUFFIX = /\.tmp-[0-9a-f]{6}$/;

/** The name `atomicWrite` writes before renaming: `<name>.tmp-<6 hex>`. */
export function tempNameFor(name: string): string {
  return `${name}.tmp-${randomBytes(3).toString('hex')}`;
}

/** Only a name that ends in `.tmp-` plus six lower-case hex digits is a temp file the store wrote. */
export function isTmpArtifactName(name: string): boolean {
  return TEMP_SUFFIX.test(name);
}

const SECRET_NAME = /(^|\/)(cookies?|secrets?)(\/|\.|$)|\.cookies?\.json$|storage-state|wake[-_]?token|(^|\/)\.env/i;
/** The files the store writes in the two resume folders: one name directly under each. */
const RESUME_FILE = /^profile\/(resumes|resume-text)\/[^/]+$/;

/**
 * Whether a repo-relative `/` path looks like a cookie jar or a secret by its name. The push guard refuses
 * such a path, and `DataRepo.put` refuses a record id that would make one. In the two resume folders the name
 * says nothing (a resume may be called `Cookies.pdf`), so only the content rule applies there.
 */
export function isSecretLookingPath(relPath: string): boolean {
  return !RESUME_FILE.test(relPath) && SECRET_NAME.test(relPath);
}

/**
 * The data repo's `.gitignore`, as the layout writes it: cookie and secret files are kept out of git at the
 * source. Each line is a folder name (`name/`) or a file-name glob, matched at any depth.
 */
export const LAYOUT_IGNORE_LINES = ['cookies/', '*.cookies.json', 'storage-state*.json', 'secrets/', '.env*'] as const;

const IGNORE_RULES = LAYOUT_IGNORE_LINES.map((line) => ({
  folder: line.endsWith('/'),
  re: new RegExp(`^${line.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`, 'i'),
}));

/**
 * Whether git would ignore this repo-relative `/` path under the layout's `.gitignore` (letter case ignored, as on
 * Windows and macOS). `DataRepo` refuses to write such a file: it would never be synced (G7).
 */
export function isIgnoredByLayout(relPath: string): boolean {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1] ?? '';
  return IGNORE_RULES.some((r) => (r.folder ? parts.slice(0, -1).some((s) => r.re.test(s)) : r.re.test(name)));
}

const OS_JUNK = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini']);

/** Files the operating system drops into a folder the user opens (Finder, Explorer). Never synced. */
export function isOsJunk(relPath: string): boolean {
  return OS_JUNK.has((relPath.slice(relPath.lastIndexOf('/') + 1) || '').toLowerCase());
}

/** Why `s` is not an http(s) address, or null when it is one. */
export function httpUrlProblem(s: string): string | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'is not a valid URL';
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'must be http or https';
}
