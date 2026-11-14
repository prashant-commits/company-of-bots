import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import setup, { sweepEndedRuns } from './global-setup.ts';
import { tmpDir } from './helpers.ts';

test('R21 the next run removes folders of runs that have ended, and never the folder of a run still going', () => {
  const root = tmpDir();
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
  const make = (name: string, owner?: unknown, ageMs = 0) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'cob-test-x'), { recursive: true });
    if (owner !== undefined) fs.writeFileSync(path.join(dir, 'cob-run-owner.json'), JSON.stringify(owner));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, t, t);
    return dir;
  };
  const ended = make('cob-run-ended', { pid: deadPid });
  const live = make('cob-run-live', { pid: process.pid });
  const ownerlessOld = make('cob-run-old', undefined, 60 * 60 * 1000);
  const justStarted = make('cob-run-starting');
  const unrelated = make('something-else', { pid: deadPid });
  expect(sweepEndedRuns(root).sort()).toEqual(['cob-run-ended', 'cob-run-old']);
  expect(fs.existsSync(ended)).toBe(false);
  expect(fs.existsSync(ownerlessOld)).toBe(false);
  expect(fs.existsSync(live)).toBe(true);
  expect(fs.existsSync(justStarted)).toBe(true);
  expect(fs.existsSync(unrelated)).toBe(true);
});

test.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
  'R21 a folder the sweep cannot remove is skipped, and the run still starts',
  () => {
    const root = tmpDir();
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
    const stuck = path.join(root, 'cob-run-stuck');
    fs.mkdirSync(path.join(stuck, 'locked'), { recursive: true });
    fs.writeFileSync(path.join(stuck, 'locked', 'f'), 'x');
    fs.writeFileSync(path.join(stuck, 'cob-run-owner.json'), JSON.stringify({ pid: deadPid }));
    const ended = path.join(root, 'cob-run-ended');
    fs.mkdirSync(ended);
    fs.writeFileSync(path.join(ended, 'cob-run-owner.json'), JSON.stringify({ pid: deadPid }));
    fs.chmodSync(path.join(stuck, 'locked'), 0o500);
    const previous = process.env.TMPDIR;
    try {
      expect(sweepEndedRuns(root)).toEqual(['cob-run-ended']);
      expect(fs.existsSync(stuck)).toBe(true);
      process.env.TMPDIR = root;
      const teardown = setup(); // starts despite the folder it cannot remove
      expect(process.env.TMPDIR).toMatch(/cob-run-/);
      teardown();
      expect(process.env.TMPDIR).toBe(root);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      fs.chmodSync(path.join(stuck, 'locked'), 0o700);
    }
  },
);
