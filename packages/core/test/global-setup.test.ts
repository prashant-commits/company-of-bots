import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { sweepEndedRuns } from './global-setup.ts';
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
