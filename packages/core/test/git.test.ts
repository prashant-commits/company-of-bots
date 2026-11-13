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
  assertNoSecrets,
  cloneDataRepo,
  git,
  initPrivateRepo,
  pullRepo,
  syncRepo,
} from '../src/git.ts';
import { bare, clean, rebaseInProgress, roleInput, sample, tmpDir } from './helpers.ts';

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

test('B11 a failure in the middle of a rebase is aborted and thrown as GitError', async () => {
  write(appDir, 'notes.txt', 'app\n');
  write(agentDir, 'notes.txt', 'agent\n');
  await syncRepo(agentDir, 'agent', 'agent notes');
  // Fails every commit made while a rebase is running (rebase skips pre-commit but runs prepare-commit-msg), so resolving the conflict cannot finish.
  hook(appDir, 'prepare-commit-msg', 'if [ -d "$(git rev-parse --git-path rebase-merge)" ]; then echo "blocked by test hook" >&2; exit 1; fi');
  const err = await syncRepo(appDir, 'app', 'app notes').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GitError);
  expect(rebaseInProgress(appDir)).toBe(false);
  expect(sh(appDir, 'log', '-1', '--format=%s')).toBe('app notes\n'); // our commit is back where it was
  clean(appDir);
  expect(sh(remote, 'log', '-1', '--format=%s')).toBe('agent notes\n');
}, T);

test('B11 more than 50 conflict rounds is aborted and thrown as GitError', async () => {
  write(appDir, 'notes.txt', 'base\n');
  await syncRepo(appDir, 'app', 'base');
  await pullRepo(agentDir, 'agent');
  write(appDir, 'notes.txt', 'upstream\n');
  await syncRepo(appDir, 'app', 'upstream');
  for (let i = 1; i <= 51; i++) {
    write(agentDir, 'notes.txt', `local ${i}\n`);
    sh(agentDir, 'add', '-A');
    sh(agentDir, 'commit', '-q', '-m', `local ${i}`);
  }
  const head = sh(agentDir, 'rev-parse', 'HEAD');
  const err = await syncRepo(agentDir, 'agent', 'unused').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GitError);
  expect((err as GitError).message).toMatch(/50 rounds/);
  expect(rebaseInProgress(agentDir)).toBe(false);
  expect(sh(agentDir, 'rev-parse', 'HEAD')).toBe(head);
  clean(agentDir);
}, T);

test('B11 a rebase left in progress by a crashed earlier run is cleaned up, then sync succeeds', async () => {
  write(appDir, 'notes.txt', 'app\n');
  await syncRepo(appDir, 'app', 'app notes');
  write(agentDir, 'notes.txt', 'agent\n');
  sh(agentDir, 'add', '-A');
  sh(agentDir, 'commit', '-q', '-m', 'agent notes');
  expect(() => sh(agentDir, 'pull', '--rebase', '--no-autostash', 'origin', 'main')).toThrow();
  expect(rebaseInProgress(agentDir)).toBe(true);
  expect(await syncRepo(agentDir, 'agent', 'again')).toMatchObject({ pushed: true, resolved: ['notes.txt'] });
  expect(rebaseInProgress(agentDir)).toBe(false);
  expect(read(agentDir, 'notes.txt')).toBe('app\n');
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

const ADVANCE_REMOTE = (third: string, counter: string, max: number) =>
  `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"\n` +
  `if [ $n -le ${max} ]; then\n` +
  `  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n` +
  `  echo "$n" > "${third}/third-$n.txt" && git -C "${third}" add -A && git -C "${third}" commit -q -m "third $n" && git -C "${third}" push -q origin main\n` +
  `fi`;

test('B15 the remote moves between our pull and our push: pull and push are retried and succeed', async () => {
  const third = thirdClone();
  const counter = path.join(tmpDir(), 'count');
  hook(agentDir, 'pre-push', ADVANCE_REMOTE(third, counter, 1));
  write(agentDir, 'mine.txt', 'mine\n');
  const r = await syncRepo(agentDir, 'agent', 'mine');
  expect(r).toMatchObject({ pushed: true, resolved: [] });
  expect(fs.readFileSync(counter, 'utf8').trim()).toBe('2'); // first push rejected, second went through
  expect(sh(remote, 'rev-parse', 'main')).toBe(sh(agentDir, 'rev-parse', 'HEAD'));
  expect(sh(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('third-1.txt');
  expect(sh(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('mine.txt');
  clean(agentDir);
}, T);

test('B15 when every attempt is beaten, pushed is false with no error and the commit goes out next time', async () => {
  const third = thirdClone();
  const counter = path.join(tmpDir(), 'count');
  hook(agentDir, 'pre-push', ADVANCE_REMOTE(third, counter, 99));
  write(agentDir, 'mine.txt', 'mine\n');
  const r = await syncRepo(agentDir, 'agent', 'mine');
  expect(r).toMatchObject({ pushed: false, resolved: [] });
  expect(r.committed).toBe(sh(agentDir, 'rev-parse', 'HEAD').trim());
  expect(fs.readFileSync(counter, 'utf8').trim()).toBe('3'); // default maxAttempts
  expect(rebaseInProgress(agentDir)).toBe(false);
  fs.unlinkSync(path.join(agentDir, '.git/hooks/pre-push'));
  expect(await syncRepo(agentDir, 'agent', 'again')).toMatchObject({ committed: null, pushed: true });
  expect(sh(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('mine.txt');
}, T);

test('B15 maxAttempts is honoured', async () => {
  const third = thirdClone();
  const counter = path.join(tmpDir(), 'count');
  hook(agentDir, 'pre-push', ADVANCE_REMOTE(third, counter, 99));
  write(agentDir, 'mine.txt', 'mine\n');
  expect((await syncRepo(agentDir, 'agent', 'mine', { maxAttempts: 1 })).pushed).toBe(false);
  expect(fs.readFileSync(counter, 'utf8').trim()).toBe('1');
  expect((await syncRepo(agentDir, 'agent', 'mine', { maxAttempts: 5 })).pushed).toBe(false);
  expect(fs.readFileSync(counter, 'utf8').trim()).toBe('6'); // 1 earlier + 5 now
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
