// Regression tests for fix round 1 of the final review (rows G1-G12). Each test names its row.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApplicationStateError, applicationForPosting, beginSubmit, recordOutcome } from '../src/applications.ts';
import { createCommand } from '../src/commands.ts';
import { CONFIRMED } from '../src/confidence.ts';
import {
  GitError,
  HostRewoundError,
  SecretLeakError,
  SyncBusyError,
  cloneDataRepo,
  initPrivateRepo,
  pullRepo,
  syncRepo,
  withLock,
  withTestHooks,
} from '../src/git.ts';
import { roleIdFor } from '../src/ids.ts';
import { LAYOUT_IGNORE_LINES } from '../src/names.ts';
import { DataRepo } from '../src/repo.ts';
import { atomicWrite, withoutLocalPaths } from '../src/repo-paths.ts';
import { appInput, bare, pair, sample, tmpDir } from './helpers.ts';

const T = 60_000;
const identity = { name: 'Test User', email: 'test@example.com' };
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'user.name=Hand', '-c', 'user.email=hand@example.com', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
const write = (dir: string, rel: string, text: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const tree = (repo: string) => sh(repo, 'ls-tree', '-r', '--name-only', 'main');
const history = (repo: string) => sh(repo, 'log', '--all', '--name-only', '--format=');
const snapshot = (dir: string) => ({
  head: sh(dir, 'rev-parse', 'HEAD'),
  index: sh(dir, 'ls-files', '-s'),
  status: sh(dir, 'status', '--porcelain', '--untracked-files=all'),
});
const intent = { resumeFile: 'cv.pdf', points: [{ pointId: 'p', rev: 1 }] };

async function trio() {
  const remote = bare();
  const appDir = path.join(tmpDir(), 'app');
  const agentDir = path.join(tmpDir(), 'agent');
  await initPrivateRepo(appDir, { identity, remote });
  await cloneDataRepo(remote, agentDir, identity);
  return { remote, appDir, agentDir, app: new DataRepo(appDir, 'app'), agent: new DataRepo(agentDir, 'agent') };
}

/** The app pushes `rel` (sync), the agent pulls it, then the host goes back to before it. */
async function rolledBack(rel = 'notes/x.txt') {
  const t = await trio();
  const before = sh(t.remote, 'rev-parse', 'main').trim();
  write(t.appDir, rel, 'x\n');
  await syncRepo(t.appDir, 'app', 'x');
  await pullRepo(t.agentDir, 'agent');
  sh(t.remote, 'update-ref', 'refs/heads/main', before);
  return { ...t, before };
}

// ---------------------------------------------------------------------------
// G1: an OS file in the way of an incoming change never stalls a sync
// ---------------------------------------------------------------------------

describe('G1 OS files in the way', () => {
  test.each(['.DS_Store', 'Thumbs.db', 'profile/desktop.ini'])(
    'G1 probe r2-09: %s tracked on the remote replaces the untracked copy in the other checkout, and the syncs complete',
    async (junk) => {
      const t = await trio();
      write(t.appDir, junk, 'the app folder');
      write(t.appDir, 'notes.txt', 'a note\n');
      sh(t.appDir, 'add', '-A');
      sh(t.appDir, 'commit', '-q', '-m', 'by hand'); // a git client's "commit all"
      sh(t.appDir, 'push', '-q', 'origin', 'main');
      write(t.agentDir, junk, 'the agent folder'); // Finder or Explorer made one there too
      for (let i = 0; i < 3; i++) expect((await pullRepo(t.agentDir, 'agent')).pushed).toBe(false);
      expect(read(t.agentDir, 'notes.txt')).toBe('a note\n');
      expect(read(t.agentDir, junk)).toBe('the app folder');
      recordOutcome(t.agent, appInput(), { type: 'park', park: { type: 'captcha' } });
      expect((await syncRepo(t.agentDir, 'agent', 'run')).pushed).toBe(true);
      expect(tree(t.remote)).toMatch(/^applications\//m);
    },
    T,
  );

  test('G1 a tracked OS file with local changes in the way gives way to the incoming version', async () => {
    const t = await trio();
    write(t.appDir, '.DS_Store', 'v1');
    sh(t.appDir, 'add', '-A');
    sh(t.appDir, 'commit', '-q', '-m', 'v1');
    sh(t.appDir, 'push', '-q', 'origin', 'main');
    await pullRepo(t.agentDir, 'agent');
    write(t.appDir, '.DS_Store', 'v2');
    sh(t.appDir, 'commit', '-q', '-am', 'v2');
    sh(t.appDir, 'push', '-q', 'origin', 'main');
    // The OS rewrites the agent's copy while the sync is running, after the sync committed.
    const hooks = withTestHooks({ beforeIntegrate: async () => write(t.agentDir, '.DS_Store', 'agent local') });
    expect((await syncRepo(t.agentDir, 'agent', 'run', hooks)).pushed).toBe(true);
    expect(read(t.agentDir, '.DS_Store')).toBe('v2');
    expect(sh(t.agentDir, 'status', '--porcelain')).toBe('');
  }, T);

  test('G1 control: any other untracked file in the way still counts as busy: it is committed, never overwritten', async () => {
    const t = await trio();
    write(t.appDir, 'notes.txt', 'from the app\n');
    sh(t.appDir, 'add', '-A');
    sh(t.appDir, 'commit', '-q', '-m', 'by hand');
    sh(t.appDir, 'push', '-q', 'origin', 'main');
    let cycles = 0;
    const hooks = withTestHooks({
      beforeIntegrate: async () => {
        if (cycles++ === 0) write(t.agentDir, 'notes.txt', 'the agent user’s own\n'); // in the way of the incoming file
      },
    });
    await pullRepo(t.agentDir, 'agent', hooks);
    expect(cycles).toBe(2); // the first cycle was busy
    expect(sh(t.agentDir, 'log', '--all', '--reflog', '-p', '--format=')).toContain('the agent user’s own'); // committed, then settled by the owner rule
  }, T);
});

// ---------------------------------------------------------------------------
// G2: a lasting lock failure is a GitError; only the race is pushed: false (F15 test is in review-fixes)
// ---------------------------------------------------------------------------

test('G2 probe r2-11: a lock file left on the remote makes every save a GitError with git’s message; nothing is lost', async () => {
  const t = await trio();
  fs.writeFileSync(path.join(t.remote, 'refs/heads/main.lock'), '');
  for (let i = 1; i <= 3; i++) {
    createCommand(t.app, { verb: 'run_role', target: null, payload: { role: 'finder' } });
    const err = (await syncRepo(t.appDir, 'app', `save ${i}`).catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).toMatch(/cannot lock ref .*main\.lock/);
  }
  expect(tree(t.remote)).not.toMatch(/^commands\//m);
  fs.unlinkSync(path.join(t.remote, 'refs/heads/main.lock'));
  expect((await syncRepo(t.appDir, 'app', 'after')).pushed).toBe(true);
  expect(tree(t.remote).match(/^commands\//gm)).toHaveLength(3);
}, T);

// ---------------------------------------------------------------------------
// G3 / G4: ruling R57
// ---------------------------------------------------------------------------

describe('G3 G4 ruling R57', () => {
  test('G3 a skipped posting can be started again from its application; from the posting it is still refused', () => {
    const { app, agent } = pair();
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 1 }));
    app.put('point', sample.point({ id: 'h', kind: 'hard_no', rank: CONFIRMED, rev: 1 }));
    const s = recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: 'h' });
    expect(s.state).toBe('skipped');
    expect(() => beginSubmit(agent, appInput(), intent)).toThrow(ApplicationStateError);
    expect(applicationForPosting(agent, { link: appInput().link })?.state).toBe('skipped');
    const again = beginSubmit(agent, { applicationId: s.id }, intent);
    expect(again).toMatchObject({ id: s.id, state: 'submitting', skip: null, pendingSubmission: { resumeFile: 'cv.pdf' } });
    expect(agent.list('application').items).toHaveLength(1);
  });

  test.each(['submitting', 'submitted', 'done', 'dropped'] as const)('G3 control: an application that is %s still cannot be started again', (state) => {
    const { app, agent } = pair();
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 1 }));
    agent.put('application', sample.application({ id: 'a1', state, park: null }));
    expect(() => beginSubmit(agent, { applicationId: 'a1' }, intent)).toThrow(ApplicationStateError);
  });

  test('G4 a route fragment names its own posting; a plain fragment and ref do not', () => {
    const id = roleIdFor;
    expect(id('https://jobs.example.com/#/job/101')).not.toBe(id('https://jobs.example.com/#/job/202'));
    expect(id('https://jobs.example.com/careers#!/view/101')).not.toBe(id('https://jobs.example.com/careers#!/view/202'));
    expect(id('https://jobs.example.com/#/job/101?utm_source=x')).toBe(id('https://jobs.example.com/#/job/101?utm_source=x'));
    expect(id('https://jobs.example.com/jobs/1#apply')).toBe(id('https://jobs.example.com/jobs/1'));
    expect(id('https://jobs.example.com/jobs/1?utm_source=x#top')).toBe(id('https://jobs.example.com/jobs/1'));
    expect(id('https://jobs.example.com/vacancy?ref=A101')).toBe(id('https://jobs.example.com/vacancy?ref=B202'));
  });

  test('G4 probe r2-01 part B: two route postings on one page each get an application', () => {
    const { app, agent } = pair();
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 1 }));
    beginSubmit(agent, appInput({ link: 'https://jobs.example.com/#/job/101' }), intent);
    beginSubmit(agent, appInput({ link: 'https://jobs.example.com/#/job/202' }), intent);
    expect(agent.list('application').items).toHaveLength(2);
    expect(() => beginSubmit(agent, appInput({ link: 'https://jobs.example.com/#/job/101' }), intent)).toThrow(ApplicationStateError);
  });
});

// ---------------------------------------------------------------------------
// G5 / G6: the rewind path
// ---------------------------------------------------------------------------

describe('G5 G6 the rewind path', () => {
  test('G5 the HostRewoundError message names both answers, acceptRewind and restoreHost', async () => {
    const t = await rolledBack();
    const err = (await pullRepo(t.agentDir, 'agent').catch((e: unknown) => e)) as HostRewoundError;
    expect(err).toBeInstanceOf(HostRewoundError);
    expect(err.message).toContain('acceptRewind');
    expect(err.message).toContain('restoreHost');
  }, T);

  test('G5 restoreHost pushes local main back as a fast-forward, with new local work on top, and the other side syncs', async () => {
    const t = await rolledBack();
    const local = sh(t.agentDir, 'rev-parse', 'HEAD').trim();
    write(t.agentDir, 'work.txt', 'work\n');
    const r = await syncRepo(t.agentDir, 'agent', 'work', { restoreHost: true });
    expect(r).toMatchObject({ pushed: true, rewound: null });
    expect(() => sh(t.remote, 'merge-base', '--is-ancestor', local, 'main')).not.toThrow();
    expect(tree(t.remote)).toMatch(/^notes\/x\.txt$/m);
    expect(tree(t.remote)).toMatch(/^work\.txt$/m);
    // The host only moved forward: its reflog has no forced update.
    expect(sh(t.remote, 'rev-list', '--count', `${t.before}..main`).trim()).toBe('2');
    expect((await syncRepo(t.appDir, 'app', 'after')).pushed).toBe(true);
    expect(read(t.appDir, 'work.txt')).toBe('work\n');
  }, T);

  test('G5 pullRepo takes restoreHost too: the host is restored and new local work stays local', async () => {
    const t = await rolledBack();
    const local = sh(t.agentDir, 'rev-parse', 'HEAD').trim();
    const r = await pullRepo(t.agentDir, 'agent', { restoreHost: true });
    expect(r).toMatchObject({ pushed: true, rewound: null });
    expect(sh(t.remote, 'rev-parse', 'main').trim()).toBe(local);
    write(t.agentDir, 'later.txt', 'later\n');
    expect((await pullRepo(t.agentDir, 'agent', { restoreHost: true })).pushed).toBe(false); // no rewind now: never pushes
    expect(tree(t.remote)).not.toMatch(/later\.txt/);
  }, T);

  test('G5 restoreHost on a host whose history was rewritten is a GitError, and changes nothing', async () => {
    const t = await rolledBack();
    const third = path.join(tmpDir(), 'third');
    sh(path.dirname(third), 'clone', '-q', t.remote, third);
    write(third, 'other.txt', 'other\n');
    sh(third, 'add', 'other.txt');
    sh(third, 'commit', '-q', '-m', 'other');
    sh(third, 'push', '-q', 'origin', 'main');
    const remoteBefore = sh(t.remote, 'rev-parse', 'main');
    write(t.agentDir, 'work.txt', 'work\n');
    const before = snapshot(t.agentDir);
    const err = (await syncRepo(t.agentDir, 'agent', 'work', { restoreHost: true }).catch((e: unknown) => e)) as GitError;
    expect(err).toBeInstanceOf(GitError);
    expect(err).not.toBeInstanceOf(HostRewoundError);
    expect(err.message).toMatch(/rewritten, not rolled back/);
    expect(err.message).toContain('acceptRewind');
    expect(snapshot(t.agentDir)).toEqual(before);
    expect(sh(t.remote, 'rev-parse', 'main')).toBe(remoteBefore);
  }, T);

  test('G5 the secret guard runs on the restore push', async () => {
    const t = await trio();
    const before = sh(t.remote, 'rev-parse', 'main').trim();
    write(t.appDir, 'tmp/s.json', '{"sameSite":"Lax","httpOnly":true}');
    sh(t.appDir, 'add', '-f', '-A');
    sh(t.appDir, 'commit', '-q', '-m', 'leaked by hand');
    sh(t.appDir, 'push', '-q', 'origin', 'main');
    await pullRepo(t.agentDir, 'agent');
    sh(t.remote, 'update-ref', 'refs/heads/main', before); // the host scrubbed it
    await expect(pullRepo(t.agentDir, 'agent', { restoreHost: true })).rejects.toBeInstanceOf(SecretLeakError);
    expect(sh(t.remote, 'rev-parse', 'main').trim()).toBe(before);
    expect(history(t.remote)).not.toContain('tmp/s.json');
  }, T);

  test('G5 acceptRewind and restoreHost together are refused', async () => {
    const t = await rolledBack();
    await expect(syncRepo(t.agentDir, 'agent', 'x', { acceptRewind: true, restoreHost: true })).rejects.toThrow(/pass one of them/);
  }, T);

  test('G6 probe r2-04 3c: rewound.dropped counts each dropped commit once when a cycle repeats', async () => {
    const t = await rolledBack();
    let first = true;
    const opts = withTestHooks(
      {
        beforeIntegrate: async () => {
          if (!first) return;
          first = false;
          write(t.agentDir, 'notes/x.txt', 'edited during the call\n'); // the move would touch it: this cycle is busy
        },
      },
      { acceptRewind: true },
    );
    const r = await pullRepo(t.agentDir, 'agent', opts);
    expect(first).toBe(false);
    expect(r.rewound?.dropped).toBe(1);
  }, T);
});

// ---------------------------------------------------------------------------
// G7 / G8: name rules
// ---------------------------------------------------------------------------

describe('G7 G8 name and content rules', () => {
  test.each(['storage-state-report.json', 'portfolio.cookies.json', '.env.pdf', 'Storage-State.JSON'])(
    'G7 DataRepo refuses a resume named %s, which the layout .gitignore would keep out of git, naming the file',
    (name) => {
      const { app } = pair();
      for (const folder of ['profile/resumes', 'profile/resume-text']) {
        expect(() => app.writeBlob(`${folder}/${name}`, new Uint8Array([1]))).toThrow(name);
        expect(fs.existsSync(path.join(app.dir, folder, name))).toBe(false);
      }
    },
  );

  test('G7 names that the .gitignore does not match are written as before; the .gitignore comes from names.ts', async () => {
    const { app } = pair();
    for (const name of ['cv.pdf', 'Cookies.pdf', 'environment.pdf', 'state-report.json']) app.writeBlob(`profile/resumes/${name}`, new Uint8Array([1]));
    const t = await trio();
    expect(read(t.appDir, '.gitignore')).toBe(`${LAYOUT_IGNORE_LINES.join('\n')}\n`);
  }, T);

  /** A browser's cookie store, as SQLite writes it. */
  function cookieDb(file: string, table: string): Buffer {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE ${table}(host_key TEXT, name TEXT, encrypted_value BLOB, is_httponly INTEGER, samesite INTEGER)`);
    db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`).run('.example.com', 'sid', Buffer.from('x'), 1, 0);
    db.close();
    return fs.readFileSync(file);
  }

  test.each([
    ['Chromium', 'cookies', 'profile/resumes/Cookies'],
    ['Firefox', 'moz_cookies', 'profile/resumes/cookies.sqlite'],
    ['Chromium, outside the resume folders', 'cookies', 'notes/backup.db'],
  ])('G8 probe r2-07: a %s cookie database is refused by content', async (_name, table, rel) => {
    const t = await trio();
    const bytes = cookieDb(path.join(tmpDir(), 'db'), table);
    if (rel.startsWith('profile/resumes/')) t.app.writeBlob(rel, bytes);
    else write(t.appDir, rel, bytes);
    await expect(syncRepo(t.appDir, 'app', 'x')).rejects.toBeInstanceOf(SecretLeakError);
    expect(history(t.remote)).not.toContain(rel);
  }, T);

  test('G8 control: an SQLite file with no cookie table syncs', async () => {
    const t = await trio();
    const file = path.join(tmpDir(), 'notes.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE notes(text TEXT)');
    db.close();
    t.app.writeBlob('profile/resumes/notes.db', fs.readFileSync(file));
    expect((await syncRepo(t.appDir, 'app', 'x')).pushed).toBe(true);
  }, T);
});

// ---------------------------------------------------------------------------
// G9 / G10 / G11: small fixes
// ---------------------------------------------------------------------------

describe('G9 folders made by atomicWrite reach the disk', () => {
  afterEach(() => vi.restoreAllMocks());

  test.runIf(process.platform !== 'win32')('G9 the parent of each folder atomicWrite makes is flushed', () => {
    const root = tmpDir();
    const opened: string[] = [];
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    const fsync = vi.spyOn(fs, 'fsyncSync');
    atomicWrite(path.join(root, 'a', 'b', 'c.json'), '{}\n');
    for (const d of [path.join(root, 'a', 'b'), path.join(root, 'a'), root]) expect(opened).toContain(d);
    expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(4);
    opened.length = 0;
    atomicWrite(path.join(root, 'a', 'b', 'd.json'), '{}\n'); // no new folder: only the file and its own folder
    expect(opened).not.toContain(path.join(root, 'a'));
  });
});

test('G10 withoutLocalPaths rewrites the checkout path only, never a sibling or a path that contains it', () => {
  const dir = path.join(tmpDir(), 'app');
  fs.mkdirSync(dir);
  const text = `open '${dir}/applications/a1.json' (${dir}); see ${dir}2/x and /backup${dir}/y`;
  expect(withoutLocalPaths(dir, text)).toBe(`open 'applications/a1.json' (.); see ${dir}2/x and /backup${dir}/y`);
});

test('G11 redaction keeps the scheme of an address with both userinfo and a port', async () => {
  const err = (await cloneDataRepo('https://alice:ghp_S3cr3tT0ken@127.0.0.1:9/u/data.git', path.join(tmpDir(), 'c'), identity).catch(
    (e: unknown) => e,
  )) as GitError;
  expect(err).toBeInstanceOf(GitError);
  expect(err.message).toContain('https://***@127.0.0.1:9/u/data.git');
  expect(err.message).not.toContain('S3cr3t');
}, T);

// ---------------------------------------------------------------------------
// G12: tests for code no test held
// ---------------------------------------------------------------------------

describe('G12 tests that hold the new code', () => {
  test('G12 (N17) a stale lock is not taken over while another process holds the takeover guard', async () => {
    const gitDir = tmpDir();
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
    const lock = path.join(gitDir, 'cob-sync.lock');
    const guard = `${lock}.takeover`;
    const stale = JSON.stringify({ pid: deadPid, at: Date.now() });
    const live = JSON.stringify({ pid: process.ppid, at: Date.now(), token: 'other' });
    fs.writeFileSync(lock, stale);
    fs.writeFileSync(guard, live);
    let ran = false;
    await expect(withLock(gitDir, async () => void (ran = true))).rejects.toBeInstanceOf(SyncBusyError);
    expect(ran).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe(stale);
    expect(fs.readFileSync(guard, 'utf8')).toBe(live);
    // Once the other process is done with its guard, the stale lock is taken over.
    fs.rmSync(guard);
    await withLock(gitDir, async () => void (ran = true));
    expect(ran).toBe(true);
    expect(fs.readdirSync(gitDir)).toEqual([]);
  });

  test('G12 (N17) a guard left by a killed takeover is cleared, and the next call takes the stale lock over', async () => {
    const gitDir = tmpDir();
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
    const lock = path.join(gitDir, 'cob-sync.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, at: Date.now() }));
    fs.writeFileSync(`${lock}.takeover`, JSON.stringify({ pid: deadPid, at: Date.now() }));
    await expect(withLock(gitDir, async () => 1)).rejects.toBeInstanceOf(SyncBusyError);
    expect(fs.existsSync(`${lock}.takeover`)).toBe(false);
    expect(await withLock(gitDir, async () => 2)).toBe(2);
  });

  test('G12 (N19) a hand-fetched value that is not forward from a tip the record holds does not count as seen', async () => {
    // The record for the remote holds T1. A copy of the remote, made before T1, gets a commit Y; the user pulls Y
    // from the copy by hand and points origin back. Y was never on the remote: it is pushed, not taken for a rewind.
    const t = await trio();
    const copy = path.join(tmpDir(), 'copy.git');
    execFileSync('git', ['clone', '-q', '--bare', t.remote, copy]);
    write(t.appDir, 'a.txt', 'a\n');
    await syncRepo(t.appDir, 'app', 'T1');
    const side = path.join(tmpDir(), 'side');
    sh(path.dirname(side), 'clone', '-q', copy, side);
    write(side, 'y.txt', 'y\n');
    sh(side, 'add', 'y.txt');
    sh(side, 'commit', '-q', '-m', 'Y');
    sh(side, 'push', '-q', 'origin', 'main');
    sh(t.appDir, 'remote', 'set-url', 'origin', copy);
    sh(t.appDir, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
    sh(t.appDir, 'remote', 'set-url', 'origin', t.remote);
    const r = await syncRepo(t.appDir, 'app', 'after');
    expect(r).toMatchObject({ pushed: true, rewound: null });
    expect(tree(t.remote)).toMatch(/^y\.txt$/m);
  }, T);

  test('G12 (N09) an unreadable application file makes the posting lookup refuse, naming the file', () => {
    const { app, agent, dir } = pair();
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 1 }));
    fs.mkdirSync(path.join(dir, 'applications'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'applications', 'a-broken.json'), '{"id":"a-broken", <<<<<<< HEAD');
    expect(() => applicationForPosting(agent, { link: 'https://careers.example.com/jobs/9' })).toThrow(/applications\/a-broken\.json/);
    expect(() => beginSubmit(agent, appInput({ link: 'https://careers.example.com/jobs/9' }), intent)).toThrow(ApplicationStateError);
    expect(agent.list('application').items).toEqual([]);
  });
});
