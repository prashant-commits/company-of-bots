import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Point TMPDIR at a fresh folder for the whole run; remove it, with everything in it, at the end. */
export default function setup(): () => void {
  const previous = process.env.TMPDIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cob-run-'));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
