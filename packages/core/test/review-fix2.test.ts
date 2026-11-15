// Regression tests for fix round 2 of the final review (rows H1-H3). Each test names its row.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { ApplicationStateError, beginSubmit } from '../src/applications.ts';
import { CONFIRMED } from '../src/confidence.ts';
import { cloneDataRepo, initPrivateRepo, pullRepo, syncRepo } from '../src/git.ts';
import { roleIdFor } from '../src/ids.ts';
import { withoutLocalPaths } from '../src/repo-paths.ts';
import { appInput, bare, pair, sample, tmpDir } from './helpers.ts';

const identity = { name: 'Test User', email: 'test@example.com' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

test('H1 route fragments that differ only by a trailing slash are one posting; other differences stay separate', () => {
  for (const [a, b] of [
    ['https://jobs.example.com/#/job/101', 'https://jobs.example.com/#/job/101/'],
    ['https://jobs.example.com/careers#!/view/101', 'https://jobs.example.com/careers#!/view/101/'],
    ['https://jobs.example.com/#/job/101', 'https://jobs.example.com/#/job/101//'],
  ]) {
    expect(roleIdFor(b!), b).toBe(roleIdFor(a!));
  }
  expect(roleIdFor('https://jobs.example.com/#/job/101')).not.toBe(roleIdFor('https://jobs.example.com/#/job/1010'));
  expect(roleIdFor('https://jobs.example.com/#/job/101')).not.toBe(roleIdFor('https://jobs.example.com/#/job/102/'));
  expect(roleIdFor('https://jobs.example.com/#/job/101')).not.toBe(roleIdFor('https://jobs.example.com/'));

  const { app, agent } = pair();
  app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 1 }));
  const intent = { resumeFile: 'cv.pdf', points: [{ pointId: 'p', rev: 1 }] };
  const first = beginSubmit(agent, appInput({ link: 'https://jobs.example.com/#/job/101' }), intent);
  expect(() => beginSubmit(agent, appInput({ link: 'https://jobs.example.com/#/job/101/' }), intent)).toThrow(ApplicationStateError);
  expect(() => beginSubmit(agent, appInput({ link: 'https://jobs.example.com/#/job/101/' }), intent)).toThrow(first.id);
  expect(agent.list('application').items).toHaveLength(1);
});

test('H2 withoutLocalPaths replaces the checkout path before a period and inside a file:// URL; siblings stay', () => {
  const dir = path.join(tmpDir(), 'app');
  fs.mkdirSync(dir);
  expect(withoutLocalPaths(dir, `see ${dir}.`)).toBe('see ..');
  expect(withoutLocalPaths(dir, `open file://${dir}/applications/a.json failed`)).toBe('open applications/a.json failed');
  expect(withoutLocalPaths(dir, `'file://${dir}'`)).toBe(`'.'`);
  expect(withoutLocalPaths(dir, `${dir}/applications/a.json`)).toBe('applications/a.json');
  for (const keep of [`${dir}2/x`, `/backup${dir}/y`, `${dir}.bak/x`, `file:///backup${dir}/y`]) {
    expect(withoutLocalPaths(dir, `see ${keep}.`), keep).toBe(`see ${keep}.`);
  }
});

test('H3 pullRepo with restoreHost reports pushed: true when it restored the host, though local work then stays local', async () => {
  const remote = bare();
  const appDir = path.join(tmpDir(), 'app');
  const agentDir = path.join(tmpDir(), 'agent');
  await initPrivateRepo(appDir, { identity, remote });
  await cloneDataRepo(remote, agentDir, identity);
  const before = sh(remote, 'rev-parse', 'main').trim();
  fs.mkdirSync(path.join(appDir, 'notes'));
  fs.writeFileSync(path.join(appDir, 'notes', 'x.txt'), 'x\n');
  await syncRepo(appDir, 'app', 'x');
  await pullRepo(agentDir, 'agent');
  sh(remote, 'update-ref', 'refs/heads/main', before); // the host goes back by mistake
  const restored = sh(agentDir, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(agentDir, 'later.txt'), 'later\n');
  const r = await pullRepo(agentDir, 'agent', { restoreHost: true });
  expect(r.pushed).toBe(true);
  expect(r.committed).not.toBeNull();
  expect(sh(remote, 'rev-parse', 'main').trim()).toBe(restored);
  expect(sh(remote, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('later.txt');
}, 60_000);
