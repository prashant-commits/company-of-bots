import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Each run writes this file into its folder; a folder whose run process is gone is left over. */
const OWNER = 'cob-run-owner.json';
/** A folder without an owner file is a run that has only just started (or one older than this code). */
const OWNERLESS_GRACE_MS = 10 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/**
 * Remove `cob-run-*` folders under `root` left by test runs that have ended (interrupted by SIGINT, SIGTERM
 * or a kill, so their teardown never ran). A folder whose run process is still alive is never touched,
 * so two overlapping runs are safe.
 */
export function sweepEndedRuns(root: string, now = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith('cob-run-')) continue;
    const dir = path.join(root, name);
    let ended: boolean;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8')) as { pid?: unknown };
      ended = typeof owner.pid !== 'number' || !alive(owner.pid);
    } catch {
      try {
        ended = now - fs.statSync(dir).mtimeMs > OWNERLESS_GRACE_MS;
      } catch {
        continue;
      }
    }
    if (ended) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** Point TMPDIR at a fresh folder for the whole run; remove it, with everything in it, at the end. */
export default function setup(): () => void {
  const previous = process.env.TMPDIR;
  const base = os.tmpdir();
  sweepEndedRuns(base);
  const root = fs.mkdtempSync(path.join(base, 'cob-run-'));
  fs.writeFileSync(path.join(root, OWNER), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
