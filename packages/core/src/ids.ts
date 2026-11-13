import { createHash, randomBytes } from 'node:crypto';

export class UnsafeNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeNameError';
  }
}

/** Sortable record id: UTC timestamp to the millisecond plus 6 random hex chars. */
export function newId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

const TRACKING = /^(utm_.*|gclid|fbclid|ref)$/i;

/** Stable role id from a posting link, ignoring tracking params, hash, trailing slash and host case. */
export function roleIdFor(link: string): string {
  const url = new URL(link);
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING.test(key))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = new URLSearchParams(params).toString();
  const path = url.pathname.replace(/\/$/, '');
  const canonical = `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ''}`;
  return `r-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Reduce an uploaded file name to one segment that is safe on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? '';
  const cleaned = last
    .trim()
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '');
  if (cleaned === '') throw new UnsafeNameError(`unsafe file name: ${JSON.stringify(name)}`);
  const stem = cleaned.split('.')[0] ?? '';
  return RESERVED.test(stem.trim()) ? `_${cleaned}` : cleaned;
}

export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new UnsafeNameError(`unsafe id: ${JSON.stringify(id)}`);
  }
}
