import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, expect, test } from 'vitest';
import { DataRepo } from '../src/repo.ts';
import { createCommand, finishCommand, queuedCommands } from '../src/commands.ts';
import { upsertRole } from '../src/applications.ts';
import {
  GitError,
  SecretLeakError,
  SyncBusyError,
  assertNoSecrets,
  cloneDataRepo,
  git,
  initPrivateRepo,
  pullRepo,
  syncRepo,
} from '../src/git.ts';
import { repositoryKey } from '../src/remote-key.ts';
import { T1 as T1_ISO, bare, clean, rebaseInProgress, roleInput, sample, tmpDir } from './helpers.ts';

const T = 30_000;
const identity = { name: 'Test User', email: 'test@example.com' };

let remote: string;
let appDir: string;
let agentDir: string;
let app: DataRepo;
let agent: DataRepo;

beforeEach(async () => {
  remote = bare();
  appDir = tmpDir();
  agentDir = path.join(tmpDir(), 'agent');
  await initPrivateRepo(appDir, { identity, remote });
  await cloneDataRepo(remote, agentDir, identity);
  app = new DataRepo(appDir, 'app');
  agent = new DataRepo(agentDir, 'agent');
}, T);

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const writeJson = (dir: string, rel: string, value: unknown) => write(dir, rel, JSON.stringify(value, null, 2) + '\n');
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));
const hook = (dir: string, name: string, body: string) => {
  const gitDir = fs.existsSync(path.join(dir, '.git')) ? path.join(dir, '.git') : dir; // bare remotes have no .git
  const file = path.join(gitDir, 'hooks', name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
};
/** A third checkout of the same remote, for moving the remote behind our back. */
function thirdClone(): string {
  const dir = path.join(tmpDir(), 'third');
  execFileSync('git', ['clone', '-q', remote, dir]);
  execFileSync('git', ['config', 'user.name', 'Third'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'third@example.com'], { cwd: dir });
  return dir;
}
/** Make `app` and `agent` agree on one app-owned source file; returns the record. */
async function sharedSource() {
  const s = sample.source({ id: 's1', label: 'original' });
  app.put('source', s);
  await syncRepo(appDir, 'app', 'add source');
  await pullRepo(agentDir, 'agent');
  return s;
}

// ---------------------------------------------------------------------------
// Task 9 brief tests
// ---------------------------------------------------------------------------

test('app command reaches the agent and the agent result comes back', async () => {
  createCommand(app, { verb: 'run_role', target: null, payload: { role: 'finder' } });
  expect((await syncRepo(appDir, 'app', 'Run now')).pushed).toBe(true);
  await pullRepo(agentDir, 'agent');
  const [c] = queuedCommands(agent);
  finishCommand(agent, c!.id, 'done', 'ran finder');
  await syncRepo(agentDir, 'agent', 'agent run');
  await pullRepo(appDir, 'app');
  expect(app.get('command', c!.id)!.state).toBe('done');
  clean(appDir);
  clean(agentDir);
}, T);

test('writes to different files from both sides merge without conflict', async () => {
  createCommand(app, { verb: 'run_role', target: null, payload: { role: 'applier' } });
  upsertRole(agent, roleInput());
  await syncRepo(appDir, 'app', 'app');
  const r = await syncRepo(agentDir, 'agent', 'agent');
  expect(r).toMatchObject({ pushed: true, resolved: [] });
  await pullRepo(appDir, 'app');
  expect(app.list('role').items).toHaveLength(1);
  clean(appDir);
  clean(agentDir);
}, T);

test('app-owned file, owner syncs second: the app’s version wins', async () => {
  const s = await sharedSource();
  writeJson(agentDir, 'sources/s1.json', { ...s, label: 'hand edit' });
  await syncRepo(agentDir, 'agent', 'hand edit');
  app.put('source', { ...s, label: 'app edit' });
  expect(await syncRepo(appDir, 'app', 'app edit')).toMatchObject({ pushed: true, resolved: ['sources/s1.json'] });
  expect(app.get('source', 's1')!.label).toBe('app edit');
  clean(appDir);
}, T);

test('app-owned file, non-owner syncs second: the upstream owner version wins and the empty commit is dropped', async () => {
  const s = await sharedSource();
  app.put('source', { ...s, label: 'app edit' });
  await syncRepo(appDir, 'app', 'app edit');
  writeJson(agentDir, 'sources/s1.json', { ...s, label: 'hand edit' });
  const r = await syncRepo(agentDir, 'agent', 'hand edit');
  expect(r).toMatchObject({ pushed: true, resolved: ['sources/s1.json'] });
  expect(agent.get('source', 's1')!.label).toBe('app edit');
  expect(await git(agentDir, ['log', '-1', '--format=%s'])).toBe('app edit\n');
  clean(agentDir);
}, T);

test('agent-owned file, owner syncs second: the agent’s version wins', async () => {
  const a = sample.application({ id: 'a1', title: 'original' });
  agent.put('application', a);
  await syncRepo(agentDir, 'agent', 'add app');
  await pullRepo(appDir, 'app');
  writeJson(appDir, 'applications/a1.json', { ...a, title: 'hand edit' });
  await syncRepo(appDir, 'app', 'hand edit');
  agent.put('application', { ...a, title: 'agent edit' });
  expect(await syncRepo(agentDir, 'agent', 'agent edit')).toMatchObject({ pushed: true, resolved: ['applications/a1.json'] });
  expect(agent.get('application', 'a1')!.title).toBe('agent edit');
  clean(agentDir);
}, T);

test('the owner’s delete wins over the other side’s edit', async () => {
  const s = await sharedSource();
  writeJson(agentDir, 'sources/s1.json', { ...s, label: 'hand edit' });
  await syncRepo(agentDir, 'agent', 'hand edit');
  app.delete('source', 's1');
  expect(await syncRepo(appDir, 'app', 'remove source')).toMatchObject({ pushed: true, resolved: ['sources/s1.json'] });
  expect(exists(appDir, 'sources/s1.json')).toBe(false);
  clean(appDir);
}, T);

test('an unowned path resolves to the app’s side in both orders', async () => {
  write(appDir, 'notes.txt', 'app\n');
  write(agentDir, 'notes.txt', 'agent\n');
  await syncRepo(appDir, 'app', 'app notes');
  expect(await syncRepo(agentDir, 'agent', 'agent notes')).toMatchObject({ pushed: true, resolved: ['notes.txt'] });
  expect(read(agentDir, 'notes.txt')).toBe('app\n');
  write(agentDir, 'notes.txt', 'agent 2\n');
  await syncRepo(agentDir, 'agent', 'agent 2');
  write(appDir, 'notes.txt', 'app 2\n');
  expect(await syncRepo(appDir, 'app', 'app 2')).toMatchObject({ pushed: true, resolved: ['notes.txt'] });
  expect(read(appDir, 'notes.txt')).toBe('app 2\n');
  clean(appDir);
  clean(agentDir);
}, T);

test('a non-ASCII resume name commits, pushes and reaches the other side', async () => {
  app.writeBlob('profile/resumes/My Résumé.pdf', new Uint8Array([1, 2, 3]));
  expect((await syncRepo(appDir, 'app', 'resume')).pushed).toBe(true);
  await pullRepo(agentDir, 'agent');
  expect(exists(agentDir, 'profile/resumes/My Résumé.pdf')).toBe(true);
}, T);

test('pullRepo commits local changes first and does not push', async () => {
  createCommand(app, { verb: 'run_role', target: null, payload: { role: 'finder' } });
  const r = await pullRepo(appDir, 'app');
  expect(r).toMatchObject({ pushed: false });
  expect(r.committed).not.toBeNull();
  clean(appDir);
}, T);

test('cookie files and cookie-shaped content are refused and never reach the remote', async () => {
  write(appDir, 'tmp/session.json', '{"cookies":[{"name":"a","sameSite":"Lax","httpOnly":true}]}');
  await expect(syncRepo(appDir, 'app', 'oops')).rejects.toBeInstanceOf(SecretLeakError);
  expect(await git(remote, ['log', '--all', '--name-only', '--format='])).not.toContain('session.json');
}, T);

test('nothing to commit means no commit', async () => {
  expect(await syncRepo(appDir, 'app', 'noop')).toMatchObject({ committed: null, pushed: true, resolved: [] });
}, T);

// ---------------------------------------------------------------------------
// Behaviour rows
// ---------------------------------------------------------------------------

test('B3 init without a remote: branch main, local identity, one commit, no remote', async () => {
  const dir = path.join(tmpDir(), 'solo');
  await initPrivateRepo(dir, { identity });
  expect(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  expect(sh(dir, 'config', '--local', 'user.name').trim()).toBe(identity.name);
  expect(sh(dir, 'config', '--local', 'user.email').trim()).toBe(identity.email);
  expect(sh(dir, 'log', '--format=%s')).toBe('Initialize private data repo\n');
  expect(sh(dir, 'remote')).toBe('');
  expect(sh(dir, 'status', '--porcelain')).toBe('');
  expect(new DataRepo(dir, 'app').getSingleton('meta')).toMatchObject({ schemaVersion: 1 });
}, T);

test('B3 init with a remote: origin added, main pushed with upstream, one commit', () => {
  expect(sh(appDir, 'remote').trim()).toBe('origin');
  expect(sh(appDir, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/main');
  expect(sh(remote, 'rev-parse', 'main')).toBe(sh(appDir, 'rev-parse', 'HEAD'));
  expect(sh(appDir, 'log', '--format=%s')).toBe('Initialize private data repo\n');
});

test('B3 init refuses a non-empty folder before creating a repo in it', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'x');
  await expect(initPrivateRepo(dir, { identity })).rejects.toThrow(/not empty/);
  expect(fs.readdirSync(dir)).toEqual(['mine.txt']);
}, T);

test('B3 init fails before touching the folder when the remote is wrong or already has main', async () => {
  const dir = path.join(tmpDir(), 'fresh');
  await expect(initPrivateRepo(dir, { identity, remote: path.join(tmpDir(), 'nope.git') })).rejects.toBeInstanceOf(GitError);
  expect(fs.existsSync(dir)).toBe(false);
  await expect(initPrivateRepo(dir, { identity, remote })).rejects.toBeInstanceOf(GitError); // remote already has main
  expect(fs.existsSync(dir)).toBe(false);
}, T);

test('B3 a relative local remote path is stored absolute', async () => {
  const dir = path.join(tmpDir(), 'rel');
  const r2 = bare();
  await initPrivateRepo(dir, { identity, remote: path.relative(process.cwd(), r2) });
  expect(path.isAbsolute(sh(dir, 'remote', 'get-url', 'origin').trim())).toBe(true);
  expect(sh(r2, 'rev-parse', 'main')).toBe(sh(dir, 'rev-parse', 'HEAD'));
}, T);

test('B4 clone gives a working checkout with local identity that DataRepo opens', async () => {
  expect(sh(agentDir, 'config', '--local', 'user.name').trim()).toBe(identity.name);
  expect(sh(agentDir, 'config', '--local', 'user.email').trim()).toBe(identity.email);
  expect(agent.getSingleton('meta')).toMatchObject({ schemaVersion: 1 });
  expect(sh(agentDir, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/main');
}, T);

test('B4 clone follows git clone semantics: an empty existing dir is fine, a non-empty one is not', async () => {
  const empty = tmpDir();
  await cloneDataRepo(remote, empty, identity);
  expect(new DataRepo(empty, 'agent').getSingleton('meta')).not.toBeNull();
  const full = tmpDir();
  fs.writeFileSync(path.join(full, 'x'), 'x');
  await expect(cloneDataRepo(remote, full, identity)).rejects.toBeInstanceOf(GitError);
  expect(fs.readdirSync(full)).toEqual(['x']);
}, T);

test('B5 local changes and no remote changes: one commit with the message, remote equals HEAD', async () => {
  app.put('source', sample.source({ id: 's1' }));
  const before = sh(appDir, 'rev-list', '--count', 'HEAD').trim();
  const r = await syncRepo(appDir, 'app', 'add a source');
  expect(r.committed).toBe(sh(appDir, 'rev-parse', 'HEAD').trim());
  expect(r).toMatchObject({ pushed: true, resolved: [] });
  expect(Number(sh(appDir, 'rev-list', '--count', 'HEAD'))).toBe(Number(before) + 1);
  expect(sh(appDir, 'log', '-1', '--format=%s')).toBe('add a source\n');
  expect(sh(remote, 'rev-parse', 'main')).toBe(sh(appDir, 'rev-parse', 'HEAD'));
  clean(appDir);
}, T);

test('B5 the commit is made with the repo-local identity', async () => {
  app.put('source', sample.source({ id: 's1' }));
  await syncRepo(appDir, 'app', 'x');
  expect(sh(appDir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Test User <test@example.com>');
}, T);

test('B5 committed is a sha that still exists in HEAD after the commit was rebased onto remote changes', async () => {
  write(agentDir, 'notes.txt', 'agent\n');
  app.put('source', sample.source({ id: 's1' }));
  await syncRepo(appDir, 'app', 'app side');
  const r = await syncRepo(agentDir, 'agent', 'agent side');
  expect(r).toMatchObject({ pushed: true, resolved: [] });
  expect(r.committed).toBe(sh(agentDir, 'rev-parse', 'HEAD').trim());
  expect(sh(agentDir, 'log', '-1', '--format=%s')).toBe('agent side\n');
}, T);

test('B6 nothing to commit: committed is null, and pushed is false while the remote is behind HEAD', async () => {
  expect(await syncRepo(appDir, 'app', 'noop')).toMatchObject({ committed: null, pushed: true });
  // A commit made outside syncRepo that never went out: syncRepo pushes it.
  write(appDir, 'notes.txt', 'x\n');
  sh(appDir, 'add', '-A');
  sh(appDir, 'commit', '-q', '-m', 'manual');
  expect(await syncRepo(appDir, 'app', 'noop')).toMatchObject({ committed: null, pushed: true });
  expect(sh(remote, 'rev-parse', 'main')).toBe(sh(appDir, 'rev-parse', 'HEAD'));
}, T);

test('B7 resolved lists each path once, sorted, across several replayed commits', async () => {
  write(appDir, 'notes.txt', 'base\n');
  write(appDir, 'b.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(appDir, 'notes.txt', 'app\n');
  write(appDir, 'b.txt', 'app\n');
  await syncRepo(appDir, 'app', 'app edits');
  // Two local commits on the agent, both touching both files.
  for (const n of ['1', '2']) {
    write(agentDir, 'notes.txt', `agent ${n}\n`);
    write(agentDir, 'b.txt', `agent ${n}\n`);
    sh(agentDir, 'add', '-A');
    sh(agentDir, 'commit', '-q', '-m', `local ${n}`);
  }
  expect(await syncRepo(agentDir, 'agent', 'unused')).toMatchObject({ pushed: true, resolved: ['b.txt', 'notes.txt'] });
  expect(read(agentDir, 'notes.txt')).toBe('app\n');
  clean(agentDir);
}, T);

test('B9 the owner deleted the file first and pushed; the other side’s later edit does not bring it back', async () => {
  const s = await sharedSource();
  app.delete('source', 's1');
  await syncRepo(appDir, 'app', 'remove source');
  writeJson(agentDir, 'sources/s1.json', { ...s, label: 'hand edit' });
  expect(await syncRepo(agentDir, 'agent', 'hand edit')).toMatchObject({ pushed: true, resolved: ['sources/s1.json'] });
  expect(exists(agentDir, 'sources/s1.json')).toBe(false);
  await pullRepo(appDir, 'app');
  expect(exists(appDir, 'sources/s1.json')).toBe(false);
  clean(agentDir);
}, T);

test('B9 the owner keeps the file when the other side deleted it, in either order', async () => {
  const s = await sharedSource();
  // Non-owner deletes first and pushes; the owner edits and syncs second.
  fs.unlinkSync(path.join(agentDir, 'sources/s1.json'));
  await syncRepo(agentDir, 'agent', 'hand delete');
  app.put('source', { ...s, label: 'app edit' });
  expect(await syncRepo(appDir, 'app', 'app edit')).toMatchObject({ pushed: true, resolved: ['sources/s1.json'] });
  expect(app.get('source', 's1')!.label).toBe('app edit');
  await pullRepo(agentDir, 'agent');
  expect(agent.get('source', 's1')!.label).toBe('app edit');
  // Owner edits first and pushes; the non-owner deletes and syncs second.
  app.put('source', { ...s, label: 'app edit 2' });
  await syncRepo(appDir, 'app', 'app edit 2');
  fs.unlinkSync(path.join(agentDir, 'sources/s1.json'));
  expect(await syncRepo(agentDir, 'agent', 'hand delete 2')).toMatchObject({ pushed: true, resolved: ['sources/s1.json'] });
  expect(agent.get('source', 's1')!.label).toBe('app edit 2');
  clean(agentDir);
}, T);

test('B11 a SecretLeakError leaves no rebase and no commit', async () => {
  write(appDir, 'tmp/session.json', '{"sameSite":"Lax","httpOnly":true}');
  const head = sh(appDir, 'rev-parse', 'HEAD');
  await expect(syncRepo(appDir, 'app', 'oops')).rejects.toBeInstanceOf(SecretLeakError);
  expect(rebaseInProgress(appDir)).toBe(false);
  expect(sh(appDir, 'rev-parse', 'HEAD')).toBe(head);
}, T);

test('B11 (amended by R13) a rebase the user left in progress is refused and left exactly as it was', async () => {
  write(appDir, 'notes.txt', 'app\n');
  await syncRepo(appDir, 'app', 'app notes');
  write(agentDir, 'notes.txt', 'agent\n');
  sh(agentDir, 'add', '-A');
  sh(agentDir, 'commit', '-q', '-m', 'agent notes');
  expect(() => sh(agentDir, 'pull', '--rebase', '--no-autostash', 'origin', 'main')).toThrow();
  await expectRefused(agentDir, 'agent', /A rebase/);
  expect(rebaseInProgress(agentDir)).toBe(true);
}, T);

test('B12 a conflict on a path with spaces and non-ASCII is resolved by its exact path', async () => {
  const name = 'profile/resumes/My Résumé.pdf';
  app.writeBlob(name, new Uint8Array([1, 2, 3]));
  await syncRepo(appDir, 'app', 'resume');
  await pullRepo(agentDir, 'agent');
  fs.writeFileSync(path.join(agentDir, name), Buffer.from([9, 9, 9]));
  await syncRepo(agentDir, 'agent', 'agent resume');
  app.writeBlob(name, new Uint8Array([4, 5, 6]));
  expect(await syncRepo(appDir, 'app', 'app resume')).toMatchObject({ pushed: true, resolved: [name] });
  expect(fs.readFileSync(path.join(appDir, name))).toEqual(Buffer.from([4, 5, 6]));
  await pullRepo(agentDir, 'agent');
  expect(fs.readFileSync(path.join(agentDir, name))).toEqual(Buffer.from([4, 5, 6]));
  clean(appDir);
  clean(agentDir);
}, T);

test('B12 a path with glob characters is treated literally', async () => {
  write(appDir, 'we ird[1].txt', 'base\n');
  write(appDir, 'weird1.txt', 'other\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(agentDir, 'we ird[1].txt', 'agent\n');
  await syncRepo(agentDir, 'agent', 'agent');
  write(appDir, 'we ird[1].txt', 'app\n');
  expect(await syncRepo(appDir, 'app', 'app')).toMatchObject({ pushed: true, resolved: ['we ird[1].txt'] });
  expect(read(appDir, 'weird1.txt')).toBe('other\n');
  clean(appDir);
}, T);

test('B13 path patterns are refused, nothing is committed, paths are unstaged but stay on disk', async () => {
  const bad = ['profile/secret.txt', 'tmp/my-storage-state.bak', 'run/wake_token', 'dump/Cookies.txt', 'x/session.cookie.json'];
  for (const p of bad) write(appDir, p, 'x');
  write(appDir, 'fine.txt', 'ok\n');
  const head = sh(appDir, 'rev-parse', 'HEAD');
  const err = (await syncRepo(appDir, 'app', 'oops').catch((e: unknown) => e)) as SecretLeakError;
  expect(err).toBeInstanceOf(SecretLeakError);
  expect([...err.paths].sort()).toEqual([...bad].sort());
  expect(sh(appDir, 'rev-parse', 'HEAD')).toBe(head);
  expect(sh(appDir, 'diff', '--cached', '--name-only')).toBe('');
  for (const p of bad) expect(exists(appDir, p)).toBe(true);
  expect(rebaseInProgress(appDir)).toBe(false);
}, T);

test('B13 a Netscape cookie header is refused wherever the file lives and whatever it is called', async () => {
  write(appDir, 'notes/export.txt', '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc\n');
  const err = (await syncRepo(appDir, 'app', 'oops').catch((e: unknown) => e)) as SecretLeakError;
  expect(err.paths).toEqual(['notes/export.txt']);
}, T);

test('B13 JSON needs both "sameSite" and "httpOnly"; one alone is fine', async () => {
  write(appDir, 'notes/a.json', '{"sameSite":"Lax"}');
  write(appDir, 'notes/b.json', '{"httpOnly":true}');
  expect((await syncRepo(appDir, 'app', 'fine')).pushed).toBe(true);
}, T);

test('B13 the file is still there on a later sync: it is refused again and never reaches the remote', async () => {
  write(appDir, 'tmp/session.json', '{"sameSite":"Lax","httpOnly":true}');
  for (let i = 0; i < 3; i++) {
    write(appDir, `ok-${i}.txt`, 'ok\n');
    await expect(syncRepo(appDir, 'app', `try ${i}`)).rejects.toBeInstanceOf(SecretLeakError);
  }
  await expect(pullRepo(appDir, 'app')).rejects.toBeInstanceOf(SecretLeakError);
  expect(await git(remote, ['log', '--all', '--name-only', '--format='])).not.toContain('session.json');
  expect(await git(remote, ['log', '--all', '--name-only', '--format='])).not.toContain('ok-0.txt');
  fs.unlinkSync(path.join(appDir, 'tmp/session.json'));
  expect((await syncRepo(appDir, 'app', 'now fine')).pushed).toBe(true);
  expect(await git(remote, ['log', '--all', '--name-only', '--format='])).toContain('ok-0.txt');
}, T);

test('B13 the .gitignore from init keeps cookie files out at the source, so they never trigger the guard', async () => {
  for (const p of ['cookies/a.json', 'site.cookies.json', 'storage-state-1.json', 'secrets/k', '.env.local']) write(appDir, p, 'x');
  expect((await syncRepo(appDir, 'app', 'fine')).pushed).toBe(true);
  expect(sh(remote, 'ls-tree', '-r', '--name-only', 'main')).not.toMatch(/cookies|storage-state|secrets|\.env/);
}, T);

test('B13 assertNoSecrets unstages a force-added secret and leaves the rest staged', () => {
  write(appDir, '.env.local', 'TOKEN=1\n');
  write(appDir, 'fine.txt', 'ok\n');
  sh(appDir, 'add', '-f', '.env.local', 'fine.txt');
  expect(() => assertNoSecrets(appDir, ['.env.local', 'fine.txt'])).toThrow(SecretLeakError);
  expect(sh(appDir, 'diff', '--cached', '--name-only')).toBe('fine.txt\n');
  expect(exists(appDir, '.env.local')).toBe(true);
  expect(() => assertNoSecrets(appDir, ['fine.txt'])).not.toThrow();
});

test('B14 pullRepo resolves conflicts by owner after committing local changes, and never pushes', async () => {
  write(appDir, 'notes.txt', 'app\n');
  write(agentDir, 'notes.txt', 'agent\n');
  await syncRepo(agentDir, 'agent', 'agent notes');
  const remoteHead = sh(remote, 'rev-parse', 'main');
  const r = await pullRepo(appDir, 'app');
  expect(r).toMatchObject({ pushed: false, resolved: ['notes.txt'] });
  expect(r.committed).not.toBeNull();
  expect(sh(appDir, 'log', '-1', '--format=%s')).toBe('sync: local changes before pull\n');
  expect(read(appDir, 'notes.txt')).toBe('app\n');
  expect(sh(remote, 'rev-parse', 'main')).toBe(remoteHead);
  clean(appDir);
}, T);

test('B14 pullRepo with nothing local just pulls', async () => {
  app.put('source', sample.source({ id: 's1' }));
  await syncRepo(appDir, 'app', 'add source');
  expect(await pullRepo(agentDir, 'agent')).toEqual({ committed: null, pushed: false, resolved: [] });
  expect(agent.get('source', 's1')).not.toBeNull();
}, T);

test('B14 pullRepo where the local commit is dropped as empty reports committed: null', async () => {
  const s = await sharedSource();
  app.put('source', { ...s, label: 'app edit' });
  await syncRepo(appDir, 'app', 'app edit');
  writeJson(agentDir, 'sources/s1.json', { ...s, label: 'hand edit' });
  const r = await pullRepo(agentDir, 'agent');
  expect(r).toMatchObject({ committed: null, resolved: ['sources/s1.json'] });
  clean(agentDir);
}, T);

/** Moves the remote from a third checkout, once per call, each time with a new file. */
function remoteMover(): { advance: () => Promise<void>; count: () => number } {
  const third = thirdClone();
  let n = 0;
  return {
    advance: async () => {
      n++;
      write(third, `third-${n}.txt`, `${n}\n`);
      sh(third, 'add', '-A');
      sh(third, 'commit', '-q', '-m', `third ${n}`);
      sh(third, 'push', '-q', 'origin', 'main');
    },
    count: () => n,
  };
}

test('B15 the remote moves between our pull and our push: pull and push are retried and succeed', async () => {
  const mover = remoteMover();
  write(agentDir, 'mine.txt', 'mine\n');
  let once = true;
  const r = await syncRepo(agentDir, 'agent', 'mine', {
    beforePush: async () => {
      if (once) await mover.advance();
      once = false;
    },
  });
  expect(r).toMatchObject({ pushed: true, resolved: [] });
  expect(mover.count()).toBe(1);
  expect(sh(remote, 'rev-parse', 'main')).toBe(sh(agentDir, 'rev-parse', 'HEAD'));
  expect(remoteTree()).toContain('third-1.txt');
  expect(remoteTree()).toContain('mine.txt');
  clean(agentDir);
}, T);

test('B15 when every attempt is beaten, pushed is false with no error and the commit goes out next time', async () => {
  const mover = remoteMover();
  write(agentDir, 'mine.txt', 'mine\n');
  const r = await syncRepo(agentDir, 'agent', 'mine', { beforePush: mover.advance });
  expect(r).toMatchObject({ pushed: false, resolved: [] });
  expect(r.committed).toBe(sh(agentDir, 'rev-parse', 'HEAD').trim());
  expect(mover.count()).toBe(3); // default maxAttempts
  expect(rebaseInProgress(agentDir)).toBe(false);
  expect(await syncRepo(agentDir, 'agent', 'again')).toMatchObject({ committed: null, pushed: true });
  expect(remoteTree()).toContain('mine.txt');
}, T);

test('B15 maxAttempts is honoured', async () => {
  const mover = remoteMover();
  write(agentDir, 'mine.txt', 'mine\n');
  expect((await syncRepo(agentDir, 'agent', 'mine', { maxAttempts: 1, beforePush: mover.advance })).pushed).toBe(false);
  expect(mover.count()).toBe(1);
  expect((await syncRepo(agentDir, 'agent', 'mine', { maxAttempts: 5, beforePush: mover.advance })).pushed).toBe(false);
  expect(mover.count()).toBe(6); // 1 earlier + 5 now
}, T);

test('B16 an unreachable remote is a GitError carrying stderr, with no rebase left', async () => {
  sh(agentDir, 'remote', 'set-url', 'origin', path.join(tmpDir(), 'no-such.git'));
  write(agentDir, 'mine.txt', 'mine\n');
  const err = (await syncRepo(agentDir, 'agent', 'mine').catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.stderr).toMatch(/does not appear to be a git repository|No such file|not found/i);
  expect(rebaseInProgress(agentDir)).toBe(false);
  await expect(pullRepo(agentDir, 'agent')).rejects.toBeInstanceOf(GitError);
  expect(rebaseInProgress(agentDir)).toBe(false);
}, T);

test('B16 a repo with no origin cannot sync: GitError, but local changes are committed and safe', async () => {
  const dir = path.join(tmpDir(), 'solo');
  await initPrivateRepo(dir, { identity });
  write(dir, 'notes.txt', 'x\n');
  await expect(syncRepo(dir, 'app', 'save')).rejects.toBeInstanceOf(GitError);
  expect(sh(dir, 'log', '-1', '--format=%s')).toBe('save\n');
  expect(rebaseInProgress(dir)).toBe(false);
}, T);

test('B16 a push refused for another reason is a GitError, not a silent pushed:false', async () => {
  hook(remote, 'pre-receive', 'echo "no thanks" >&2; exit 1');
  write(agentDir, 'mine.txt', 'mine\n');
  const err = (await syncRepo(agentDir, 'agent', 'mine').catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.stderr).toContain('no thanks');
  expect(rebaseInProgress(agentDir)).toBe(false);
}, T);

test('B16 credentials in a remote URL never appear in the error', async () => {
  const err = (await git(agentDir, ['ls-remote', 'http://user:hunter2@127.0.0.1:1/x.git']).catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(`${err.message}\n${err.stderr}\n${err.args.join(' ')}`).not.toContain('hunter2');
}, T);

test('B17 git.ts never forces, amends or rewrites history', () => {
  const src = fs.readFileSync(new URL('../src/git.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/--force|--force-with-lease|--amend|filter-branch|push\s+-f|'-f'/);
});

test('git() returns raw stdout and throws GitError with the exit code and stderr', async () => {
  expect(await git(appDir, ['log', '-1', '--format=%s'])).toBe('Initialize private data repo\n');
  const err = (await git(appDir, ['rev-parse', '--verify', 'nope']).catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.exitCode).toBe(128);
  expect(err.stderr).toContain('fatal');
}, T);

test('B19 a DataRepo temp file present during a sync is never committed or pushed, and stays on disk', async () => {
  const tmpFile = 'profile/points/p1.json.tmp-a1b2c3';
  write(appDir, tmpFile, '{"half":');
  write(appDir, 'profile/resumes/cv.pdf.tmp-0f9e8d', 'partial');
  write(appDir, 'notes.tmp-zzzzzz', 'not a DataRepo temp name\n'); // non-hex suffix: an ordinary file
  write(appDir, 'real.txt', 'real\n');
  const r = await syncRepo(appDir, 'app', 'mid-write');
  expect(r.pushed).toBe(true);
  const tree = sh(remote, 'ls-tree', '-r', '--name-only', 'main');
  expect(tree).toContain('real.txt');
  expect(tree).toContain('notes.tmp-zzzzzz');
  expect(tree).not.toContain('.tmp-a1b2c3');
  expect(tree).not.toContain('.tmp-0f9e8d');
  expect(sh(remote, 'log', '--all', '--name-only', '--format=')).not.toMatch(/\.tmp-[0-9a-f]{6}/);
  expect(read(appDir, tmpFile)).toBe('{"half":');
  expect(sh(appDir, 'diff', '--cached', '--name-only')).toBe('');
  expect(rebaseInProgress(appDir)).toBe(false);
}, T);

test('B19 a temp file alone is not a change, and pullRepo leaves it untouched too', async () => {
  const tmpFile = 'sources/s1.json.tmp-a1b2c3';
  write(agentDir, tmpFile, '{"half":');
  expect(await syncRepo(agentDir, 'agent', 'mid-write')).toMatchObject({ committed: null, pushed: true });
  expect(await pullRepo(agentDir, 'agent')).toMatchObject({ committed: null });
  expect(sh(remote, 'log', '--all', '--name-only', '--format=')).not.toContain('.tmp-');
  expect(read(agentDir, tmpFile)).toBe('{"half":');
}, T);


// ===========================================================================
// Fix 2 (rows S1-S16)
// ===========================================================================

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(20);
  }
}
/** Run `fn` with env vars set (undefined deletes), restoring them afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
/** A hostile or ambient global git config file; returns the env that points git at it. */
function globalConfig(text: string): Record<string, string> {
  const file = path.join(tmpDir(), 'gitconfig');
  fs.writeFileSync(file, text);
  return { GIT_CONFIG_GLOBAL: file };
}
/** Commit files straight through git (bypassing sync) and push them: another party, or a hand edit on the git host. */
function shipRaw(dir: string, files: Record<string, string>, msg: string): void {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, 'add', '-f', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
  sh(dir, 'push', '-q', 'origin', 'main');
}
const remoteTree = () => sh(remote, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'main');
const remoteHistory = () => sh(remote, 'log', '--all', '--name-only', '--format=');
const linux = process.platform === 'linux';

// --- S1: serialised calls --------------------------------------------------

test('S1 overlapping calls on one checkout run one after another and lose nothing', async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  write(appDir, 'a.txt', 'a1\n');
  const first = syncRepo(appDir, 'app', 'first', {
    beforePush: async () => {
      log.push('first-at-push');
      await gate;
      log.push('first-released');
    },
  });
  await waitFor(() => log.includes('first-at-push'));
  write(appDir, 'b.txt', 'b1\n');
  const second = syncRepo(appDir, 'app', 'second', { beforeIntegrate: async () => void log.push('second-started') });
  await sleep(400);
  expect(log).not.toContain('second-started');
  release();
  const [r1, r2] = await Promise.all([first, second]);
  expect(log.indexOf('second-started')).toBeGreaterThan(log.indexOf('first-released'));
  expect([r1.pushed, r2.pushed]).toEqual([true, true]);
  expect(remoteTree()).toContain('a.txt');
  expect(remoteTree()).toContain('b.txt');
  clean(appDir);
}, T);

test('S1 a live lock from another process makes the call throw SyncBusyError and touches nothing', async () => {
  const lock = path.join(appDir, '.git', 'cob-sync.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  write(appDir, 'a.txt', 'a\n');
  const head = sh(appDir, 'rev-parse', 'HEAD');
  await expect(syncRepo(appDir, 'app', 'x')).rejects.toBeInstanceOf(SyncBusyError);
  await expect(pullRepo(appDir, 'app')).rejects.toBeInstanceOf(SyncBusyError);
  expect(sh(appDir, 'rev-parse', 'HEAD')).toBe(head);
  expect(sh(appDir, 'status', '--porcelain')).toBe('?? a.txt\n');
  expect(fs.existsSync(lock)).toBe(true);
}, T);

test('S1 a stale lock (holder gone, or older than 10 minutes) is taken over, and the lock is released afterwards', async () => {
  const lock = path.join(appDir, '.git', 'cob-sync.lock');
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, at: Date.now() }));
  write(appDir, 'a.txt', 'a\n');
  expect((await syncRepo(appDir, 'app', 'one')).pushed).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: Date.now() - 11 * 60 * 1000 }));
  write(appDir, 'b.txt', 'b\n');
  expect((await syncRepo(appDir, 'app', 'two')).pushed).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
}, T);

test('S1 a failing call still releases its lock and its queue slot', async () => {
  sh(agentDir, 'remote', 'set-url', 'origin', path.join(tmpDir(), 'no-such.git'));
  await expect(syncRepo(agentDir, 'agent', 'x')).rejects.toBeInstanceOf(GitError);
  expect(fs.existsSync(path.join(agentDir, '.git', 'cob-sync.lock'))).toBe(false);
  sh(agentDir, 'remote', 'set-url', 'origin', remote);
  expect((await syncRepo(agentDir, 'agent', 'y')).pushed).toBe(true);
}, T);

// --- S2: files change during a sync; a killed sync left a rebase -------------

/** Leave agentDir stopped in a rebase with two unpushed commits (a conflict, then a new file). */
async function stuckRebase(): Promise<void> {
  write(appDir, 'notes.txt', 'app\n');
  await syncRepo(appDir, 'app', 'app notes');
  write(agentDir, 'notes.txt', 'agent\n');
  sh(agentDir, 'add', '-A');
  sh(agentDir, 'commit', '-q', '-m', 'agent notes');
  write(agentDir, 'late.txt', 'late local\n');
  sh(agentDir, 'add', '-A');
  sh(agentDir, 'commit', '-q', '-m', 'agent late');
  expect(() => sh(agentDir, 'pull', '--rebase', '--no-autostash', 'origin', 'main')).toThrow();
  expect(rebaseInProgress(agentDir)).toBe(true);
}

// S2's second half (a rebase left by a killed sync) is replaced by R13: the sync never starts a rebase, so one
// in progress is the user's own, and it is refused with every edit left exactly where it is.
test('S2 (amended by R13) edits made while a rebase is in progress stay exactly as they are; nothing is synced', async () => {
  await stuckRebase();
  write(agentDir, 'guide/lanes.json', '{"lanes":[{"id":"x","name":"Mine"}]}\n');
  write(agentDir, 'late.txt', 'late EDITED\n');
  write(agentDir, 'extra.txt', 'extra\n');
  fs.unlinkSync(path.join(agentDir, 'README.md'));
  await expectRefused(agentDir, 'agent', /A rebase/);
}, T);

test('S2 a file written while the sync runs is committed now or kept for the next sync, never lost', async () => {
  write(appDir, 'notes.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(agentDir, 'notes.txt', 'agent\n');
  await syncRepo(agentDir, 'agent', 'agent notes');
  write(appDir, 'notes.txt', 'app 1\n');
  const r = await syncRepo(appDir, 'app', 'app notes', {
    // The user saves again while the pull is about to change the same file.
    beforeIntegrate: async () => write(appDir, 'notes.txt', 'app 2 (written mid-sync)\n'),
  });
  expect(r.pushed).toBe(true);
  expect(read(appDir, 'notes.txt')).toBe('app 2 (written mid-sync)\n');
  expect(rebaseInProgress(appDir)).toBe(false);
  await syncRepo(appDir, 'app', 'next');
  expect(sh(remote, 'show', 'main:notes.txt')).toBe('app 2 (written mid-sync)\n');
  clean(appDir);
}, T);

// --- S3: the checkout is the one named, and only that one ------------------

test('S3 an inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE cannot redirect a sync', async () => {
  const other = tmpDir();
  sh(other, 'init', '-q', '-b', 'main');
  sh(other, 'config', 'user.name', 'o');
  sh(other, 'config', 'user.email', 'o@example.com');
  write(other, 'other.txt', 'other\n');
  sh(other, 'add', '-A');
  sh(other, 'commit', '-q', '-m', 'other');
  const otherHead = sh(other, 'rev-parse', 'HEAD');
  write(appDir, 'notes.txt', 'mine\n');
  const r = await withEnv(
    { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, '.git', 'index') },
    () => syncRepo(appDir, 'app', 'should stay in app'),
  );
  expect(r.pushed).toBe(true);
  expect(sh(other, 'rev-parse', 'HEAD')).toBe(otherHead);
  expect(sh(appDir, 'log', '-1', '--format=%s')).toBe('should stay in app\n');
  expect(remoteTree()).toContain('notes.txt');
}, T);

test('S3 a folder without .git inside another checkout is refused and the outer repo is untouched', async () => {
  const outer = tmpDir();
  const outerRemote = bare();
  sh(outer, 'init', '-q', '-b', 'main');
  sh(outer, 'config', 'user.name', 'o');
  sh(outer, 'config', 'user.email', 'o@example.com');
  write(outer, 'README.md', 'engine\n');
  sh(outer, 'add', '-A');
  sh(outer, 'commit', '-q', '-m', 'engine');
  sh(outer, 'remote', 'add', 'origin', outerRemote);
  sh(outer, 'push', '-q', '-u', 'origin', 'main');
  const inner = path.join(outer, 'data');
  write(inner, 'profile/transcripts/t1.json', '{}\n');
  const head = sh(outer, 'rev-parse', 'HEAD');
  await expect(syncRepo(inner, 'app', 'x')).rejects.toBeInstanceOf(GitError);
  await expect(pullRepo(inner, 'app')).rejects.toBeInstanceOf(GitError);
  expect(sh(outer, 'rev-parse', 'HEAD')).toBe(head);
  expect(sh(outer, 'diff', '--cached', '--name-only')).toBe('');
  expect(sh(outerRemote, 'rev-parse', 'main')).toBe(head);
}, T);

test('S3 cloneDataRepo checks that the clone is its own top-level repo', async () => {
  const dir = path.join(tmpDir(), 'c');
  await cloneDataRepo(remote, dir, identity);
  expect(fs.realpathSync(sh(dir, 'rev-parse', '--show-toplevel').trim())).toBe(fs.realpathSync(dir));
}, T);

// --- S4: hooks and ambient config cannot add files; unpushed commits are scanned -

test('S4 hooks, from the repo config or the global config, never run and never add files', async () => {
  const hooks = path.join(tmpDir(), 'hooks');
  fs.mkdirSync(hooks);
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push']) {
    fs.writeFileSync(path.join(hooks, name), '#!/bin/sh\necho hooked > hooked.txt\ngit add hooked.txt 2>/dev/null\nexit 0\n');
    fs.chmodSync(path.join(hooks, name), 0o755);
  }
  sh(appDir, 'config', 'core.hooksPath', hooks);
  write(appDir, 'notes.txt', 'x\n');
  await withEnv(globalConfig(`[core]\n\thooksPath = ${hooks}\n`), async () => {
    expect((await syncRepo(appDir, 'app', 'hooked?')).pushed).toBe(true);
  });
  expect(exists(appDir, 'hooked.txt')).toBe(false);
  expect(remoteTree()).not.toContain('hooked.txt');
}, T);

test('S4 a commit made outside sync is scanned before it is pushed', async () => {
  write(appDir, 'tmp/s.json', '{"sameSite":"Lax","httpOnly":true}');
  sh(appDir, 'add', '-f', '-A');
  sh(appDir, 'commit', '-q', '-m', 'outside');
  await expect(syncRepo(appDir, 'app', 'sync')).rejects.toBeInstanceOf(SecretLeakError);
  expect(remoteHistory()).not.toContain('tmp/s.json');
  // A secret that was committed and then removed in a later local commit is still in the pushed history.
  fs.unlinkSync(path.join(appDir, 'tmp/s.json'));
  sh(appDir, 'add', '-A');
  sh(appDir, 'commit', '-q', '-m', 'removed again');
  await expect(syncRepo(appDir, 'app', 'sync')).rejects.toBeInstanceOf(SecretLeakError);
  expect(remoteHistory()).not.toContain('tmp/s.json');
}, T);

test('S4 a path-pattern secret committed outside sync is refused too', async () => {
  write(appDir, 'profile/secret.txt', 'x');
  sh(appDir, 'add', '-f', '-A');
  sh(appDir, 'commit', '-q', '-m', 'outside');
  const err = (await syncRepo(appDir, 'app', 'sync').catch((e: unknown) => e)) as SecretLeakError;
  expect(err).toBeInstanceOf(SecretLeakError);
  expect(err.paths).toEqual(['profile/secret.txt']);
  expect(rebaseInProgress(appDir)).toBe(false);
}, T);

// --- S5: content guard at any size, UTF-16, byte-exact names ----------------

const COOKIE_JSON = '{"cookies":[{"name":"a","value":"b","sameSite":"Lax","httpOnly":true}]}';
const NETSCAPE = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc\n';

test('S5 cookie content in a 9 MiB file is refused', async () => {
  write(appDir, 'tmp/big.json', COOKIE_JSON + ' '.repeat(9 * 1024 * 1024));
  await expect(syncRepo(appDir, 'app', 'x')).rejects.toBeInstanceOf(SecretLeakError);
  expect(remoteHistory()).not.toContain('big.json');
}, T);

test('S5 the match works across chunk boundaries', async () => {
  for (const b of [4096, 65536, 1 << 20, 4 << 20]) {
    const pad = (n: number) => ' '.repeat(n);
    write(appDir, `tmp/ns-${b}.txt`, pad(b - 10) + NETSCAPE);
    write(appDir, `tmp/js-${b}.json`, pad(b - 4) + '"sameSite"' + pad(3 * b) + '"httpOnly"');
  }
  const err = (await syncRepo(appDir, 'app', 'x').catch((e: unknown) => e)) as SecretLeakError;
  expect(err).toBeInstanceOf(SecretLeakError);
  expect(err.paths).toHaveLength(8);
  expect(remoteHistory()).not.toMatch(/ns-|js-/);
}, T);

test('S5 UTF-16 (LE and BE, with a BOM) cookie JSON is refused', async () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"sameSite":"Lax","httpOnly":true}', 'utf16le')]);
  const be = Buffer.from(le);
  be.subarray(2).swap16();
  be[0] = 0xfe;
  be[1] = 0xff;
  fs.mkdirSync(path.join(appDir, 'notes'));
  fs.writeFileSync(path.join(appDir, 'notes/le.json'), le);
  fs.writeFileSync(path.join(appDir, 'notes/be.json'), be);
  const err = (await syncRepo(appDir, 'app', 'x').catch((e: unknown) => e)) as SecretLeakError;
  expect(err).toBeInstanceOf(SecretLeakError);
  expect([...err.paths].sort()).toEqual(['notes/be.json', 'notes/le.json']);
  expect(remoteHistory()).not.toMatch(/le\.json|be\.json/);
}, T);

test.runIf(linux)('S5 non-UTF-8 file names are handled byte for byte: refused when secret, synced when not', async () => {
  const name = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // "caf\xe9.txt" in Latin-1
  const file = Buffer.concat([Buffer.from(path.join(appDir, 'notes') + '/'), name]);
  fs.mkdirSync(path.join(appDir, 'notes'));
  fs.writeFileSync(file, NETSCAPE);
  await expect(syncRepo(appDir, 'app', 'x')).rejects.toBeInstanceOf(SecretLeakError);
  expect(remoteHistory()).not.toContain('caf');
  fs.writeFileSync(file, 'harmless\n');
  expect((await syncRepo(appDir, 'app', 'fine')).pushed).toBe(true);
  await pullRepo(agentDir, 'agent');
  expect(fs.readdirSync(path.join(agentDir, 'notes'), { encoding: 'buffer' }).some((n) => n.equals(name))).toBe(true);
  clean(agentDir);
}, T);

// --- S6/S7: deletions and tracked temp-like names --------------------------

test('S6 deleting a tracked secret-looking path is allowed and the deletion is pushed', async () => {
  shipRaw(agentDir, { 'profile/secret.txt': 'old\n' }, 'arrived from elsewhere');
  await pullRepo(appDir, 'app');
  fs.unlinkSync(path.join(appDir, 'profile/secret.txt'));
  write(appDir, 'other.txt', 'unrelated\n');
  expect((await syncRepo(appDir, 'app', 'tidy')).pushed).toBe(true);
  expect(remoteTree()).not.toContain('secret.txt');
  expect(remoteTree()).toContain('other.txt');
}, T);

test('S7 a tracked temp-named path is an ordinary tracked file: edits, deletes and renames are committed', async () => {
  shipRaw(agentDir, { 'sources/s1.json.tmp-a1b2c3': 'v1\n', 'sources/s2.json.tmp-a1b2c4': 'w1\n', 'sources/s3.json.tmp-a1b2c5': 'z1\n' }, 'old code');
  await pullRepo(appDir, 'app');
  write(appDir, 'sources/s1.json.tmp-a1b2c3', 'v2\n');
  fs.unlinkSync(path.join(appDir, 'sources/s2.json.tmp-a1b2c4'));
  fs.renameSync(path.join(appDir, 'sources/s3.json.tmp-a1b2c5'), path.join(appDir, 'sources/s3.moved'));
  write(appDir, 'real.txt', 'real\n');
  expect((await syncRepo(appDir, 'app', 'tidy')).pushed).toBe(true);
  expect(sh(remote, 'show', 'main:sources/s1.json.tmp-a1b2c3')).toBe('v2\n');
  expect(remoteTree()).not.toContain('s2.json.tmp-a1b2c4');
  expect(remoteTree()).not.toContain('s3.json.tmp-a1b2c5');
  expect(remoteTree()).toContain('s3.moved');
  expect(remoteTree()).toContain('real.txt');
  clean(appDir);
  expect((await syncRepo(appDir, 'app', 'again')).committed).toBeNull();
}, T);

// --- S8: the owner's whole file, no blending, no renames -------------------

test('S8 edits on different lines of one file: owner syncs second, the owner’s whole version wins', async () => {
  const a = sample.application({ id: 'a1', title: 'original' });
  agent.put('application', a);
  await syncRepo(agentDir, 'agent', 'add application');
  await pullRepo(appDir, 'app');
  writeJson(appDir, 'applications/a1.json', { ...a, title: 'hand edit' }); // line 4
  await syncRepo(appDir, 'app', 'hand edit');
  agent.put('application', { ...a, closedAt: T1_ISO }); // a line far below
  expect(await syncRepo(agentDir, 'agent', 'close')).toMatchObject({ pushed: true, resolved: ['applications/a1.json'] });
  expect(agent.get('application', 'a1')).toEqual({ ...a, closedAt: T1_ISO });
  clean(agentDir);
}, T);

test('S8 edits on different lines of one file: non-owner syncs second, the owner’s whole version stays', async () => {
  const a = sample.application({ id: 'a1', title: 'original' });
  agent.put('application', a);
  await syncRepo(agentDir, 'agent', 'add application');
  await pullRepo(appDir, 'app');
  agent.put('application', { ...a, closedAt: T1_ISO });
  await syncRepo(agentDir, 'agent', 'close');
  writeJson(appDir, 'applications/a1.json', { ...a, title: 'hand edit' });
  const r = await syncRepo(appDir, 'app', 'hand edit');
  expect(r).toMatchObject({ pushed: true, resolved: ['applications/a1.json'] });
  expect(app.get('application', 'a1')).toEqual({ ...a, closedAt: T1_ISO });
  expect(sh(appDir, 'log', '-1', '--format=%s')).toBe('close\n');
  clean(appDir);
}, T);

test('S8 a hand edit is never moved into a different record by rename detection', async () => {
  const s = await sharedSource();
  app.delete('source', 's1');
  app.put('source', { ...s, id: 's2' });
  await syncRepo(appDir, 'app', 'replace s1 by s2');
  writeJson(agentDir, 'sources/s1.json', { ...s, label: 'hand edit' });
  const r = await syncRepo(agentDir, 'agent', 'hand edit');
  expect(r).toMatchObject({ pushed: true, resolved: ['sources/s1.json'] });
  expect(exists(agentDir, 'sources/s1.json')).toBe(false);
  expect(agent.get('source', 's2')).toEqual({ ...s, id: 's2' });
  clean(agentDir);
}, T);

// --- S9: file/folder clash and other conflicts the rule cannot settle --------

test('S9 a file on one side and a folder of the same name on the other: GitError, nothing pushed, nothing lost', async () => {
  write(appDir, 'notes.txt', 'app file\n');
  await syncRepo(appDir, 'app', 'app notes');
  const remoteHead = sh(remote, 'rev-parse', 'main');
  write(agentDir, 'notes.txt/inside.txt', 'dir\n'); // the agent never saw the app's file
  const err = (await syncRepo(agentDir, 'agent', 'agent folder').catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.message).toContain('notes.txt');
  expect(rebaseInProgress(agentDir)).toBe(false);
  expect(sh(remote, 'rev-parse', 'main')).toBe(remoteHead);
  expect(sh(remote, 'show', 'main:notes.txt')).toBe('app file\n');
  expect(remoteTree()).not.toContain('inside.txt');
  expect(sh(agentDir, 'log', '--format=%s', '-1')).toBe('agent folder\n'); // the local commit is kept
  expect(read(agentDir, 'notes.txt/inside.txt')).toBe('dir\n');
  clean(agentDir);
}, T);

test('S9 replacing a file by a folder is fine when nobody else touched the file', async () => {
  write(appDir, 'notes.txt', 'app file\n');
  await syncRepo(appDir, 'app', 'app notes');
  await pullRepo(agentDir, 'agent');
  fs.unlinkSync(path.join(agentDir, 'notes.txt'));
  write(agentDir, 'notes.txt/inside.txt', 'dir\n');
  write(appDir, 'x.txt', 'x\n');
  await syncRepo(appDir, 'app', 'other change');
  expect(await syncRepo(agentDir, 'agent', 'agent folder')).toMatchObject({ pushed: true, resolved: [] });
  expect(sh(remote, 'show', 'main:notes.txt/inside.txt')).toBe('dir\n');
}, T);

test('S9 the other order: the owner’s file stays at its path and the clash is an error', async () => {
  write(agentDir, 'notes.txt/inside.txt', 'dir\n');
  await syncRepo(agentDir, 'agent', 'agent folder');
  write(appDir, 'notes.txt', 'app edit\n');
  const err = (await syncRepo(appDir, 'app', 'app file').catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.message).toContain('notes.txt');
  expect(rebaseInProgress(appDir)).toBe(false);
  expect(read(appDir, 'notes.txt')).toBe('app edit\n');
  expect(remoteTree()).not.toMatch(/notes\.txt~/);
  expect(remoteTree()).toContain('notes.txt/inside.txt');
  expect(sh(appDir, 'log', '-1', '--format=%s')).toBe('app file\n');
}, T);

test('S9 many local commits replay without any round limit', async () => {
  write(appDir, 'notes.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(appDir, 'notes.txt', 'upstream\n');
  await syncRepo(appDir, 'app', 'upstream');
  for (let i = 1; i <= 60; i++) {
    write(agentDir, 'notes.txt', `local ${i}\n`);
    write(agentDir, `f${i}.txt`, `${i}\n`);
    sh(agentDir, 'add', '-A');
    sh(agentDir, 'commit', '-q', '-m', `local ${i}`);
  }
  const r = await syncRepo(agentDir, 'agent', 'unused');
  expect(r).toMatchObject({ pushed: true, resolved: ['notes.txt'] });
  expect(read(agentDir, 'notes.txt')).toBe('upstream\n');
  expect(read(agentDir, 'f60.txt')).toBe('60\n');
  clean(agentDir);
}, T);

// --- S10: only the repo's own .gitignore decides what is staged -------------

test('S10 a global gitignore and info/exclude do not hide layout paths', async () => {
  const ignoreFile = path.join(tmpDir(), 'ignore');
  fs.writeFileSync(ignoreFile, 'log/\n');
  fs.appendFileSync(path.join(agentDir, '.git', 'info', 'exclude'), 'roles/\n');
  agent.put('dayLog', sample.dayLog());
  upsertRole(agent, roleInput());
  await withEnv(globalConfig(`[core]\n\texcludesFile = ${ignoreFile}\n`), async () => {
    expect((await syncRepo(agentDir, 'agent', 'logs')).pushed).toBe(true);
  });
  expect(remoteTree()).toContain('guide/log/2026-11-11.json');
  expect(remoteTree()).toMatch(/roles\/.+\.json/);
  // The repo's own .gitignore still applies.
  write(agentDir, 'cookies/a.json', 'x');
  expect((await syncRepo(agentDir, 'agent', 'again')).committed).toBeNull();
  expect(remoteTree()).not.toContain('cookies/');
}, T);

// --- S11: only branch main ---------------------------------------------------

test('S11 on another branch or a detached HEAD: GitError, nothing pushed, never pushed:true', async () => {
  const before = sh(remote, 'rev-parse', 'main');
  sh(appDir, 'checkout', '-q', '-b', 'other');
  write(appDir, 'a.txt', 'a\n');
  await expect(syncRepo(appDir, 'app', 'x')).rejects.toBeInstanceOf(GitError);
  await expect(pullRepo(appDir, 'app')).rejects.toBeInstanceOf(GitError);
  sh(appDir, 'checkout', '-q', '--detach');
  await expect(syncRepo(appDir, 'app', 'x')).rejects.toBeInstanceOf(GitError);
  expect(sh(remote, 'rev-parse', 'main')).toBe(before);
  expect(exists(appDir, 'a.txt')).toBe(true);
}, T);

// --- S12: only an exhausted non-fast-forward gives pushed:false ------------------

test('S12 a lock failure on the remote is a GitError after the retries, not pushed:false', async () => {
  fs.writeFileSync(path.join(remote, 'refs/heads/main.lock'), '');
  write(agentDir, 'mine.txt', 'mine\n');
  const err = (await syncRepo(agentDir, 'agent', 'mine').catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.stderr).toMatch(/lock/);
  expect(rebaseInProgress(agentDir)).toBe(false);
  fs.unlinkSync(path.join(remote, 'refs/heads/main.lock'));
  expect((await syncRepo(agentDir, 'agent', 'retry')).pushed).toBe(true);
}, T);

// --- S13: big sets, no contents in errors -------------------------------------

test('S13 GitError never carries file contents', async () => {
  write(appDir, 'secretish-body.txt', 'THE-FILE-BODY-12345\n');
  write(appDir, 'other-body.txt', 'DIFFERENT-BODY-67890\n');
  const err = (await git(appDir, ['diff', '--no-index', '--exit-code', 'secretish-body.txt', 'other-body.txt']).catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(`${err.message}\n${err.stderr}\n${err.args.join(' ')}`).not.toMatch(/THE-FILE-BODY|DIFFERENT-BODY/);
}, T);

test('S13 more than 256 MiB staged at once syncs', async () => {
  try {
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(appDir, `blob-${i}.bin`), Buffer.alloc(7 * 1024 * 1024, i + 1));
    expect((await syncRepo(appDir, 'app', 'big')).pushed).toBe(true);
    expect(remoteTree()).toContain('blob-39.bin');
  } finally {
    // R11: 280 MiB of files and the repos holding them go now, even when the test fails.
    for (const d of [appDir, agentDir, path.dirname(remote)]) fs.rmSync(d, { recursive: true, force: true });
  }
}, 120_000);

// --- S14: init --------------------------------------------------------------

test('S14 a failed first push can be retried on the same folder', async () => {
  const r2 = bare();
  hook(r2, 'pre-receive', 'echo "not yet" >&2; exit 1');
  const dir = path.join(tmpDir(), 'init');
  await expect(initPrivateRepo(dir, { identity, remote: r2 })).rejects.toBeInstanceOf(GitError);
  fs.unlinkSync(path.join(r2, 'hooks', 'pre-receive'));
  await initPrivateRepo(dir, { identity, remote: r2 });
  expect(sh(r2, 'rev-parse', 'main')).toBe(sh(dir, 'rev-parse', 'HEAD'));
  expect(sh(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  expect(sh(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/main');
  // Retrying again once it is done is harmless.
  await initPrivateRepo(dir, { identity, remote: r2 });
}, T);

test('S14 a remote that starts with a dash is refused and never read as an option', async () => {
  const marker = path.join(tmpDir(), 'ran');
  const dir = path.join(tmpDir(), 'init');
  await expect(initPrivateRepo(dir, { identity, remote: `--upload-pack=touch ${marker};` })).rejects.toBeInstanceOf(GitError);
  await expect(cloneDataRepo(`--upload-pack=touch ${marker};`, path.join(tmpDir(), 'c'), identity)).rejects.toBeInstanceOf(GitError);
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(dir)).toBe(false);
}, T);

test('S14 a pre-existing repository that init did not create is refused and not modified', async () => {
  const dir = tmpDir();
  sh(dir, 'init', '-q', '-b', 'master');
  await expect(initPrivateRepo(dir, { identity })).rejects.toBeInstanceOf(GitError);
  expect(fs.readdirSync(dir)).toEqual(['.git']);
  expect(fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/master\n');
  const d2 = tmpDir();
  sh(d2, 'init', '-q', '-b', 'main');
  sh(d2, 'config', 'user.name', 'x');
  sh(d2, 'config', 'user.email', 'x@example.com');
  write(d2, 'mine.txt', 'x\n');
  sh(d2, 'add', '-A');
  sh(d2, 'commit', '-q', '-m', 'mine');
  await expect(initPrivateRepo(d2, { identity })).rejects.toBeInstanceOf(GitError);
  expect(sh(d2, 'log', '--format=%s')).toBe('mine\n');
}, T);

// --- S15: credentials -----------------------------------------------------------

test('S15 a password containing @ leaves no part of the userinfo in message, stderr or args', async () => {
  const err = (await git(agentDir, ['ls-remote', 'http://user:p@ssword@127.0.0.1:1/x.git']).catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  const all = `${err.message}\n${err.stderr}\n${err.args.join(' ')}`;
  for (const part of ['p@ssword', 'ssword', 'user:']) expect(all).not.toContain(part);
}, T);

// --- S16: tests that catch weakened guards ------------------------------------------

test('S16 a remote that moves before the push is never overwritten, and the non-fast-forward is retried', async () => {
  const third = thirdClone();
  let n = 0;
  const advance = async () => {
    n++;
    sh(third, 'pull', '-q', '--no-rebase', 'origin', 'main');
    write(third, `third-${n}.txt`, `${n}\n`);
    sh(third, 'add', '-A');
    sh(third, 'commit', '-q', '-m', `third ${n}`);
    sh(third, 'push', '-q', 'origin', 'main');
  };
  write(agentDir, 'mine.txt', 'mine\n');
  let first = true;
  const r = await syncRepo(agentDir, 'agent', 'mine', {
    beforePush: async () => {
      if (first) await advance();
      first = false;
    },
  });
  expect(r.pushed).toBe(true);
  expect(n).toBe(1);
  expect(sh(remote, 'log', '--format=%s')).toContain('third 1');
  expect(sh(remote, 'log', '--format=%s')).toContain('mine');
  // A beaten last attempt gives pushed:false and the other side's commit is still there.
  write(agentDir, 'mine2.txt', 'mine\n');
  const r2 = await syncRepo(agentDir, 'agent', 'mine2', { maxAttempts: 1, beforePush: advance });
  expect(r2.pushed).toBe(false);
  expect(sh(remote, 'log', '--format=%s')).toContain('third 2');
  expect(sh(remote, 'log', '--format=%s')).not.toContain('mine2');
  expect((await syncRepo(agentDir, 'agent', 'again')).pushed).toBe(true);
  expect(sh(remote, 'log', '--format=%s')).toContain('mine2');
}, T);

test('S16 glob characters in a path name are literal (an ignored decoy must not be matched)', async () => {
  write(appDir, '.gitignore', fs.readFileSync(path.join(appDir, '.gitignore'), 'utf8') + 'rxa.txt\n');
  await syncRepo(appDir, 'app', 'ignore decoy');
  write(appDir, 'rx*.txt', 'star\n');
  write(appDir, 'rxa.txt', 'decoy\n');
  write(appDir, 'we ird[1].txt', 'brackets\n');
  expect((await syncRepo(appDir, 'app', 'globs')).pushed).toBe(true);
  expect(remoteTree()).toContain('rx*.txt');
  expect(remoteTree()).not.toContain('rxa.txt');
  expect(remoteTree()).toContain('we ird[1].txt');
}, T);

test('S16 hostile user-level git config does not change what sync does', async () => {
  const hooks = path.join(tmpDir(), 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
  const ignoreFile = path.join(tmpDir(), 'ignore');
  fs.writeFileSync(ignoreFile, '*.json\n');
  const cfg = globalConfig(
    `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n[core]\n\thooksPath = ${hooks}\n\tquotePath = true\n\texcludesFile = ${ignoreFile}\n` +
      '[pull]\n\trebase = false\n\tff = only\n[rebase]\n\tautoStash = true\n[push]\n\tdefault = nothing\n',
  );
  await withEnv(cfg, async () => {
    write(appDir, 'sources/s1.json', '{}\n');
    write(appDir, 'notes/Résumé.txt', 'x\n');
    write(agentDir, 'other.txt', 'o\n');
    await syncRepo(agentDir, 'agent', 'agent');
    expect((await syncRepo(appDir, 'app', 'app')).pushed).toBe(true);
  });
  expect(remoteTree()).toContain('sources/s1.json');
  expect(remoteTree()).toContain('notes/Résumé.txt');
  expect(remoteTree()).toContain('other.txt');
}, T);

test('S16 unstaging a secret treats glob characters in its name literally (a staged decoy must stay staged)', () => {
  write(appDir, 'n*tes.json', COOKIE_JSON);
  write(appDir, 'notes.json', '{}\n');
  sh(appDir, 'add', '-f', '-A');
  expect(() => assertNoSecrets(appDir, ['n*tes.json'])).toThrow(SecretLeakError);
  expect(sh(appDir, 'diff', '--cached', '--name-only')).toBe('notes.json\n');
});

// ===========================================================================
// cob-d2 (rows R1-R11)
// ===========================================================================

// --- R2/R3: init resumes only its own repo, and every push is scanned -----------------

test('R2 a one-commit repo with the init message that init did not create is refused and not changed', async () => {
  const dir = tmpDir();
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Someone');
  sh(dir, 'config', 'user.email', 'someone@example.com');
  write(dir, 'notes/export.txt', NETSCAPE);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'Initialize private data repo');
  const r2 = bare();
  const head = sh(dir, 'rev-parse', 'HEAD');
  await expect(initPrivateRepo(dir, { identity, remote: r2 })).rejects.toBeInstanceOf(GitError);
  expect(sh(dir, 'config', 'user.name').trim()).toBe('Someone');
  expect(sh(dir, 'remote')).toBe('');
  expect(sh(dir, 'rev-parse', 'HEAD')).toBe(head);
  expect(sh(r2, 'for-each-ref')).toBe('');
}, T);

/** Init against a remote that refuses the first push; returns the folder and the remote. */
async function failedInit(): Promise<{ dir: string; r2: string }> {
  const r2 = bare();
  hook(r2, 'pre-receive', 'echo "not yet" >&2; exit 1');
  const dir = path.join(tmpDir(), 'init');
  await expect(initPrivateRepo(dir, { identity, remote: r2 })).rejects.toBeInstanceOf(GitError);
  return { dir, r2 };
}

test('R2 a resumed init finishes the first push even after more commits were made', async () => {
  const { dir, r2 } = await failedInit();
  new DataRepo(dir, 'app').put('source', sample.source({ id: 's1' }));
  await expect(syncRepo(dir, 'app', 'add source')).rejects.toBeInstanceOf(GitError); // still refused
  write(dir, 'notes.txt', 'later\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'by hand');
  fs.unlinkSync(path.join(r2, 'hooks', 'pre-receive'));
  await initPrivateRepo(dir, { identity, remote: r2 });
  expect(sh(r2, 'rev-parse', 'main')).toBe(sh(dir, 'rev-parse', 'HEAD'));
  expect(sh(dir, 'rev-list', '--count', 'HEAD').trim()).toBe('3');
  expect(sh(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/main');
  await initPrivateRepo(dir, { identity, remote: r2 }); // done already: harmless
}, T);

test('R2 syncRepo makes the first push of a repo whose upstream was never pushed', async () => {
  const { dir, r2 } = await failedInit();
  fs.unlinkSync(path.join(r2, 'hooks', 'pre-receive'));
  write(dir, 'notes.txt', 'first\n');
  const r = await syncRepo(dir, 'app', 'first sync');
  expect(r).toMatchObject({ pushed: true, resolved: [] });
  expect(sh(r2, 'rev-parse', 'main')).toBe(sh(dir, 'rev-parse', 'HEAD'));
  expect(sh(r2, 'log', '--format=%s', 'main')).toBe('first sync\nInitialize private data repo\n');
  expect(await pullRepo(dir, 'app')).toMatchObject({ committed: null, pushed: false });
}, T);

test('R2 a call killed before the init commit is resumed: the marker proves the folder is ours', async () => {
  // Killed right after writing the marker: .git holds only the marker.
  const d1 = path.join(tmpDir(), 'a');
  fs.mkdirSync(path.join(d1, '.git'), { recursive: true });
  fs.writeFileSync(path.join(d1, '.git', 'cob-init.json'), '{"app":"company-of-bots","commit":null}\n');
  await initPrivateRepo(d1, { identity });
  expect(sh(d1, 'log', '--format=%s')).toBe('Initialize private data repo\n');
  // Killed while writing the layout: git init ran, and only cob.json was written.
  const d2 = path.join(tmpDir(), 'b');
  fs.mkdirSync(path.join(d2, '.git'), { recursive: true });
  fs.writeFileSync(path.join(d2, '.git', 'cob-init.json'), '{"app":"company-of-bots","commit":null}\n');
  sh(d2, 'init', '-q', '-b', 'main');
  write(d2, 'cob.json', '{"schemaVersion":1,"createdAt":"2026-11-11T09:00:00.000Z"}\n');
  await initPrivateRepo(d2, { identity });
  expect(sh(d2, 'log', '--format=%s')).toBe('Initialize private data repo\n');
  expect(new DataRepo(d2, 'app').getSingleton('lanes')).not.toBeNull();
  expect(sh(d2, 'status', '--porcelain')).toBe('');
  // An unborn repo without the marker is someone else's.
  const d3 = tmpDir();
  sh(d3, 'init', '-q', '-b', 'main');
  await expect(initPrivateRepo(d3, { identity })).rejects.toBeInstanceOf(GitError);
  expect(fs.readdirSync(d3)).toEqual(['.git']);
}, T);

test('R3 the init retry scans every commit it pushes: a cookie body is refused and never on the remote', async () => {
  const { dir, r2 } = await failedInit();
  write(dir, 'notes/export.txt', NETSCAPE);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'outside');
  fs.unlinkSync(path.join(r2, 'hooks', 'pre-receive'));
  const err = (await initPrivateRepo(dir, { identity, remote: r2 }).catch((e: unknown) => e)) as SecretLeakError;
  expect(err).toBeInstanceOf(SecretLeakError);
  expect(err.paths).toEqual(['notes/export.txt']);
  expect(sh(r2, 'for-each-ref')).toBe('');
  // syncRepo's first push is scanned from the empty tree as well.
  await expect(syncRepo(dir, 'app', 'x')).rejects.toBeInstanceOf(SecretLeakError);
  expect(sh(r2, 'for-each-ref')).toBe('');
}, T);

// --- R4: a UTF-16 BOM in front of ASCII cookie text -----------------------------------

test('R4 ASCII cookie text after a UTF-16 BOM is refused (raw bytes and decoded text are both searched)', async () => {
  const files: Record<string, Buffer> = {
    'notes/le-prefix.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(NETSCAPE)]),
    'notes/be-prefix.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(NETSCAPE)]),
    'notes/le-prefix.json': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"sameSite":"Lax","httpOnly":true}')]),
  };
  fs.mkdirSync(path.join(appDir, 'notes'));
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(appDir, rel), body);
  const err = (await syncRepo(appDir, 'app', 'x').catch((e: unknown) => e)) as SecretLeakError;
  expect(err).toBeInstanceOf(SecretLeakError);
  expect([...err.paths].sort()).toEqual(Object.keys(files).sort());
  expect(remoteHistory()).not.toContain('prefix');
}, T);

// --- R5: the remote's history wins for anything already pushed --------------------------

/** On the git host, drop the remote's last commit (a force push from a third clone). */
function rewindRemote(): void {
  const third = thirdClone();
  sh(third, 'reset', '-q', '--hard', 'HEAD~1');
  sh(third, 'push', '-q', '--force', 'origin', 'main');
}

test('R5 a commit removed on the git host is not pushed back, with or without new local commits', async () => {
  write(appDir, 'notes/transcript.txt', 'private\n');
  await syncRepo(appDir, 'app', 'transcript');
  await pullRepo(agentDir, 'agent');
  rewindRemote();
  // Nothing new on the agent: it follows the remote.
  expect(await syncRepo(agentDir, 'agent', 'noop')).toMatchObject({ committed: null, pushed: true });
  expect(remoteHistory()).not.toContain('transcript');
  expect(exists(agentDir, 'notes/transcript.txt')).toBe(false);
  expect(sh(agentDir, 'rev-parse', 'HEAD')).toBe(sh(remote, 'rev-parse', 'main'));
  // A new local commit on the app, which still has the removed commit: only the new commit goes out.
  write(appDir, 'new.txt', 'new\n');
  const r = await syncRepo(appDir, 'app', 'new');
  expect(r.pushed).toBe(true);
  expect(remoteHistory()).not.toContain('transcript');
  expect(remoteTree()).toContain('new.txt');
  expect(exists(appDir, 'notes/transcript.txt')).toBe(false);
  clean(appDir);
}, T);

test('R5 pullRepo follows the rewrite too', async () => {
  write(appDir, 'notes/transcript.txt', 'private\n');
  await syncRepo(appDir, 'app', 'transcript');
  await pullRepo(agentDir, 'agent');
  rewindRemote();
  await pullRepo(agentDir, 'agent');
  expect(sh(agentDir, 'rev-parse', 'HEAD')).toBe(sh(remote, 'rev-parse', 'main'));
  expect(exists(agentDir, 'notes/transcript.txt')).toBe(false);
}, T);

test('R5 a scrubbed cookie commit does not block the other checkout', async () => {
  shipRaw(appDir, { 'tmp/s.json': COOKIE_JSON }, 'leaked by hand');
  await pullRepo(agentDir, 'agent');
  rewindRemote();
  write(agentDir, 'work.txt', 'agent work\n');
  expect((await syncRepo(agentDir, 'agent', 'work')).pushed).toBe(true);
  expect(remoteHistory()).not.toContain('tmp/s.json');
  expect(remoteTree()).toContain('work.txt');
}, T);

// --- R6/R8: files changed mid-sync ---------------------------------------------------------

test('R6 a file deleted mid-sync that the incoming change touches stays deleted, and the deletion is committed', async () => {
  write(appDir, 'notes.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(agentDir, 'notes.txt', 'agent edit\n');
  await syncRepo(agentDir, 'agent', 'agent edit');
  write(appDir, 'other.txt', 'x\n');
  let once = true;
  const r = await syncRepo(appDir, 'app', 'app', {
    beforeIntegrate: async () => {
      if (once) fs.unlinkSync(path.join(appDir, 'notes.txt'));
      once = false;
    },
  });
  expect(r).toMatchObject({ pushed: true, resolved: ['notes.txt'] }); // the app owns it: its delete wins
  expect(exists(appDir, 'notes.txt')).toBe(false);
  expect(remoteTree()).not.toMatch(/^notes\.txt$/m);
  clean(appDir);
}, T);

test('R8 a file rewritten with identical bytes mid-sync is not an error', async () => {
  write(appDir, 'notes.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(agentDir, 'notes.txt', 'agent edit\n');
  await syncRepo(agentDir, 'agent', 'agent edit');
  write(appDir, 'other.txt', 'x\n');
  const r = await syncRepo(appDir, 'app', 'app', {
    beforeIntegrate: async () => {
      const file = path.join(appDir, 'notes.txt');
      const body = fs.readFileSync(file);
      fs.unlinkSync(file); // a new inode and new times, same bytes
      fs.writeFileSync(file, body);
    },
  });
  expect(r.pushed).toBe(true);
  expect(read(appDir, 'notes.txt')).toBe('agent edit\n');
  clean(appDir);
}, T);

// --- R7: the lock belongs to one acquisition -------------------------------------------------

const sharedState = () =>
  (globalThis as Record<symbol, unknown>)[Symbol.for('company-of-bots.core.git.sync-state.v1')] as {
    held: Map<string, string>;
  };

test('R7 a live lock held by another copy of the module in this process is never taken over', async () => {
  const lock = path.join(sh(appDir, 'rev-parse', '--absolute-git-dir').trim(), 'cob-sync.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'held-by-another-copy' }));
  sharedState().held.set(lock, 'held-by-another-copy');
  write(appDir, 'a.txt', 'a\n');
  try {
    await expect(syncRepo(appDir, 'app', 'x')).rejects.toBeInstanceOf(SyncBusyError);
    expect(fs.readFileSync(lock, 'utf8')).toContain('held-by-another-copy');
    expect(sh(appDir, 'status', '--porcelain')).toBe('?? a.txt\n');
  } finally {
    sharedState().held.delete(lock);
  }
  // Same pid, but no acquisition in this process holds that token (an earlier process): stale, taken over.
  expect((await syncRepo(appDir, 'app', 'x')).pushed).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
}, T);

test('R7 two copies of the module in one process run calls on one checkout one after another', async () => {
  const spec = '../src/git.ts?second-copy';
  const copy = (await import(/* @vite-ignore */ spec)) as typeof import('../src/git.ts');
  expect(copy.syncRepo).not.toBe(syncRepo);
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  write(appDir, 'a.txt', 'a\n');
  const first = syncRepo(appDir, 'app', 'first', {
    beforePush: async () => {
      log.push('first-at-push');
      await gate;
    },
  });
  await waitFor(() => log.includes('first-at-push'));
  write(appDir, 'b.txt', 'b\n');
  const second = copy.syncRepo(appDir, 'app', 'second', { beforeIntegrate: async () => void log.push('second-started') });
  await sleep(300);
  expect(log).not.toContain('second-started');
  release();
  const [r1, r2] = await Promise.all([first, second]);
  expect([r1.pushed, r2.pushed]).toEqual([true, true]);
  expect(remoteTree()).toContain('b.txt');
}, T);

// --- R9: a missing folder ---------------------------------------------------------------------

test('R9 a folder that does not exist is a GitError', async () => {
  const missing = path.join(tmpDir(), 'nope');
  await expect(syncRepo(missing, 'app', 'x')).rejects.toBeInstanceOf(GitError);
  await expect(pullRepo(missing, 'app')).rejects.toBeInstanceOf(GitError);
}, T);

// --- R10: tests that catch weakened guards ----------------------------------------------------

test('R10 a cookie needle split by the scanner’s 1 MiB read boundary is still found', () => {
  // One staged blob is scanned from `<sha> blob <size>\n<content>`; the read boundary is at 1 MiB of that.
  const size = 1_310_720;
  const header = 40 + ' blob '.length + String(size).length + 1;
  const boundary = 1024 * 1024 - header; // offset in the content where one read ends
  const cases: { name: string; body: (at: number) => Buffer; needle: number }[] = [
    { name: 'ns', needle: NETSCAPE.length, body: (at) => Buffer.from(' '.repeat(at) + NETSCAPE) },
    { name: 'js', needle: 10, body: (at) => Buffer.from('"httpOnly"' + ' '.repeat(at - 10) + '"sameSite"') },
    {
      name: 'u16',
      needle: 54,
      body: (at) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(' '.repeat((at - 2) / 2) + '# Netscape HTTP Cookie File', 'utf16le')]),
    },
  ];
  for (const c of cases) {
    for (const split of [1, 7, c.needle - 1]) {
      let at = boundary - split;
      if (c.name === 'u16' && at % 2 === 1) at -= 1; // keep the UTF-16 text aligned; the split moves by one byte
      const body = c.body(at);
      const rel = `pad/${c.name}-${split}.txt`;
      fs.mkdirSync(path.join(appDir, 'pad'), { recursive: true });
      fs.writeFileSync(path.join(appDir, rel), Buffer.concat([body, Buffer.alloc(size - body.length, 0x20)]));
      sh(appDir, 'add', '-f', '--', rel);
      expect(() => assertNoSecrets(appDir, [rel]), rel).toThrow(SecretLeakError);
      fs.unlinkSync(path.join(appDir, rel));
    }
  }
}, T);

test('R10 a file the incoming change touches, written mid-sync, makes the sync commit it and integrate again', async () => {
  write(appDir, 'x.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(agentDir, 'x.txt', 'agent\n');
  await syncRepo(agentDir, 'agent', 'agent x');
  let calls = 0;
  const r = await syncRepo(appDir, 'app', 'app x', {
    beforeIntegrate: async () => {
      calls++;
      if (calls === 1) write(appDir, 'x.txt', 'app, written mid-sync\n');
    },
  });
  expect(calls).toBe(2); // busy once, then committed and integrated again
  expect(r).toMatchObject({ pushed: true, resolved: ['x.txt'] });
  expect(remoteFile('x.txt')).toBe('app, written mid-sync\n');
  clean(appDir);
}, T);

// ===========================================================================
// cob-d2 fix 1 (rows R13-R22)
// ===========================================================================

const remoteFile = (rel: string) => sh(remote, 'show', `main:${rel}`);
/** Run git with extra env; never throws (a stopped operation exits non-zero). */
function shTry(cwd: string, env: Record<string, string>, ...args: string[]): void {
  try {
    execFileSync('git', args, { cwd, env: { ...process.env, GIT_EDITOR: 'true', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // stopped on a conflict, as intended
  }
}

const STATE_MARKS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'MERGE_MSG', 'AUTO_MERGE', 'REBASE_HEAD', 'ORIG_HEAD'];

/** Everything R13 says must not change: HEAD, main, the tracking ref, the index, the operation's state, every file. */
function snapshot(dir: string) {
  const gitDir = sh(dir, 'rev-parse', '--absolute-git-dir').trim();
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      if (!rel && name === '.git') continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else files[r] = fs.readFileSync(path.join(dir, r)).toString('base64');
    }
  };
  walk('');
  const state: Record<string, string> = {};
  for (const m of STATE_MARKS) {
    const p = path.join(gitDir, m);
    if (!fs.existsSync(p)) continue;
    if (!fs.statSync(p).isDirectory()) state[m] = fs.readFileSync(p, 'base64');
    else {
      for (const n of fs.readdirSync(p, { recursive: true }) as string[]) {
        if (fs.statSync(path.join(p, n)).isFile()) state[`${m}/${n}`] = fs.readFileSync(path.join(p, n), 'base64');
      }
    }
  }
  return {
    head: fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'),
    refs: sh(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    index: fs.existsSync(path.join(gitDir, 'index')) ? fs.readFileSync(path.join(gitDir, 'index')).toString('base64') : null,
    config: fs.readFileSync(path.join(gitDir, 'config'), 'utf8'),
    state,
    files,
  };
}

/**
 * R13: syncRepo and pullRepo throw GitError naming the operation and how to finish or abort it; nothing is
 * fetched (the remote is moved first, and the tracking ref must not follow), committed or pushed, and the
 * checkout is byte for byte as it was.
 */
async function expectRefused(dir: string, writer: 'app' | 'agent', name: RegExp, how: RegExp = /--abort/): Promise<void> {
  const other = dir === appDir ? agentDir : appDir;
  write(other, `moved-${Date.now()}.txt`, 'the remote moved\n');
  await syncRepo(other, writer === 'app' ? 'agent' : 'app', 'remote moves on');
  const before = snapshot(dir);
  const remoteBefore = sh(remote, 'for-each-ref');
  for (const call of [() => syncRepo(dir, writer, 'sync'), () => pullRepo(dir, writer)]) {
    const err = (await call().catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(name);
    expect(err.message).toMatch(how);
  }
  expect(snapshot(dir)).toEqual(before);
  expect(sh(remote, 'for-each-ref')).toBe(remoteBefore);
}

/** The agent pushed notes.txt = AGENT-SIDE; the app has an unpushed commit notes.txt = APP-SIDE and has fetched. */
async function conflictPair(): Promise<void> {
  write(agentDir, 'notes.txt', 'AGENT-SIDE\n');
  await syncRepo(agentDir, 'agent', 'agent side');
  write(appDir, 'notes.txt', 'APP-SIDE\n');
  sh(appDir, 'add', '-A');
  sh(appDir, 'commit', '-q', '-m', 'app side');
  sh(appDir, 'fetch', '-q', 'origin');
}

// --- R13: an operation the user started is refused and left alone -------------------------------------

test('R13 a hand resolution equal to the other side, staged or not, is refused and left as it is', async () => {
  await conflictPair();
  shTry(appDir, {}, 'rebase', 'origin/main');
  expect(rebaseInProgress(appDir)).toBe(true);
  write(appDir, 'notes.txt', 'AGENT-SIDE\n'); // exactly stage 2 / the detached HEAD's version, not staged
  await expectRefused(appDir, 'app', /A rebase/);
  sh(appDir, 'add', 'notes.txt'); // now staged too
  await expectRefused(appDir, 'app', /A rebase/);
  expect(read(appDir, 'notes.txt')).toBe('AGENT-SIDE\n');
  expect(remoteFile('notes.txt')).toBe('AGENT-SIDE\n');
}, T);

test('R13 `git checkout --ours` during a rebase is refused and left as it is', async () => {
  await conflictPair();
  shTry(appDir, {}, 'rebase', 'origin/main');
  sh(appDir, 'checkout', '--ours', 'notes.txt');
  await expectRefused(appDir, 'app', /A rebase/);
}, T);

test('R13 a resolution continued with `rebase --continue`, then a second stop, is refused and left as it is', async () => {
  write(agentDir, 'notes.txt', 'AGENT 1\n');
  write(agentDir, 'b.txt', 'AGENT B\n');
  await syncRepo(agentDir, 'agent', 'agent both');
  write(appDir, 'notes.txt', 'APP 1\n');
  sh(appDir, 'add', '-A');
  sh(appDir, 'commit', '-q', '-m', 'app notes');
  write(appDir, 'b.txt', 'APP B\n');
  sh(appDir, 'add', '-A');
  sh(appDir, 'commit', '-q', '-m', 'app b');
  sh(appDir, 'fetch', '-q', 'origin');
  shTry(appDir, {}, 'rebase', 'origin/main');
  write(appDir, 'notes.txt', 'resolved by hand\n');
  sh(appDir, 'add', 'notes.txt');
  shTry(appDir, {}, 'rebase', '--continue'); // stops again, on b.txt
  expect(rebaseInProgress(appDir)).toBe(true);
  expect(sh(appDir, 'show', 'HEAD:notes.txt')).toBe('resolved by hand\n');
  await expectRefused(appDir, 'app', /A rebase/);
}, T);

test('R13 a modify/delete conflict accepted by deleting the file is refused and left as it is', async () => {
  write(appDir, 'gone.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  fs.unlinkSync(path.join(agentDir, 'gone.txt'));
  await syncRepo(agentDir, 'agent', 'agent deletes');
  write(appDir, 'gone.txt', 'app edit\n');
  sh(appDir, 'add', '-A');
  sh(appDir, 'commit', '-q', '-m', 'app edits');
  sh(appDir, 'fetch', '-q', 'origin');
  shTry(appDir, {}, 'rebase', 'origin/main');
  expect(rebaseInProgress(appDir)).toBe(true);
  sh(appDir, 'rm', '-q', 'gone.txt');
  await expectRefused(appDir, 'app', /A rebase/);
  expect(exists(appDir, 'gone.txt')).toBe(false);
}, T);

test('R13 an untouched apply-backend rebase is refused and left as it is', async () => {
  await conflictPair();
  shTry(appDir, {}, 'rebase', '--apply', 'origin/main');
  expect(fs.existsSync(path.join(appDir, '.git', 'rebase-apply'))).toBe(true);
  await expectRefused(appDir, 'app', /A rebase/);
}, T);

test('R13 a paused interactive rebase with no conflict is refused and left as it is', async () => {
  write(agentDir, 'other.txt', 'agent\n');
  await syncRepo(agentDir, 'agent', 'agent other');
  write(appDir, 'mine.txt', 'mine\n');
  sh(appDir, 'add', '-A');
  sh(appDir, 'commit', '-q', '-m', 'mine');
  sh(appDir, 'fetch', '-q', 'origin');
  shTry(appDir, { GIT_SEQUENCE_EDITOR: "sed -i -e 's/^pick/edit/'" }, 'rebase', '-i', 'origin/main');
  expect(rebaseInProgress(appDir)).toBe(true);
  expect(sh(appDir, 'ls-files', '-u')).toBe('');
  await expectRefused(appDir, 'app', /A rebase/);
}, T);

test('R13 a merge stopped on a conflict is refused: its conflict markers are never committed', async () => {
  await conflictPair();
  shTry(appDir, {}, 'merge', 'origin/main');
  expect(fs.existsSync(path.join(appDir, '.git', 'MERGE_HEAD'))).toBe(true);
  await expectRefused(appDir, 'app', /A merge/);
  expect(sh(remote, 'log', '-p', 'main')).not.toContain('<<<<<<<');
}, T);

test('R13 a cherry-pick stopped on a conflict is refused and left as it is', async () => {
  await conflictPair();
  shTry(appDir, {}, 'cherry-pick', 'origin/main');
  expect(fs.existsSync(path.join(appDir, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
  await expectRefused(appDir, 'app', /A cherry-pick/);
  expect(sh(remote, 'log', '-p', 'main')).not.toContain('<<<<<<<');
}, T);

test('R13 a revert stopped on a conflict is refused and left as it is', async () => {
  write(appDir, 'notes.txt', 'one\n');
  await syncRepo(appDir, 'app', 'one');
  write(appDir, 'notes.txt', 'two\n');
  await syncRepo(appDir, 'app', 'two');
  shTry(appDir, {}, 'revert', '--no-edit', 'HEAD~1');
  expect(fs.existsSync(path.join(appDir, '.git', 'REVERT_HEAD'))).toBe(true);
  await expectRefused(appDir, 'app', /A revert/);
}, T);

test('R13 a stopped `git am` is refused and left as it is', async () => {
  await conflictPair();
  const patch = path.join(tmpDir(), 'p.patch');
  fs.writeFileSync(patch, sh(appDir, 'format-patch', '-1', '--stdout', 'origin/main'));
  shTry(appDir, {}, 'am', '-3', patch);
  expect(fs.existsSync(path.join(appDir, '.git', 'rebase-apply', 'applying'))).toBe(true);
  await expectRefused(appDir, 'app', /git am/);
}, T);

// --- R14/R15: a wrong address never swaps the data ----------------------------------------------------

/** Another repository of the user's, with its own `main`. */
function otherRepoWithMain(): string {
  const other = bare();
  const work = path.join(tmpDir(), 'other-work');
  execFileSync('git', ['clone', '-q', other, work], { stdio: 'ignore' });
  write(work, 'README.md', 'engine\n');
  sh(work, 'add', '-A');
  sh(work, '-c', 'user.name=o', '-c', 'user.email=o@example.com', 'commit', '-q', '-m', 'engine');
  sh(work, 'push', '-q', 'origin', 'HEAD:main');
  return other;
}

test('R14 a refused initPrivateRepo on a repo in use changes nothing, and the next sync still goes to the right remote', async () => {
  write(appDir, 'profile/transcripts/t1.json', '{}\n');
  await syncRepo(appDir, 'app', 'transcript');
  const other = otherRepoWithMain();
  const otherBefore = sh(other, 'for-each-ref');
  const before = snapshot(appDir);
  await expect(initPrivateRepo(appDir, { identity: { name: 'Other', email: 'o@example.com' }, remote: other })).rejects.toBeInstanceOf(GitError);
  await expect(initPrivateRepo(appDir, { identity, remote: '--upload-pack=true' })).rejects.toBeInstanceOf(GitError);
  expect(snapshot(appDir)).toEqual(before);
  write(appDir, 'profile/transcripts/t2.json', '{}\n');
  expect((await syncRepo(appDir, 'app', 'next')).pushed).toBe(true);
  expect(remoteTree()).toContain('profile/transcripts/t2.json');
  expect(sh(other, 'for-each-ref')).toBe(otherBefore);
}, T);

test('R15 origin re-pointed by hand at another repository: GitError, nothing changed, nothing pushed there', async () => {
  write(appDir, 'profile/transcripts/t1.json', '{}\n');
  await syncRepo(appDir, 'app', 'transcript');
  const other = otherRepoWithMain();
  const otherBefore = sh(other, 'for-each-ref');
  sh(appDir, 'remote', 'set-url', 'origin', other);
  write(appDir, 'profile/transcripts/t2.json', '{}\n');
  const before = snapshot(appDir);
  for (const call of [() => pullRepo(appDir, 'app'), () => syncRepo(appDir, 'app', 'x')]) {
    const err = (await call().catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(/no history in common/);
  }
  expect(snapshot(appDir)).toEqual(before);
  expect(sh(other, 'for-each-ref')).toBe(otherBefore);
}, T);

test('R15 origin re-pointed at a copy of the same data repo that is behind: local commits go on top, no file leaves', async () => {
  const copy = path.join(tmpDir(), 'copy.git');
  execFileSync('git', ['clone', '-q', '--bare', remote, copy]);
  write(appDir, 'a.txt', 'a\n');
  await syncRepo(appDir, 'app', 'a');
  write(appDir, 'b.txt', 'b\n');
  await syncRepo(appDir, 'app', 'b');
  sh(appDir, 'remote', 'set-url', 'origin', copy);
  write(appDir, 'c.txt', 'c\n');
  const files = Object.keys(snapshot(appDir).files);
  expect((await syncRepo(appDir, 'app', 'c')).pushed).toBe(true);
  expect(sh(copy, 'rev-parse', 'main')).toBe(sh(appDir, 'rev-parse', 'HEAD'));
  for (const f of files) expect(exists(appDir, f)).toBe(true);
  expect(sh(copy, 'ls-tree', '-r', '--name-only', 'main')).toMatch(/^a\.txt$[\s\S]*^b\.txt$[\s\S]*^c\.txt$/m);
  clean(appDir);
}, T);

// --- R16: line-ending conversion in the user's config --------------------------------------------------

test('R16 under core.autocrlf=true a conflict plus a second commit pushes the owner’s version and both changes, no markers', async () => {
  write(appDir, 'notes.txt', 'base\n');
  write(appDir, 'later.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(agentDir, 'notes.txt', 'other side\n');
  await syncRepo(agentDir, 'agent', 'other side');
  await withEnv(globalConfig('[core]\n\tautocrlf = true\n'), async () => {
    write(appDir, 'notes.txt', 'my committed edit\n');
    sh(appDir, 'add', '-A');
    sh(appDir, 'commit', '-q', '-m', 'c1 notes');
    write(appDir, 'later.txt', 'SECOND COMMIT CHANGE\n');
    sh(appDir, 'add', '-A');
    sh(appDir, 'commit', '-q', '-m', 'c2 later');
    expect(await syncRepo(appDir, 'app', 'sync')).toMatchObject({ pushed: true, resolved: ['notes.txt'] });
    expect(remoteFile('notes.txt')).toBe('my committed edit\n');
    expect(remoteFile('later.txt')).toBe('SECOND COMMIT CHANGE\n');
    expect(sh(remote, 'log', '-p', 'main')).not.toContain('<<<<<<<');
    expect((await syncRepo(appDir, 'app', 'nothing')).committed).toBeNull();
    expect((await pullRepo(agentDir, 'agent')).committed).toBeNull();
    expect((await syncRepo(agentDir, 'agent', 'nothing')).committed).toBeNull();
  });
}, T);

test('R16 files DataRepo writes are committed and checked out with the bytes it wrote, whatever the line-ending config', async () => {
  const configs = [
    '[core]\n\tautocrlf = true\n',
    '[core]\n\tautocrlf = input\n',
    '[core]\n\teol = crlf\n',
    `[core]\n\teol = crlf\n\tattributesFile = ${path.join(tmpDir(), 'attrs')}\n`,
  ];
  fs.writeFileSync(configs[3]!.split('attributesFile = ')[1]!.trim(), '* text=auto eol=crlf\n');
  let n = 0;
  for (const cfg of configs) {
    n++;
    await withEnv(globalConfig(cfg), async () => {
      const crlf = Buffer.from(`line one ${n}\r\nline two\r\n`);
      const rel = `profile/resumes/cv-${n}.txt`;
      app.writeBlob(rel, new Uint8Array(crlf));
      agent.put('application', sample.application({ id: `a${n}` }));
      const json = fs.readFileSync(path.join(agentDir, `applications/a${n}.json`));
      expect((await syncRepo(appDir, 'app', `cv ${n}`)).pushed).toBe(true);
      expect((await syncRepo(agentDir, 'agent', `a ${n}`)).pushed).toBe(true);
      expect(Buffer.from(execFileSync('git', ['cat-file', 'blob', `main:${rel}`], { cwd: remote }))).toEqual(crlf);
      expect(Buffer.from(execFileSync('git', ['cat-file', 'blob', `main:applications/a${n}.json`], { cwd: remote }))).toEqual(json);
      expect(fs.readFileSync(path.join(agentDir, rel))).toEqual(crlf);
      await pullRepo(appDir, 'app');
      expect(fs.readFileSync(path.join(appDir, `applications/a${n}.json`))).toEqual(json);
      expect((await syncRepo(appDir, 'app', 'nothing')).committed).toBeNull();
    });
  }
}, 60_000);

// --- R17: a `main` deleted on the host is not re-uploaded ---------------------------------------------

/** Snapshot without refs/cob/: R23 (amended) records what a "main is gone" refusal counted. */
const withoutRecords = (snap: ReturnType<typeof snapshot>) => ({
  ...snap,
  refs: snap.refs.split('\n').filter((l) => !l.startsWith('refs/cob/')).join('\n'),
});
const recordLines = (snap: ReturnType<typeof snapshot>) => snap.refs.split('\n').filter((l) => l.startsWith('refs/cob/'));

async function expectMainGone(dir: string): Promise<void> {
  write(dir, 'new.txt', 'new\n');
  const before = snapshot(dir);
  for (const call of [() => syncRepo(dir, 'app', 'x'), () => pullRepo(dir, 'app')]) {
    const err = (await call().catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(/gone/);
    expect(err.message).toMatch(/nothing was pushed/);
  }
  const after = snapshot(dir);
  expect(withoutRecords(after)).toEqual(withoutRecords(before));
  if (recordLines(before).length > 0) expect(recordLines(after)).toEqual(recordLines(before));
  else expect(recordLines(after).length).toBeGreaterThan(0); // counted from the tracking ref, and kept
  expect(sh(remote, 'for-each-ref')).toBe('');
}

test('R17 a main deleted on the host is not pushed back', async () => {
  write(appDir, 'notes/transcript.txt', 'private\n');
  await syncRepo(appDir, 'app', 'transcript');
  sh(remote, 'update-ref', '-d', 'refs/heads/main');
  await expectMainGone(appDir);
}, T);

test('R17 the same after `git fetch --prune` removed the tracking ref, and after the repo was recreated empty', async () => {
  await syncRepo(appDir, 'app', 'x');
  fs.rmSync(remote, { recursive: true, force: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(appDir, 'fetch', '-q', '--prune', 'origin');
  expect(sh(appDir, 'for-each-ref', 'refs/remotes')).toBe('');
  await expectMainGone(appDir);
}, T);

// --- R18: resuming an init never deletes a file written since ------------------------------------------

test('R18 resuming an init killed before its commit keeps what the app saved since, or refuses and changes nothing', async () => {
  const dir = path.join(tmpDir(), 'n1');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'cob-init.json'), '{"app":"company-of-bots","commit":null}\n');
  sh(dir, 'init', '-q', '-b', 'main');
  const repo = new DataRepo(dir, 'app');
  repo.putSingleton('meta', { schemaVersion: 1, createdAt: T1_ISO });
  repo.putSingleton('lanes', { lanes: [{ id: 'mine', name: 'Saved after the kill' }] });
  repo.putSingleton('declarations', { hardNosNone: true, sourcesDecideLater: false });
  const lanes = fs.readFileSync(path.join(dir, 'guide/lanes.json'));
  const decl = fs.readFileSync(path.join(dir, 'profile/declarations.json'));
  // A half-written text file of the layout: refused, and nothing changes.
  write(dir, 'README.md', '# Your priv');
  const before = snapshot(dir);
  const err = (await initPrivateRepo(dir, { identity }).catch((e: unknown) => e)) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.message).toMatch(/not empty/);
  expect(snapshot(dir)).toEqual(before);
  // Without it, the resume keeps the saved files in the first commit.
  fs.unlinkSync(path.join(dir, 'README.md'));
  await initPrivateRepo(dir, { identity });
  expect(sh(dir, 'log', '--format=%s')).toBe('Initialize private data repo\n');
  expect(fs.readFileSync(path.join(dir, 'guide/lanes.json'))).toEqual(lanes);
  expect(fs.readFileSync(path.join(dir, 'profile/declarations.json'))).toEqual(decl);
  expect(Buffer.from(execFileSync('git', ['show', 'HEAD:guide/lanes.json'], { cwd: dir }))).toEqual(lanes);
  expect(sh(dir, 'status', '--porcelain')).toBe('');
}, T);

// --- R19/R20: once-pushed commits without the reflog; dropped commits stay reachable ------------------------

test('R19 with the reflog gone and the first sync after the rewrite stopped part-way, the next sync does not re-push', async () => {
  write(appDir, 'notes/transcript.txt', 'private\n');
  await syncRepo(appDir, 'app', 'transcript');
  await pullRepo(agentDir, 'agent');
  rewindRemote();
  fs.rmSync(path.join(agentDir, '.git', 'logs'), { recursive: true, force: true });
  sh(agentDir, 'config', 'core.logAllRefUpdates', 'false');
  const stop = new Error('killed between fetch and moving main');
  await expect(syncRepo(agentDir, 'agent', 'x', { beforeIntegrate: async () => Promise.reject(stop) })).rejects.toBe(stop);
  expect(exists(agentDir, 'notes/transcript.txt')).toBe(true); // main has not moved yet
  expect((await syncRepo(agentDir, 'agent', 'again')).pushed).toBe(true);
  expect(remoteHistory()).not.toContain('transcript');
  expect(exists(agentDir, 'notes/transcript.txt')).toBe(false);
}, T);

test('R19 with .git/logs removed (no stop), the rewrite is still followed', async () => {
  write(appDir, 'notes/transcript.txt', 'private\n');
  await syncRepo(appDir, 'app', 'transcript');
  rewindRemote();
  fs.rmSync(path.join(appDir, '.git', 'logs'), { recursive: true, force: true });
  write(appDir, 'new.txt', 'new\n');
  expect((await syncRepo(appDir, 'app', 'new')).pushed).toBe(true);
  expect(remoteHistory()).not.toContain('transcript');
  expect(remoteTree()).toContain('new.txt');
}, T);

test('R20 commits a host restore dropped stay reachable under refs/cob/ through gc, and are never pushed', async () => {
  write(appDir, 'notes/lost.txt', 'pushed, then lost in a restore\n');
  await syncRepo(appDir, 'app', 'lost later');
  const lost = sh(appDir, 'rev-parse', 'HEAD').trim();
  await pullRepo(agentDir, 'agent');
  rewindRemote(); // the host is restored from a backup taken before that push
  for (const dir of [agentDir, appDir]) {
    await syncRepo(dir, dir === appDir ? 'app' : 'agent', 'follow');
    expect(exists(dir, 'notes/lost.txt')).toBe(false);
    sh(dir, 'reflog', 'expire', '--expire=now', '--all');
    sh(dir, 'gc', '-q', '--prune=now');
    expect(() => sh(dir, 'cat-file', '-e', `${lost}^{commit}`)).not.toThrow();
    expect(sh(dir, 'for-each-ref', '--contains', lost, 'refs/cob/')).not.toBe('');
  }
  expect(sh(remote, 'for-each-ref')).not.toContain('refs/cob');
  expect(remoteHistory()).not.toContain('lost.txt');
}, T);

// --- R22: tests that catch weakened guards ----------------------------------------------------------------

test('R22 a stray byte after the UTF-16 BOM does not hide cookie text (both alignments are decoded)', () => {
  const body = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(NETSCAPE, 'utf16le')]);
  fs.mkdirSync(path.join(appDir, 'notes'));
  fs.writeFileSync(path.join(appDir, 'notes/odd.txt'), body);
  sh(appDir, 'add', '--', 'notes/odd.txt');
  expect(() => assertNoSecrets(appDir, ['notes/odd.txt'])).toThrow(SecretLeakError);
});

test('R22 an init marker whose commit is not the root of HEAD (an amended init commit) is not ours', async () => {
  const { dir, r2 } = await failedInit();
  write(dir, 'extra.txt', 'x\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '--amend', '--no-edit');
  fs.unlinkSync(path.join(r2, 'hooks', 'pre-receive'));
  await expect(initPrivateRepo(dir, { identity, remote: r2 })).rejects.toBeInstanceOf(GitError);
  expect(sh(r2, 'for-each-ref')).toBe('');
}, T);

// ===========================================================================
// cob-d2 fix 2 (rows R23-R25, amended R13, R21, R22)
// ===========================================================================

/** Remove every record under refs/cob/: a checkout made by older code, or with the records deleted. */
function removeRecords(dir: string): void {
  for (const ref of sh(dir, 'for-each-ref', '--format=%(refname)', 'refs/cob/').split('\n').filter(Boolean)) {
    sh(dir, 'update-ref', '-d', ref);
  }
  expect(sh(dir, 'for-each-ref', 'refs/cob/')).toBe('');
}

// --- R23: a checkout with no record counts its tracking ref as seen ------------------------------------

test('R23 no record, reflog intact: a host rewind is followed and the dropped commit is not replayed', async () => {
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  removeRecords(appDir);
  rewindRemote();
  expect((await syncRepo(appDir, 'app', 'sync')).pushed).toBe(true);
  expect(remoteHistory()).not.toContain('transcript');
  expect(sh(remote, 'log', '--format=%s', 'main')).not.toContain('transcript');
  expect(exists(appDir, 'notes/transcript.txt')).toBe(false);
}, T);

test('R23 no record, reflog intact: a deleted main is GitError (R17), nothing is pushed and nothing changes', async () => {
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  removeRecords(appDir);
  sh(remote, 'update-ref', '-d', 'refs/heads/main');
  await expectMainGone(appDir);
}, T);

test('R23 no record and no reflog: the tracking tip alone is enough, for a rewind and for a deleted main', async () => {
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  removeRecords(appDir);
  fs.rmSync(path.join(appDir, '.git', 'logs'), { recursive: true, force: true });
  rewindRemote();
  expect((await syncRepo(appDir, 'app', 'sync')).pushed).toBe(true);
  expect(remoteHistory()).not.toContain('transcript');
  removeRecords(appDir);
  fs.rmSync(path.join(appDir, '.git', 'logs'), { recursive: true, force: true });
  sh(remote, 'update-ref', '-d', 'refs/heads/main');
  await expectMainGone(appDir);
}, T);

test('R23 a checkout made by the user’s own `git clone` follows a host rewind', async () => {
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  const own = path.join(tmpDir(), 'own');
  execFileSync('git', ['clone', '-q', remote, own]);
  sh(own, 'config', 'user.name', 'Own');
  sh(own, 'config', 'user.email', 'own@example.com');
  rewindRemote();
  write(own, 'work.txt', 'work\n');
  expect((await syncRepo(own, 'agent', 'work')).pushed).toBe(true);
  expect(remoteHistory()).not.toContain('transcript');
  expect(remoteTree()).toContain('work.txt');
}, T);

test('R23 a checkout with a record for another address gets nothing from the tracking ref (R15 holds)', async () => {
  const copy = path.join(tmpDir(), 'copy.git');
  execFileSync('git', ['clone', '-q', '--bare', remote, copy]);
  write(appDir, 'a.txt', 'a\n');
  await syncRepo(appDir, 'app', 'a'); // the tracking ref now holds a commit the copy has never had
  sh(appDir, 'remote', 'set-url', 'origin', copy);
  write(appDir, 'b.txt', 'b\n');
  expect((await syncRepo(appDir, 'app', 'b')).pushed).toBe(true);
  expect(sh(copy, 'rev-parse', 'main')).toBe(sh(appDir, 'rev-parse', 'HEAD'));
  expect(exists(appDir, 'a.txt')).toBe(true);
  expect(sh(copy, 'ls-tree', '-r', '--name-only', 'main')).toMatch(/^a\.txt$/m);
  clean(appDir);
}, T);

// --- R13 (amended): unmerged entries with no operation behind them -------------------------------------

test('R13 a conflict left by `git stash pop` is refused and left as it is', async () => {
  write(appDir, 'notes.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  write(appDir, 'notes.txt', 'STASHED EDIT\n');
  sh(appDir, 'stash', '-q');
  write(appDir, 'notes.txt', 'APP-SIDE 2\n');
  sh(appDir, 'commit', '-q', '-am', 'app 2');
  shTry(appDir, {}, 'stash', 'pop');
  expect(sh(appDir, 'ls-files', '-u')).not.toBe('');
  await expectRefused(appDir, 'app', /unresolved conflicts \(notes\.txt\)/, /git add/);
  expect(read(appDir, 'notes.txt')).toContain('<<<<<<<');
  expect(sh(remote, 'log', '-p', 'main')).not.toContain('<<<<<<<');
}, T);

test('R13 a conflict left by `git checkout -m` is refused and left as it is', async () => {
  write(appDir, 'notes.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  sh(appDir, 'checkout', '-q', '-b', 'side');
  write(appDir, 'notes.txt', 'SIDE\n');
  sh(appDir, 'commit', '-q', '-am', 'side');
  write(appDir, 'notes.txt', 'LOCAL EDIT\n');
  shTry(appDir, {}, 'checkout', '-q', '-m', 'main');
  expect(sh(appDir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
  expect(sh(appDir, 'ls-files', '-u')).not.toBe('');
  await expectRefused(appDir, 'app', /unresolved conflicts \(notes\.txt\)/, /git add/);
  expect(sh(remote, 'log', '-p', 'main')).not.toContain('<<<<<<<');
}, T);

// --- R24: a checkout the user's own git wrote with CRLF ----------------------------------------------------

test('R24 a checkout written by the user’s own git under core.autocrlf=true: no change commits nothing; one write commits one file', async () => {
  write(appDir, 'notes.txt', 'one\ntwo\n');
  await syncRepo(appDir, 'app', 'notes');
  await withEnv(globalConfig('[core]\n\tautocrlf = true\n'), async () => {
    const own = path.join(tmpDir(), 'own');
    execFileSync('git', ['clone', '-q', remote, own]);
    sh(own, 'config', 'user.name', 'Own');
    sh(own, 'config', 'user.email', 'own@example.com');
    expect(fs.readFileSync(path.join(own, 'notes.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    const before = sh(remote, 'rev-parse', 'main');
    expect(await syncRepo(own, 'agent', 'nothing')).toMatchObject({ committed: null, pushed: true });
    expect(sh(remote, 'rev-parse', 'main')).toBe(before);
    new DataRepo(own, 'agent').put('application', sample.application({ id: 'a1' }));
    const r = await syncRepo(own, 'agent', 'one record');
    expect(r.pushed).toBe(true);
    expect(sh(own, 'show', '--name-only', '--format=', r.committed!)).toBe('applications/a1.json\n');
    expect(remoteFile('notes.txt')).toBe('one\ntwo\n');
    expect(Buffer.from(execFileSync('git', ['cat-file', 'blob', 'main:applications/a1.json'], { cwd: remote }))).toEqual(
      fs.readFileSync(path.join(own, 'applications/a1.json')),
    );
  });
}, T);

// --- R25: one record per repository, however its address is spelled ------------------------------------

/** Push a new private file, re-spell origin, scrub that commit on the host, sync: the scrub must hold. */
async function scrubAfterRespelling(spelling: string, n: number): Promise<void> {
  write(appDir, `notes/transcript-${n}.txt`, 'private\n');
  await syncRepo(appDir, 'app', `transcript ${n}`);
  sh(appDir, 'remote', 'set-url', 'origin', spelling);
  rewindRemote();
  expect((await syncRepo(appDir, 'app', `after ${n}`)).pushed).toBe(true);
  expect(remoteHistory()).not.toContain(`transcript-${n}`);
}

test('R25 local respellings (trailing slash, file://, no .git suffix) keep one record: a scrub stays scrubbed, a deleted main stays deleted', async () => {
  const spellings = [`${remote}/`, `file://${remote}`, remote.replace(/\.git$/, ''), `file://${remote}/`];
  let n = 0;
  for (const spelling of spellings) await scrubAfterRespelling(spelling, ++n);
  sh(appDir, 'remote', 'set-url', 'origin', remote);
  sh(remote, 'update-ref', '-d', 'refs/heads/main');
  await expectMainGone(appDir);
}, T);

test('R25 a rotated token, another user name, host case, and https against ssh keep one record', async () => {
  const spellings = [
    'https://tok1@example.com/me/data.git',
    'https://tok2@example.com/me/data.git',
    'https://someone:tok3@Example.COM/me/data.git/',
    'https://example.com/me/data',
    'git@example.com:me/data.git',
    'ssh://git@example.com:22/me/data.git',
  ];
  // The user's git config sends each spelling to the same repository (here, the local bare remote).
  for (const s of spellings) sh(appDir, 'config', '--add', `url.${remote}.insteadOf`, s);
  sh(appDir, 'remote', 'set-url', 'origin', spellings[0]!);
  write(appDir, 'first.txt', 'x\n');
  await syncRepo(appDir, 'app', 'first under https');
  let n = 0;
  for (const spelling of spellings.slice(1)) await scrubAfterRespelling(spelling, ++n);
  sh(remote, 'update-ref', '-d', 'refs/heads/main');
  await expectMainGone(appDir);
}, T);

test('R25 a different path on the same host is a different repository: its record is not shared', async () => {
  const copy = path.join(tmpDir(), 'copy.git');
  execFileSync('git', ['clone', '-q', '--bare', remote, copy]);
  sh(appDir, 'config', '--add', `url.${remote}.insteadOf`, 'https://example.com/me/data.git');
  sh(appDir, 'config', '--add', `url.${copy}.insteadOf`, 'https://example.com/me/other.git');
  sh(appDir, 'remote', 'set-url', 'origin', 'https://example.com/me/data.git');
  write(appDir, 'a.txt', 'a\n');
  await syncRepo(appDir, 'app', 'a'); // recorded for me/data only
  sh(appDir, 'remote', 'set-url', 'origin', 'https://example.com/me/other.git');
  write(appDir, 'b.txt', 'b\n');
  expect((await syncRepo(appDir, 'app', 'b')).pushed).toBe(true);
  expect(exists(appDir, 'a.txt')).toBe(true); // a shared record would count `a` as once pushed and drop it
  expect(sh(copy, 'ls-tree', '-r', '--name-only', 'main')).toMatch(/^a\.txt$[\s\S]*^b\.txt$/m);
  clean(appDir);
}, T);

// --- R22 (amended): the clone and init records, and a rewrite that removes a middle commit -----------------

const seenRefs = (dir: string) =>
  sh(dir, 'for-each-ref', '--format=%(objectname)', 'refs/cob/seen/').split('\n').filter(Boolean);

test('R22 cloneDataRepo records the tip it cloned', async () => {
  const dir = path.join(tmpDir(), 'c');
  await cloneDataRepo(remote, dir, identity);
  expect(seenRefs(dir)).toEqual([sh(dir, 'rev-parse', 'refs/remotes/origin/main').trim()]);
}, T);

test('R22 initPrivateRepo records the tip of its first push', async () => {
  expect(seenRefs(appDir)).toEqual([sh(appDir, 'rev-parse', 'HEAD').trim()]);
  const { dir, r2 } = await failedInit();
  expect(seenRefs(dir)).toEqual([]);
  fs.unlinkSync(path.join(r2, 'hooks', 'pre-receive'));
  await initPrivateRepo(dir, { identity, remote: r2 });
  expect(seenRefs(dir)).toEqual([sh(dir, 'rev-parse', 'HEAD').trim()]);
}, T);

test('R22 a host rewrite that removes a commit from the middle keeps every old tip: the commit is not replayed and survives gc', async () => {
  write(appDir, 'notes/leak.txt', 'leaked\n');
  await syncRepo(appDir, 'app', 'leak');
  const leak = sh(appDir, 'rev-parse', 'HEAD').trim();
  write(appDir, 'later.txt', 'later\n');
  await syncRepo(appDir, 'app', 'later');
  await pullRepo(agentDir, 'agent');
  // On the host: drop the leak commit, keep the one after it (a new sha, not an ancestor move).
  const third = thirdClone();
  sh(third, 'rebase', '-q', '--onto', `${leak}^`, leak, 'main');
  sh(third, 'push', '-q', '--force', 'origin', 'main');
  for (const [dir, writer] of [[agentDir, 'agent'], [appDir, 'app']] as const) {
    expect((await syncRepo(dir, writer, 'follow')).pushed).toBe(true);
    expect(exists(dir, 'notes/leak.txt')).toBe(false);
    expect(exists(dir, 'later.txt')).toBe(true);
    sh(dir, 'reflog', 'expire', '--expire=now', '--all');
    sh(dir, 'gc', '-q', '--prune=now');
    expect(() => sh(dir, 'cat-file', '-e', `${leak}^{commit}`)).not.toThrow();
  }
  expect(remoteHistory()).not.toContain('leak.txt');
}, T);

// ===========================================================================
// cob-d2 fix 3 (F17-F23: amended R22, R23, R25; new R26)
// ===========================================================================

/** Push a private file from `dir`, then scrub that commit on the host. */
async function pushThenScrub(dir: string, writer: 'app' | 'agent'): Promise<void> {
  write(dir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(dir, writer, 'transcript');
  rewindRemote();
}
const scrubHeld = () => {
  expect(remoteHistory()).not.toContain('transcript');
  expect(sh(remote, 'log', '--format=%s', 'main')).not.toContain('transcript');
};

// --- F17 / R25: file://localhost and a relative path are the same repository -------------------------

test('R25 `file://localhost` plus the absolute path is the same repository: a scrub stays scrubbed', async () => {
  await pushThenScrub(appDir, 'app');
  sh(appDir, 'remote', 'set-url', 'origin', `file://localhost${remote}`);
  expect((await syncRepo(appDir, 'app', 'after')).pushed).toBe(true);
  scrubHeld();
}, T);

test('R25 a relative path is resolved against the checkout, not the process folder: a scrub stays scrubbed', async () => {
  await pushThenScrub(appDir, 'app');
  const relative = path.relative(appDir, remote);
  expect(path.relative(process.cwd(), remote)).not.toBe(relative); // the two folders differ
  sh(appDir, 'remote', 'set-url', 'origin', relative);
  expect((await syncRepo(appDir, 'app', 'after')).pushed).toBe(true);
  scrubHeld();
}, T);

// --- F18 / R25: data.git and data are two repositories -------------------------------------------------

test('R25 local `data.git` and `data` are two repositories: re-pointing at a copy that is behind pushes the newer commit', async () => {
  const copy = remote.replace(/\.git$/, ''); // `…/remote` next to `…/remote.git`, a copy that is behind
  execFileSync('git', ['clone', '-q', '--bare', remote, copy]);
  write(appDir, 'week1.txt', 'week 1\n');
  await syncRepo(appDir, 'app', 'week 1');
  sh(appDir, 'remote', 'set-url', 'origin', copy);
  write(appDir, 'week2.txt', 'week 2\n');
  expect((await syncRepo(appDir, 'app', 'week 2')).pushed).toBe(true);
  expect(read(appDir, 'week1.txt')).toBe('week 1\n');
  expect(sh(copy, 'ls-tree', '-r', '--name-only', 'main')).toMatch(/^week1\.txt$/m);
  expect(sh(copy, 'rev-parse', 'main')).toBe(sh(appDir, 'rev-parse', 'HEAD'));
}, T);

// --- F19 / R23: the tip a plain clone started with ------------------------------------------------------

/** The user's own `git clone` of the remote, with an identity and no record. */
function ownClone(): string {
  const own = path.join(tmpDir(), 'own');
  execFileSync('git', ['clone', '-q', remote, own]);
  sh(own, 'config', 'user.name', 'Own');
  sh(own, 'config', 'user.email', 'own@example.com');
  expect(sh(own, 'for-each-ref', 'refs/cob/')).toBe('');
  return own;
}

test('R23 a plain clone’s starting tip counts after the user’s own fetch moved the tracking ref (G7)', async () => {
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  const own = ownClone(); // starts at the transcript commit; a plain clone logs nothing for origin/main
  rewindRemote();
  sh(own, 'fetch', '-q', 'origin'); // the user's own fetch: the clone tip is now only an old value in the log
  expect(exists(own, 'notes/transcript.txt')).toBe(true);
  write(own, 'work.txt', 'work\n');
  expect((await syncRepo(own, 'agent', 'work')).pushed).toBe(true);
  scrubHeld();
  expect(exists(own, 'notes/transcript.txt')).toBe(false);
}, T);

// --- F20 / R23: a refusal keeps what it counted --------------------------------------------------------

test('R23 after "main is gone" on a checkout with no record, the user’s own `git fetch --prune` does not lead to a re-upload (G3)', async () => {
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  const own = ownClone();
  sh(remote, 'update-ref', '-d', 'refs/heads/main');
  const first = (await syncRepo(own, 'agent', 'x').catch((e: unknown) => e)) as GitError;
  expect(first).toBeInstanceOf(GitError);
  expect(first.message).toMatch(/gone/);
  sh(own, 'fetch', '-q', '--prune', 'origin');
  expect(sh(own, 'for-each-ref', 'refs/remotes/')).toBe('');
  const second = (await syncRepo(own, 'agent', 'y').catch((e: unknown) => e)) as GitError;
  expect(second).toBeInstanceOf(GitError);
  expect(second.message).toMatch(/gone/);
  expect(sh(remote, 'for-each-ref')).toBe('');
}, T);

// --- F21 / R26: what the user's own fetch brought in at the recorded repository ----------------------------

test('R26 a commit the user’s own `git pull` brought in, then dropped on the host, is not pushed back (G6)', async () => {
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  sh(agentDir, 'pull', '-q', '--no-rebase', 'origin', 'main'); // by hand: core never saw this tip
  rewindRemote();
  write(agentDir, 'work.txt', 'work\n');
  expect((await syncRepo(agentDir, 'agent', 'work')).pushed).toBe(true);
  scrubHeld();
  expect(remoteTree()).toContain('work.txt');
}, T);

test('R26 control: origin re-pointed by hand at another repository, then fetched by hand: nothing counts across (R15)', async () => {
  const copy = path.join(tmpDir(), 'copy.git');
  execFileSync('git', ['clone', '-q', '--bare', remote, copy]);
  write(appDir, 'a.txt', 'a\n');
  await syncRepo(appDir, 'app', 'a');
  sh(appDir, 'remote', 'set-url', 'origin', copy);
  sh(appDir, 'fetch', '-q', 'origin'); // the user's own fetch from the copy moves the tracking ref back
  write(appDir, 'b.txt', 'b\n');
  expect((await syncRepo(appDir, 'app', 'b')).pushed).toBe(true);
  expect(read(appDir, 'a.txt')).toBe('a\n');
  expect(sh(copy, 'ls-tree', '-r', '--name-only', 'main')).toMatch(/^a\.txt$[\s\S]*^b\.txt$/m);
}, T);

// --- F22 / R22: the reflog seed, the clone's line endings, the host in the key --------------------------------

test('R22 seeding reads the reflog: a commit the user pulled, then the host dropped and the user fetched past, is not pushed back (G8)', async () => {
  const own = ownClone();
  write(appDir, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
  await syncRepo(appDir, 'app', 'transcript');
  sh(own, 'pull', '-q', '--no-rebase', 'origin', 'main'); // the transcript tip is a new value in the reflog
  rewindRemote();
  sh(own, 'fetch', '-q', 'origin'); // the tracking ref no longer holds it
  write(own, 'work.txt', 'work\n');
  expect((await syncRepo(own, 'agent', 'work')).pushed).toBe(true);
  scrubHeld();
}, T);

test('R22 cloneDataRepo makes a byte-exact checkout whatever the user’s line-ending config', async () => {
  await withEnv(globalConfig('[core]\n\tautocrlf = true\n'), async () => {
    const dir = path.join(tmpDir(), 'c');
    await cloneDataRepo(remote, dir, identity);
    expect(sh(dir, 'config', '--local', 'core.autocrlf').trim()).toBe('false');
    for (const rel of ['README.md', 'guide/lanes.json', '.gitignore']) {
      expect(fs.readFileSync(path.join(dir, rel)).includes(0x0d), rel).toBe(false);
    }
    const crlf = Buffer.from('a\r\nb\r\n');
    new DataRepo(dir, 'agent').writeBlob('profile/resumes/cv.txt', new Uint8Array(crlf));
    expect((await syncRepo(dir, 'agent', 'cv')).pushed).toBe(true);
    expect(Buffer.from(execFileSync('git', ['cat-file', 'blob', 'main:profile/resumes/cv.txt'], { cwd: remote }))).toEqual(crlf);
  });
}, T);

test('R22/R25 the repository key: one repository per host and path, however it is spelled', () => {
  const posix = (a: string, base = '/work/app') => repositoryKey(a, base, { pathApi: path.posix });
  const win = (a: string, base = 'C:\\work\\app') => repositoryKey(a, base, { pathApi: path.win32 });
  const same = (f: (a: string) => string, ...spellings: string[]) => {
    for (const s of spellings) expect(f(s), s).toBe(f(spellings[0]!));
  };
  same(
    posix,
    'https://tok1@example.com/me/data.git',
    'https://tok2@example.com/me/data.git/',
    'https://someone:x@Example.COM:8443/me/data',
    'git@example.com:me/data.git',
    'ssh://git@example.com:22/me/data.git',
  );
  same(posix, '/srv/data.git', '/srv/data.git/', 'file:///srv/data.git', 'file://localhost/srv/data.git', '../../srv/data.git');
  // Never one repository: another host, another path, `data.git` against `data` on disk.
  expect(posix('https://example.com/me/data.git')).not.toBe(posix('https://example.org/me/data.git'));
  expect(posix('git@example.com:me/data.git')).not.toBe(posix('git@example.net:me/data.git'));
  expect(posix('https://example.com/me/data.git')).not.toBe(posix('https://example.com/me/other.git'));
  expect(posix('/srv/data.git')).not.toBe(posix('/srv/data'));
  expect(posix('/srv/data.git')).not.toBe(posix('https://srv/data.git'));
  // Windows: drive paths in both slash styles, file:///C:/…, case; UNC and file://server/share/….
  same(win, 'C:/Users/data.git', 'C:\\Users\\data.git', 'c:\\users\\DATA.git\\', 'file:///C:/Users/data.git', 'file://localhost/C:/Users/data.git', '..\\..\\Users\\data.git');
  same(win, '\\\\server\\share\\data.git', '\\\\SERVER\\share\\data.git\\', 'file://server/share/data.git');
  expect(win('C:/Users/data.git')).not.toBe(win('C:/Users/data'));
  expect(win('\\\\server\\share\\data.git')).not.toBe(win('\\\\other\\share\\data.git'));
});
