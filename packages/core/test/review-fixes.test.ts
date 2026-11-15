// Regression tests for the final whole-branch review (cob-final, rows F1-F24). Each test names its row.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as core from '../src/index.ts';
import {
  ApplicationStateError,
  applicationForPosting,
  beginSubmit,
  recordOutcome,
  upsertRole,
  type ParkInput,
  type RoleInput,
} from '../src/applications.ts';
import { createCommand, finishCommand, queuedCommands } from '../src/commands.ts';
import { CONFIRMED } from '../src/confidence.ts';
import {
  GitError,
  HostRewoundError,
  MIN_GIT_VERSION,
  SecretLeakError,
  SyncBusyError,
  cloneDataRepo,
  initPrivateRepo,
  pullRepo,
  sameFolder,
  syncRepo,
  withLock,
  type SyncOptions,
} from '../src/git.ts';
import { safeFileName } from '../src/ids.ts';
import { inboxRows } from '../src/inbox.ts';
import { PointOpError, applyPointOp } from '../src/points.ts';
import { processQueue } from '../src/process.ts';
import { locateLocal } from '../src/remote-key.ts';
import { DataRepo } from '../src/repo.ts';
import { atomicWrite } from '../src/repo-paths.ts';
import { PointSchema, type Application } from '../src/schema.ts';
import { T0, T1, bare, pair, sample, tmpDir } from './helpers.ts';

const T = 60_000;
const identity = { name: 'Test User', email: 'test@example.com' };
const linux = process.platform === 'linux';
const SRC = path.resolve(import.meta.dirname, '../src');

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'user.name=Hand', '-c', 'user.email=hand@example.com', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
const write = (dir: string, rel: string, text: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const tree = (repo: string) => sh(repo, 'ls-tree', '-r', '--name-only', 'main');
const history = (repo: string) => sh(repo, 'log', '--all', '--name-only', '--format=');
const posting = { organization: 'Example Foods', title: 'Supervisor', link: 'https://careers.example.com/jobs/1' };
const intent = { resumeFile: 'cv.pdf', points: [{ pointId: 'p', rev: 1, field: 'Notice period' }] };
const point = sample.point({ id: 'p', kind: 'answer', text: '30 days', rank: CONFIRMED, rev: 1 });

/** A remote, the app's checkout (init) and the agent's checkout (clone). */
async function trio() {
  const remote = bare();
  const appDir = path.join(tmpDir(), 'app');
  const agentDir = path.join(tmpDir(), 'agent');
  await initPrivateRepo(appDir, { identity, remote });
  await cloneDataRepo(remote, agentDir, identity);
  return { remote, appDir, agentDir, app: new DataRepo(appDir, 'app'), agent: new DataRepo(agentDir, 'agent') };
}

/** Everything a refused call must leave as it was. */
function snapshot(dir: string) {
  return {
    head: sh(dir, 'rev-parse', 'HEAD'),
    main: sh(dir, 'rev-parse', 'refs/heads/main'),
    index: sh(dir, 'ls-files', '-s'),
    status: sh(dir, 'status', '--porcelain', '--untracked-files=all'),
  };
}

// ---------------------------------------------------------------------------
// F1 / F2: one application per posting
// ---------------------------------------------------------------------------

describe('F1 one application per posting', () => {
  const states: [string, Partial<Application>][] = [
    ['submitting', { state: 'submitting', park: null, pendingSubmission: { resumeFile: 'cv.pdf', points: [], startedAt: T0 } }],
    ['submitted', { state: 'submitted', park: null, submission: { resumeFile: 'cv.pdf', points: [], submittedAt: T0 } }],
    ['parked', { state: 'parked' }],
    [
      'parked with afterSubmit',
      {
        state: 'parked',
        park: { type: 'error', at: T0, afterSubmit: true },
        pendingSubmission: { resumeFile: 'cv.pdf', points: [], startedAt: T0 },
      },
    ],
    ['done', { state: 'done', park: null, closedAt: T0 }],
    ['dropped', { state: 'dropped', park: null, closedAt: T0 }],
    ['skipped', { state: 'skipped', park: null, skip: { hardNoPointId: 'h', at: T0 } }],
  ];

  test.each(states)('F1 beginSubmit refuses a posting whose application is %s, matched by link, and writes nothing', (_name, extra) => {
    const { app, agent } = pair();
    app.put('point', point);
    agent.put('application', sample.application({ id: 'a-old', ...extra }));
    const before = agent.list('application').items;
    for (const link of [posting.link, `${posting.link}/?utm_source=feed#x`, 'https://CAREERS.example.com/jobs/1']) {
      expect(() => beginSubmit(agent, { ...posting, link }, intent, new Date(T1))).toThrow(ApplicationStateError);
      expect(() => beginSubmit(agent, { ...posting, link }, intent, new Date(T1))).toThrow(/a-old/);
    }
    expect(agent.list('application').items).toEqual(before);
  });

  test.each(states)('F1 beginSubmit refuses a posting whose application is %s, matched by roleId', (_name, extra) => {
    const { app, agent } = pair();
    app.put('point', point);
    agent.put('application', sample.application({ id: 'a-old', roleId: 'r-0123456789abcdef', link: 'https://other.example.com/x', ...extra }));
    const input = { ...posting, roleId: 'r-0123456789abcdef', link: 'https://careers.example.com/jobs/99' };
    expect(() => beginSubmit(agent, input, intent, new Date(T1))).toThrow(/a-old/);
    expect(agent.list('application').items).toHaveLength(1);
  });

  test('F1 an application recorded with a roleId matches a later link whose roleIdFor is that id', () => {
    const { app, agent } = pair();
    app.put('point', point);
    agent.put('application', sample.application({ id: 'a-old', roleId: core.roleIdFor(posting.link), link: 'https://elsewhere.example.com/apply' }));
    expect(() => beginSubmit(agent, posting, intent, new Date(T1))).toThrow(/a-old/);
  });

  test('F1 a posting with no application is accepted as before, and another posting is unaffected', () => {
    const { app, agent } = pair();
    app.put('point', point);
    agent.put('application', sample.application({ id: 'a-old', link: 'https://careers.example.com/jobs/2' }));
    const a = beginSubmit(agent, posting, intent, new Date(T1));
    expect(a.state).toBe('submitting');
    expect(agent.list('application').items).toHaveLength(2);
  });

  test('F1 the retry path through { applicationId } still works for an existing application', () => {
    const { app, agent, seedPark } = pair();
    app.put('point', point);
    seedPark('a-old', { type: 'captcha' });
    expect(beginSubmit(agent, { applicationId: 'a-old' }, intent, new Date(T1)).state).toBe('submitting');
  });

  test('F1 probe p02: a crash after the click, then the same posting again, ends with one application and one click', () => {
    const { app, agent } = pair();
    app.put('point', point);
    let clicks = 0;
    const a1 = beginSubmit(agent, posting, intent, new Date('2026-11-11T09:00:00Z'));
    clicks++; // the run stops after the click
    processQueue(agent, new Date('2026-11-11T10:00:00Z'));
    expect(inboxRows(agent).map((r) => [r.applicationId, r.rowType])).toEqual([[a1.id, 'error_after_submit']]);
    // The applier loop meets the same open role again (with a tracking parameter).
    try {
      beginSubmit(agent, { ...posting, link: `${posting.link}?utm_source=feed` }, intent, new Date('2026-11-11T10:00:01Z'));
      clicks++;
    } catch (e) {
      expect(e).toBeInstanceOf(ApplicationStateError);
      expect((e as Error).message).toContain(a1.id);
    }
    // recordOutcome with the posting does not make a second record either.
    expect(() => recordOutcome(agent, posting, { type: 'park', park: { type: 'captcha' } }, new Date('2026-11-11T12:00:00Z'))).toThrow(
      ApplicationStateError,
    );
    expect(clicks).toBe(1);
    expect(agent.list('application').items.map((a) => a.id)).toEqual([a1.id]);
  });
});

describe('F2 the posting lookup', () => {
  test('F2 applicationForPosting returns the application for a link or a roleId, or null', () => {
    const { app, agent } = pair();
    app.put('point', point);
    expect(applicationForPosting(agent, { link: posting.link })).toBeNull();
    const a = beginSubmit(agent, posting, intent, new Date(T0));
    expect(applicationForPosting(agent, { link: `${posting.link}?utm_campaign=x` })?.id).toBe(a.id);
    expect(applicationForPosting(agent, { roleId: core.roleIdFor(posting.link) })?.id).toBe(a.id);
    expect(applicationForPosting(agent, { link: 'https://careers.example.com/jobs/2' })).toBeNull();
    expect(applicationForPosting(agent, { roleId: 'r-ffffffffffffffff' })).toBeNull();
    expect(core.applicationForPosting).toBe(applicationForPosting);
  });
});

// ---------------------------------------------------------------------------
// F3: input types declared by hand, unknown keys refused
// ---------------------------------------------------------------------------

describe('F3 park and role inputs', () => {
  // Compile-time checks (npm run typecheck): each line below must be a type error.
  function _typeChecks(agent: DataRepo) {
    // @ts-expect-error a misspelt park key
    recordOutcome(agent, { applicationId: 'a' }, { type: 'park', park: { type: 'error', aftersubmit: true } });
    // @ts-expect-error a snake_case park key
    recordOutcome(agent, { applicationId: 'a' }, { type: 'park', park: { type: 'error', after_submit: true } });
    // @ts-expect-error a capitalised park key
    recordOutcome(agent, { applicationId: 'a' }, { type: 'park', park: { type: 'error', AfterSubmit: true } });
    // @ts-expect-error a park needs a type
    recordOutcome(agent, { applicationId: 'a' }, { type: 'park', park: {} });
    // @ts-expect-error a role needs its fields
    upsertRole(agent, {});
    // @ts-expect-error a misspelt role key
    upsertRole(agent, { titel: 'x', organization: 'o', sourceId: 's', link: 'https://e.example.com/1', applyPath: 'form' });
    const park: ParkInput = { type: 'error', site: 's', fields: ['f'], contact: 'c', note: 'n', afterSubmit: true };
    const role: RoleInput = { title: 't', organization: 'o', sourceId: 's', link: 'https://e.example.com/1', applyPath: 'form' };
    return [park, role];
  }
  void _typeChecks;

  test.each(['aftersubmit', 'after_submit', 'AfterSubmit', 'colour'])(
    'F3 an unknown park key (%s) is refused at run time with an error naming it, and nothing is written',
    (key) => {
      const { app, agent } = pair();
      app.put('point', point);
      const b = beginSubmit(agent, posting, intent, new Date(T0));
      const park = { type: 'error', [key]: true, note: 'Error page after submit' } as unknown as ParkInput;
      expect(() => recordOutcome(agent, { applicationId: b.id }, { type: 'park', park }, new Date(T1))).toThrow(new RegExp(key));
      expect(agent.get('application', b.id)).toEqual(b);
    },
  );

  test('F3 a park with a bad value is refused at run time', () => {
    const { agent, seedPark } = pair();
    seedPark('a1', { type: 'captcha' });
    for (const park of [{}, { type: 'nope' }, { type: 'error', fields: 'x' }, { type: 'error', afterSubmit: 'yes' }]) {
      expect(() => recordOutcome(agent, { applicationId: 'a1' }, { type: 'park', park: park as unknown as ParkInput })).toThrow();
    }
  });

  test('F3 probe p03: with a misspelt afterSubmit there is no second click', () => {
    for (const key of ['aftersubmit', 'after_submit', 'AfterSubmit']) {
      const { app, agent } = pair();
      app.put('point', point);
      const b = beginSubmit(agent, posting, intent, new Date('2026-11-11T09:00:00Z'));
      const park = { type: 'error', [key]: true, note: 'Error page after submit' } as unknown as ParkInput;
      expect(() => recordOutcome(agent, { applicationId: b.id }, { type: 'park', park }, new Date('2026-11-11T09:00:05Z'))).toThrow();
      createCommand(app, { verb: 'retry', target: b.id, payload: {} }, new Date('2026-11-11T09:10:00Z'));
      expect(processQueue(agent, new Date('2026-11-11T09:11:00Z'))).toEqual([]);
      expect(inboxRows(app)[0]!.rowType).toBe('error_after_submit');
      expect(() => beginSubmit(agent, { applicationId: b.id }, intent, new Date('2026-11-11T09:11:01Z'))).toThrow(ApplicationStateError);
    }
  });

  test('F3 upsertRole with nothing it needs, or an unknown key, is refused at run time', () => {
    const { agent } = pair();
    expect(() => upsertRole(agent, {} as unknown as RoleInput)).toThrow();
    const typo = { titel: 'x', link: 'https://careers.example.com/jobs/9', organization: 'o', sourceId: 's', applyPath: 'form' };
    expect(() => upsertRole(agent, typo as unknown as RoleInput)).toThrow(/titel/);
    const extra = { title: 'x', link: 'https://careers.example.com/jobs/9', organization: 'o', sourceId: 's', applyPath: 'form', salary: 1 };
    expect(() => upsertRole(agent, extra as unknown as RoleInput)).toThrow(/salary/);
    expect(agent.list('role').items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F4 / F5: a repository that is not a data repo
// ---------------------------------------------------------------------------

/** A repository with code on `main` and no cob.json: the public engine repo, or a fork of it. */
function codeRepo(): string {
  const other = path.join(tmpDir(), 'engine-fork.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
  const seed = tmpDir();
  sh(seed, 'init', '-q', '-b', 'main');
  write(seed, 'README.md', '# Company of Bots (public code)\n');
  write(seed, 'packages/x.ts', 'export {}\n');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'public code');
  sh(seed, 'push', '-q', other, 'main');
  return other;
}

describe('F4 cloneDataRepo checks for a data repo', () => {
  test('F4 a repository with no cob.json is refused and the clone folder is removed', async () => {
    const other = codeRepo();
    const before = sh(other, 'rev-parse', 'main');
    const target = path.join(tmpDir(), 'agent');
    const err = await cloneDataRepo(other, target, identity).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toMatch(/cob\.json|data repo/);
    expect(fs.existsSync(target)).toBe(false);
    expect(sh(other, 'rev-parse', 'main')).toBe(before);
  }, T);

  test('F4 an empty folder that existed before the call is left exactly as it was', async () => {
    const other = codeRepo();
    const target = tmpDir();
    const mode = fs.statSync(target).mode;
    await expect(cloneDataRepo(other, target, identity)).rejects.toBeInstanceOf(GitError);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode).toBe(mode);
  }, T);

  test('F4 a data repo with an unsupported schema version is refused, and nothing is pushed', async () => {
    const { remote, appDir } = await trio();
    write(appDir, 'cob.json', JSON.stringify({ schemaVersion: 2, createdAt: T0 }, null, 2) + '\n');
    sh(appDir, 'commit', '-q', '-am', 'from a newer app');
    sh(appDir, 'push', '-q', 'origin', 'main');
    const before = sh(remote, 'rev-parse', 'main');
    const target = path.join(tmpDir(), 'agent2');
    await expect(cloneDataRepo(remote, target, identity)).rejects.toThrow(/version 2/);
    expect(fs.existsSync(target)).toBe(false);
    expect(sh(remote, 'rev-parse', 'main')).toBe(before);
  }, T);

  test('F4 a cob.json that is not a file (a link or a folder) is refused', async () => {
    const other = path.join(tmpDir(), 'odd.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
    const seed = tmpDir();
    sh(seed, 'init', '-q', '-b', 'main');
    write(seed, 'cob.json/x', '{}');
    sh(seed, 'add', '-A');
    sh(seed, 'commit', '-q', '-m', 'odd');
    sh(seed, 'push', '-q', other, 'main');
    const target = path.join(tmpDir(), 'agent3');
    await expect(cloneDataRepo(other, target, identity)).rejects.toBeInstanceOf(GitError);
    expect(fs.existsSync(target)).toBe(false);
  }, T);
});

describe('F5 sync refuses a checkout with no cob.json', () => {
  test('F5 probe p04: a hand clone of a code repository; syncRepo and pullRepo change nothing and nothing reaches it', async () => {
    const other = codeRepo();
    const dir = path.join(tmpDir(), 'agent');
    sh(path.dirname(dir), 'clone', '-q', other, dir);
    const agent = new DataRepo(dir, 'agent'); // a fresh folder to DataRepo
    recordOutcome(agent, posting, { type: 'park', park: { type: 'sign_in', site: 'jobs.example.com' } });
    const before = snapshot(dir);
    const remoteBefore = sh(other, 'rev-parse', 'main');
    for (const call of [() => syncRepo(dir, 'agent', 'agent run'), () => pullRepo(dir, 'agent')]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitError);
      expect((err as Error).message).toMatch(/cob\.json|not a data repo/);
      expect(snapshot(dir)).toEqual(before);
    }
    expect(sh(other, 'rev-parse', 'main')).toBe(remoteBefore);
    expect(tree(other)).not.toMatch(/applications\//);
  }, T);

  test('F5 a checkout core made is unaffected', async () => {
    const t = await trio();
    expect((await syncRepo(t.appDir, 'app', 'noop')).pushed).toBe(true);
    expect((await pullRepo(t.agentDir, 'agent')).pushed).toBe(false);
  }, T);
});

// ---------------------------------------------------------------------------
// F6: resume names and record ids against the secret-name rule
// ---------------------------------------------------------------------------

describe('F6 one secret-name rule', () => {
  test('F6 probe p05: a resume name DataRepo accepts never stops a later sync', async () => {
    const t = await trio();
    const names = ['Cookies.pdf', 'secret.docx', 'secrets', 'cookie-decorator-cv.pdf', 'cloud-storage-state-of-the-art.pdf', 'My Résumé.pdf', '.env.pdf'];
    for (const upload of names) {
      const name = safeFileName(upload);
      t.app.writeBlob(`profile/resumes/${name}`, new Uint8Array([37, 80, 68, 70]));
      t.app.writeBlob(`profile/resume-text/${name}.txt`, new TextEncoder().encode('Worked at Example Foods.\n'));
    }
    expect((await syncRepo(t.appDir, 'app', 'resumes')).pushed).toBe(true);
    createCommand(t.app, { verb: 'run_role', target: null, payload: { role: 'finder' } });
    expect((await syncRepo(t.appDir, 'app', 'run now')).pushed).toBe(true);
    const onRemote = tree(t.remote);
    for (const upload of names) expect(onRemote).toContain(`profile/resumes/${safeFileName(upload)}`);
    expect(onRemote).toMatch(/^commands\//m);
  }, T);

  test('F6 the content rule still applies in the resume folders', async () => {
    const t = await trio();
    const cookies = JSON.stringify([{ name: 'sid', value: 'v', sameSite: 'Lax', httpOnly: true }]);
    t.app.writeBlob('profile/resumes/cv.pdf', new TextEncoder().encode(cookies));
    await expect(syncRepo(t.appDir, 'app', 'resume')).rejects.toBeInstanceOf(SecretLeakError);
    expect(history(t.remote)).not.toContain('profile/resumes/cv.pdf');
  }, T);

  test('F6 a record id the name rule refuses is refused by put, with an error naming it', () => {
    const { app } = pair();
    for (const id of ['cookies', 'secret', 'storage-state-1', 'wake-token', '.env']) {
      expect(() => app.put('source', sample.source({ id }))).toThrow(new RegExp(`sources/${id.replace('.', '\\.')}\\.json`));
      expect(fs.existsSync(path.join(app.dir, 'sources', `${id}.json`))).toBe(false);
    }
    expect(() => app.put('source', sample.source({ id: 'cookie-jar-shop' }))).not.toThrow();
  });

  test('F6 outside the resume folders the name rule still stops a sync', async () => {
    const t = await trio();
    write(t.appDir, 'notes/Cookies.pdf', '%PDF');
    await expect(syncRepo(t.appDir, 'app', 'x')).rejects.toBeInstanceOf(SecretLeakError);
  }, T);
});

// ---------------------------------------------------------------------------
// F7 / F8: a host rewind is never followed silently
// ---------------------------------------------------------------------------

/** Move the host's `main` back to `sha`, as a restore from backup would. */
const restoreHost = (remote: string, sha: string) => sh(remote, 'update-ref', 'refs/heads/main', sha);

describe('F7 F8 host rewinds', () => {
  test('F7 probe p09 part 2: after a host restore the agent keeps `submitted` and no second Work appears', async () => {
    const t = await trio();
    t.app.put('point', point);
    await syncRepo(t.appDir, 'app', 'profile');
    await pullRepo(t.agentDir, 'agent');
    const a = recordOutcome(t.agent, posting, { type: 'park', park: { type: 'sign_in', site: 'jobs.example.com' } });
    await syncRepo(t.agentDir, 'agent', 'parked');
    await pullRepo(t.appDir, 'app');
    createCommand(t.app, { verb: 'retry', target: a.id, payload: {} });
    await syncRepo(t.appDir, 'app', 'retry');
    const backup = sh(t.remote, 'rev-parse', 'main').trim();
    await pullRepo(t.agentDir, 'agent');
    let clicks = 0;
    for (const w of processQueue(t.agent)) {
      if (w.type !== 'retry') continue;
      beginSubmit(t.agent, { applicationId: w.applicationId }, intent);
      clicks++;
      recordOutcome(t.agent, { applicationId: w.applicationId }, { type: 'submitted', ...intent });
      finishCommand(t.agent, w.commandId, 'done', 'submitted');
    }
    expect((await syncRepo(t.agentDir, 'agent', 'submitted')).pushed).toBe(true);
    restoreHost(t.remote, backup);
    const before = snapshot(t.agentDir);
    const err = await pullRepo(t.agentDir, 'agent').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostRewoundError);
    expect((err as HostRewoundError).dropped).toBe(1);
    expect((err as HostRewoundError).keptUnder).toMatch(/^refs\/cob\/seen\//);
    expect(snapshot(t.agentDir)).toEqual(before);
    expect(sh(t.remote, 'rev-parse', 'main').trim()).toBe(backup);
    expect(t.agent.get('application', a.id)!.state).toBe('submitted');
    expect(processQueue(t.agent)).toEqual([]);
    expect(clicks).toBe(1);
  }, T);

  test('F7 syncRepo refuses too, with local changes neither committed nor staged, and the remote unchanged', async () => {
    const t = await trio();
    write(t.appDir, 'notes/a.txt', 'a\n');
    await syncRepo(t.appDir, 'app', 'a');
    const backup = sh(t.remote, 'rev-parse', 'main').trim();
    write(t.appDir, 'notes/b.txt', 'b\n');
    await syncRepo(t.appDir, 'app', 'b');
    restoreHost(t.remote, backup);
    write(t.appDir, 'notes/c.txt', 'c\n');
    t.app.put('source', sample.source({ id: 's9' }));
    const before = snapshot(t.appDir);
    const err = await syncRepo(t.appDir, 'app', 'c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostRewoundError);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toMatch(/1 commit/);
    expect(snapshot(t.appDir)).toEqual(before);
    expect(sh(t.remote, 'rev-parse', 'main').trim()).toBe(backup);
    // A second try refuses again: nothing was counted as accepted.
    await expect(syncRepo(t.appDir, 'app', 'c')).rejects.toBeInstanceOf(HostRewoundError);
    expect(snapshot(t.appDir)).toEqual(before);
  }, T);

  test('F7 a force-push that rewrites the host history is a rewind too', async () => {
    const t = await trio();
    write(t.appDir, 'notes/transcript.txt', 'private\n');
    await syncRepo(t.appDir, 'app', 'transcript');
    await pullRepo(t.agentDir, 'agent');
    const third = path.join(tmpDir(), 'third');
    sh(path.dirname(third), 'clone', '-q', t.remote, third);
    sh(third, 'reset', '-q', '--hard', 'HEAD~1');
    write(third, 'other.txt', 'other\n');
    sh(third, 'add', 'other.txt');
    sh(third, 'commit', '-q', '-m', 'other');
    sh(third, 'push', '-q', '--force', 'origin', 'main');
    await expect(syncRepo(t.agentDir, 'agent', 'x')).rejects.toBeInstanceOf(HostRewoundError);
    expect(fs.existsSync(path.join(t.agentDir, 'notes/transcript.txt'))).toBe(true);
  }, T);

  test('F7 a host rewrite that drops nothing from this checkout’s main is not a rewind', async () => {
    const t = await trio();
    const start = sh(t.remote, 'rev-parse', 'main').trim();
    write(t.appDir, 'notes/transcript.txt', 'private\n');
    await syncRepo(t.appDir, 'app', 'transcript'); // the agent never pulls it
    restoreHost(t.remote, start);
    write(t.agentDir, 'work.txt', 'work\n');
    const r = await syncRepo(t.agentDir, 'agent', 'work');
    expect(r).toMatchObject({ pushed: true, rewound: null });
    expect(history(t.remote)).not.toContain('transcript');
  }, T);

  test('F8 with acceptRewind the remote is followed, the dropped commits are kept under refs/cob/seen, and the count is reported', async () => {
    const t = await trio();
    write(t.appDir, 'notes/transcript.txt', 'private\n');
    await syncRepo(t.appDir, 'app', 'transcript');
    const start = sh(t.remote, 'rev-parse', 'main~1').trim();
    write(t.appDir, 'notes/more.txt', 'more\n');
    await syncRepo(t.appDir, 'app', 'more');
    const dropped = sh(t.appDir, 'rev-list', 'main', `^${start}`).trim().split('\n');
    restoreHost(t.remote, start);
    write(t.appDir, 'new.txt', 'new\n');
    const r = await syncRepo(t.appDir, 'app', 'new', { acceptRewind: true });
    expect(r.pushed).toBe(true);
    expect(r.rewound).toEqual({ dropped: 2, keptUnder: expect.stringMatching(/^refs\/cob\/seen\/[0-9a-f]{32}$/) });
    for (const c of dropped) expect(() => sh(t.appDir, 'merge-base', '--is-ancestor', c, r.rewound!.keptUnder)).not.toThrow();
    expect(history(t.remote)).not.toContain('transcript');
    expect(tree(t.remote)).toContain('new.txt');
    expect(fs.existsSync(path.join(t.appDir, 'notes/transcript.txt'))).toBe(false);
    // The next sync is ordinary.
    expect((await syncRepo(t.appDir, 'app', 'again')).rewound).toBeNull();
  }, T);

  test('F8 pullRepo takes acceptRewind too, and a sync with nothing dropped reports rewound: null', async () => {
    const t = await trio();
    expect((await pullRepo(t.agentDir, 'agent')).rewound).toBeNull();
    write(t.appDir, 'notes/transcript.txt', 'private\n');
    await syncRepo(t.appDir, 'app', 'transcript');
    await pullRepo(t.agentDir, 'agent');
    restoreHost(t.remote, sh(t.remote, 'rev-parse', 'main~1').trim());
    const r = await pullRepo(t.agentDir, 'agent', { acceptRewind: true });
    expect(r.rewound).toMatchObject({ dropped: 1 });
    expect(sh(t.agentDir, 'rev-parse', 'HEAD')).toBe(sh(t.remote, 'rev-parse', 'main'));
  }, T);
});

// ---------------------------------------------------------------------------
// F9: one path resolver
// ---------------------------------------------------------------------------

describe('F9 canonical paths', () => {
  afterEach(() => vi.restoreAllMocks());

  test('F9 sameFolder compares through the resolver: a lower-case drive letter or an 8.3 short name is the same folder', () => {
    const canonical = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\data';
    const spellings = ['c:\\users\\runneradmin\\appdata\\local\\temp\\data', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\data', canonical];
    const resolver = (p: string) => (path.win32.normalize(p).toLowerCase().replace('runner~1', 'runneradmin') === canonical.toLowerCase() ? canonical : p);
    for (const s of spellings) expect(sameFolder('C:/Users/runneradmin/AppData/Local/Temp/data', s, resolver)).toBe(true);
    expect(sameFolder(canonical, 'C:\\Users\\someone\\data', resolver)).toBe(false);
  });

  test('F9 locateLocal resolves through the resolver it is given', () => {
    const resolver = (p: string) => {
      if (p.toLowerCase() === 'c:\\users\\me\\data') return 'C:\\Users\\Me\\data';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    expect(locateLocal('c:\\users\\me\\data', resolver)).toBe('C:\\Users\\Me\\data');
  });

  test('F9 init, clone, sync and pull never use the JavaScript realpath, only the native one', async () => {
    const native = fs.realpathSync.native;
    const used = vi.fn(native);
    const js = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('JavaScript realpathSync used');
    });
    Object.assign(fs.realpathSync, { native: used });
    try {
      const t = await trio();
      write(t.appDir, 'a.txt', 'a\n');
      expect((await syncRepo(t.appDir, 'app', 'a')).pushed).toBe(true);
      await pullRepo(t.agentDir, 'agent');
      expect(js).not.toHaveBeenCalled();
      expect(used).toHaveBeenCalled();
    } finally {
      js.mockRestore();
    }
  }, T);
});

// ---------------------------------------------------------------------------
// F10 / F11: R26 with no fixed window, and a constant cost
// ---------------------------------------------------------------------------

describe('F10 F11 the seen record', () => {
  /** Grok's probe-fix3 case: the record stays at init; the user pulls S, the host drops it, then `extra` fetches by hand. */
  async function buried(extra: number) {
    const remote = bare();
    const appDir = path.join(tmpDir(), 'app');
    await initPrivateRepo(appDir, { identity, remote });
    const side = path.join(tmpDir(), 'side');
    sh(path.dirname(side), 'clone', '-q', remote, side);
    write(side, 'notes/transcript.txt', 'SECRET-TRANSCRIPT\n');
    sh(side, 'add', 'notes/transcript.txt');
    sh(side, 'commit', '-q', '-m', 'transcript');
    sh(side, 'push', '-q', 'origin', 'main');
    sh(appDir, 'pull', '-q', '--no-rebase', 'origin', 'main');
    sh(side, 'reset', '-q', '--hard', 'HEAD~1');
    sh(side, 'push', '-q', '--force', 'origin', 'main');
    for (let i = 1; i <= extra; i++) {
      write(side, 'n.txt', `n${i}\n`);
      sh(side, 'add', 'n.txt');
      sh(side, 'commit', '-q', '-m', `c${i}`);
      sh(side, 'push', '-q', 'origin', 'main');
      sh(appDir, 'fetch', '-q', 'origin');
    }
    write(appDir, 'work.txt', 'work\n');
    return { remote, appDir };
  }

  test('F10 a commit the user pulled by hand, then the host dropped, is never pushed back after 60 later fetches', async () => {
    const { remote, appDir } = await buried(60);
    const before = snapshot(appDir);
    await expect(syncRepo(appDir, 'app', 'work')).rejects.toBeInstanceOf(HostRewoundError);
    expect(snapshot(appDir)).toEqual(before);
    expect(history(remote)).not.toContain('transcript');
    const r = await syncRepo(appDir, 'app', 'work', { acceptRewind: true });
    expect(r.pushed).toBe(true);
    expect(r.rewound?.dropped).toBe(1);
    expect(history(remote)).not.toContain('transcript');
    expect(tree(remote)).toContain('work.txt');
  }, 120_000);

  test.runIf(linux)('F11 a no-op sync after 120 sync rounds starts at most 5 more git processes than on a young checkout', async () => {
    const t = await trio();
    const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    const shim = tmpDir();
    const countFile = path.join(shim, 'count.log');
    fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\necho "$*" >> "${countFile}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const count = async (fn: () => Promise<unknown>) => {
      const saved = process.env.PATH;
      fs.writeFileSync(countFile, '');
      process.env.PATH = `${shim}${path.delimiter}${saved}`;
      try {
        await fn();
      } finally {
        process.env.PATH = saved;
      }
      return fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length;
    };
    const youngPull = await count(() => pullRepo(t.agentDir, 'agent'));
    const youngSync = await count(() => syncRepo(t.agentDir, 'agent', 'noop'));
    const side = path.join(tmpDir(), 'side');
    sh(path.dirname(side), 'clone', '-q', t.remote, side);
    for (let i = 0; i < 120; i++) {
      write(side, `commands/c${i}.txt`, `${i}\n`);
      sh(side, 'add', '-A');
      sh(side, 'commit', '-q', '-m', `round ${i}`);
      sh(side, 'push', '-q', 'origin', 'main');
      await pullRepo(t.agentDir, 'agent');
    }
    const oldPull = await count(() => pullRepo(t.agentDir, 'agent'));
    const oldSync = await count(() => syncRepo(t.agentDir, 'agent', 'noop'));
    expect(oldPull - youngPull).toBeLessThanOrEqual(5);
    expect(oldSync - youngSync).toBeLessThanOrEqual(5);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// F12: no absolute path in a command's note
// ---------------------------------------------------------------------------

test('F12 probe p08: a failed command’s note carries the repo-relative path, never the absolute one', () => {
  const { dir, app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  const c = createCommand(app, { verb: 'done', target: 'a1', payload: {} });
  fs.writeFileSync(path.join(dir, 'applications/a1.json'), '{"id":"a1","note":"salary 95k" <<<<<<< HEAD');
  processQueue(agent);
  const note = agent.get('command', c.id)!.resultNote!;
  expect(note).toMatch(/^failed: /);
  expect(note).toContain('applications/a1.json');
  expect(note).not.toContain(dir);
  expect(note).not.toContain(fs.realpathSync(dir));
  expect(note).not.toContain(os.tmpdir());
});

test('F12 a note from processQueue’s own catch is repo-relative too', () => {
  const { dir, app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  const c = createCommand(app, { verb: 'status', target: 'a1', payload: { kind: 'note', text: 'hi' } });
  // The application file turns into a folder: writing it throws an fs error carrying the full path.
  vi.spyOn(agent, 'put').mockImplementationOnce(() => {
    throw new Error(`EISDIR: illegal operation on a directory, open '${path.join(dir, 'applications', 'a1.json')}'`);
  });
  processQueue(agent);
  vi.restoreAllMocks();
  const note = agent.get('command', c.id)!.resultNote!;
  expect(note).toContain('applications/a1.json');
  expect(note).not.toContain(dir);
});

// ---------------------------------------------------------------------------
// F13: credentials never in a GitError
// ---------------------------------------------------------------------------

test('F13 probe p06: credentials in userinfo, a query string or a path segment never appear in a GitError', async () => {
  const TOKEN = 'ghp_S3cr3tT0ken';
  const PASS = 'p@ss/w0rd:x';
  const urls = [
    `https://alice:${TOKEN}@127.0.0.1:9/u/data.git`,
    `https://${TOKEN}@127.0.0.1:9/u/data.git`,
    `https://alice:${PASS}@127.0.0.1:9/u/data.git`,
    `https://alice:${encodeURIComponent(PASS)}@127.0.0.1:9/u/data.git`,
    `ssh://alice:${TOKEN}@127.0.0.1:9/u/data.git`,
    `http://127.0.0.1:9/u/data.git?access_token=${TOKEN}`,
    `http://127.0.0.1:9/u/data.git?private_token=x&token=${TOKEN}`,
    `https://127.0.0.1:9/${TOKEN}@u/data.git`,
    `http://127.0.0.1:9/${TOKEN}/u/data.git`,
    `https://127.0.0.1:9/u/glpat-abcdefghij0123/data.git`,
    `alice:${TOKEN}@127.0.0.1:u/data.git`,
  ];
  for (const url of urls) {
    const errors: unknown[] = [];
    errors.push(await cloneDataRepo(url, path.join(tmpDir(), 'c'), identity).catch((e: unknown) => e));
    errors.push(await initPrivateRepo(path.join(tmpDir(), 'i'), { identity, remote: url }).catch((e: unknown) => e));
    for (const e of errors) {
      expect(e).toBeInstanceOf(GitError);
      const g = e as GitError;
      const all = [g.message, g.stderr, ...g.args].join('\n');
      expect(all, url).not.toContain(TOKEN);
      expect(all, url).not.toContain('glpat-abcdefghij0123');
      expect(all, url).not.toMatch(/p@ss|w0rd|p%40ss/);
    }
  }
}, 120_000);

test('F13 a sync whose origin holds credentials keeps them out of the error', async () => {
  const t = await trio();
  const TOKEN = 'ghp_S3cr3tT0ken';
  for (const url of [`https://alice:p@ss/w0rd:${TOKEN}@127.0.0.1:9/u/d.git`, `http://127.0.0.1:9/u/d.git?token=${TOKEN}`]) {
    sh(t.appDir, 'remote', 'set-url', 'origin', url);
    for (const call of [() => syncRepo(t.appDir, 'app', 'x'), () => pullRepo(t.appDir, 'app')]) {
      const g = (await call().catch((e: unknown) => e)) as GitError;
      expect(g).toBeInstanceOf(GitError);
      expect([g.message, g.stderr, ...g.args].join('\n')).not.toMatch(new RegExp(`${TOKEN}|p@ss|w0rd`));
    }
  }
}, T);

// ---------------------------------------------------------------------------
// F14: OS junk files
// ---------------------------------------------------------------------------

test('F14 probe p14: .DS_Store, Thumbs.db and desktop.ini are never committed or pushed', async () => {
  const t = await trio();
  for (const d of [t.appDir, t.agentDir]) {
    write(d, '.DS_Store', `finder ${d}`);
    write(d, 'profile/.DS_Store', `finder ${d}`);
    write(d, 'Thumbs.db', `thumbs ${d}`);
    write(d, 'profile/resumes/desktop.ini', `ini ${d}`);
    write(d, 'ehthumbs.db', `x ${d}`);
  }
  write(t.appDir, 'notes/real.txt', 'real\n');
  const a = await syncRepo(t.appDir, 'app', 'save');
  const b = await syncRepo(t.agentDir, 'agent', 'agent run');
  expect(a.resolved).toEqual([]);
  expect(b.resolved).toEqual([]);
  expect(history(t.remote)).not.toMatch(/DS_Store|Thumbs\.db|desktop\.ini|ehthumbs/);
  expect(tree(t.remote)).toContain('notes/real.txt');
  expect(fs.existsSync(path.join(t.appDir, '.DS_Store'))).toBe(true);
}, T);

// ---------------------------------------------------------------------------
// F15: a push that loses a ref-lock race on every try
// ---------------------------------------------------------------------------

/**
 * Run `fn` with a `git` first on PATH that answers every push with `pushStderr` (exit 1) and passes everything
 * else to the real git. Returns how many pushes were tried.
 */
async function withFailingPush(pushStderr: string, fn: () => Promise<void>): Promise<number> {
  const saved = process.env.PATH;
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const bin = tmpDir();
  const msg = path.join(bin, 'msg');
  const count = path.join(bin, 'pushes');
  fs.writeFileSync(msg, pushStderr);
  fs.writeFileSync(count, '');
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = "push" ] && { echo x >> "${count}"; cat "${msg}" >&2; exit 1; }; done\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    await fn();
  } finally {
    process.env.PATH = saved;
  }
  return fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length;
}

test.runIf(process.platform !== 'win32')('F15 a push that loses the ref-lock race on every retry gives pushed: false, not a GitError, and goes out next time', async () => {
  const t = await trio();
  write(t.agentDir, 'mine.txt', 'mine\n');
  const race =
    "To /srv/data.git\n ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main': is at " +
    `${'1'.repeat(40)} but expected ${'2'.repeat(40)})\nerror: failed to push some refs to '/srv/data.git'\n`;
  let r: Awaited<ReturnType<typeof syncRepo>> | undefined;
  const pushes = await withFailingPush(race, async () => {
    r = await syncRepo(t.agentDir, 'agent', 'mine');
  });
  expect(pushes).toBe(3); // every retry was tried
  expect(r!.pushed).toBe(false);
  expect(r!.committed).not.toBeNull();
  expect((await syncRepo(t.agentDir, 'agent', 'retry')).pushed).toBe(true);
  expect(tree(t.remote)).toContain('mine.txt');
}, T);

// ---------------------------------------------------------------------------
// F16: stale-lock takeover across processes
// ---------------------------------------------------------------------------

test('F16 several processes that find the same stale lock at once: exactly one takes it over, the others get SyncBusyError', async () => {
  const work = tmpDir();
  const child = path.join(work, 'child.mjs');
  // Each child waits for a common start time, tries to take the lock, and reports. The holder keeps the lock
  // until every child has reported, so a child that starts late still meets a held lock, never a free one.
  fs.writeFileSync(
    child,
    `import fs from 'node:fs';
const [gitDir, startAt, out, release, modUrl] = process.argv.slice(2);
const { withLock } = await import(modUrl);
while (Date.now() < Number(startAt)) {}
try {
  await withLock(gitDir, async () => {
    fs.writeFileSync(out, 'ok');
    while (!fs.existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  });
} catch (e) { fs.writeFileSync(out, e.name); }
`,
  );
  const modUrl = new URL('../src/git.ts', import.meta.url).href;
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [child, ...args], { stdio: 'ignore' });
      p.on('error', reject);
      p.on('exit', () => resolve());
    });
  for (let trial = 0; trial < 6; trial++) {
    const gitDir = path.join(work, `g${trial}`);
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'cob-sync.lock'), JSON.stringify({ pid: deadPid, at: Date.now() }));
    const startAt = Date.now() + 1500;
    const release = path.join(work, `release-${trial}`);
    const outs = Array.from({ length: 6 }, (_, i) => path.join(work, `out-${trial}-${i}`));
    const exited = Promise.all(outs.map((o) => run([gitDir, String(startAt), o, release, modUrl])));
    const deadline = Date.now() + 60_000;
    while (!outs.every((o) => fs.existsSync(o)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(release, '');
    await exited;
    const results = outs.map((o) => fs.readFileSync(o, 'utf8'));
    expect(results.filter((r) => r === 'ok'), `trial ${trial}: ${results.join(',')}`).toHaveLength(1);
    expect(results.filter((r) => r !== 'ok').every((r) => r === 'SyncBusyError')).toBe(true);
    expect(fs.readdirSync(gitDir)).toEqual([]);
  }
}, 120_000);

test('F16 in-process: a stale lock is taken over once, and the takeover leaves no helper file', async () => {
  const gitDir = tmpDir();
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
  fs.writeFileSync(path.join(gitDir, 'cob-sync.lock'), JSON.stringify({ pid: deadPid, at: Date.now() }));
  expect(await withLock(gitDir, async () => fs.readdirSync(gitDir))).toEqual(['cob-sync.lock']);
  expect(fs.readdirSync(gitDir)).toEqual([]);
  fs.writeFileSync(path.join(gitDir, 'cob-sync.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  await expect(withLock(gitDir, async () => 1)).rejects.toBeInstanceOf(SyncBusyError);
});

// ---------------------------------------------------------------------------
// F17 / F18 / F19: small lane A and C fixes
// ---------------------------------------------------------------------------

describe('F17 applyPointOp honours pointId', () => {
  const ctx = { interviewId: 'i2', now: T1, id: () => 'new' };
  const A = sample.point({ id: 'A', text: 'Excel' });

  test.each(['confirm', 'correct', 'unsure', 'remove'] as const)('F17 %s naming point B is refused when given point A, and A is unchanged', (op) => {
    const copy = structuredClone(A);
    const o = { op, pointId: 'B', text: 'I never worked there', evidence: { type: 'said', quote: 'no' } } as Parameters<typeof applyPointOp>[1];
    expect(() => applyPointOp(A, o, ctx)).toThrow(PointOpError);
    expect(() => applyPointOp(A, o, ctx)).toThrow(/B/);
    expect(A).toEqual(copy);
  });

  test('F17 the op goes to the point it names; a point that does not exist is refused', () => {
    const B = sample.point({ id: 'B', text: 'Sheets' });
    const out = applyPointOp(B, { op: 'correct', pointId: 'B', text: 'Google Sheets', evidence: { type: 'said', quote: 'sheets' } }, ctx)!;
    expect(out).toMatchObject({ id: 'B', text: 'Google Sheets', rev: 2 });
    expect(() => applyPointOp(null, { op: 'correct', pointId: 'B', text: 'x', evidence: { type: 'said', quote: 'x' } }, ctx)).toThrow(PointOpError);
  });

  test('F17 an empty quote is refused by the schema', () => {
    expect(PointSchema.safeParse(sample.point({ evidence: { type: 'said', quote: '' } })).success).toBe(false);
    expect(PointSchema.safeParse(sample.point({ evidence: { type: 'resume', file: 'cv.pdf', quote: '' } })).success).toBe(false);
    expect(PointSchema.safeParse(sample.point({ evidence: { type: 'said', quote: 'x' } })).success).toBe(true);
  });
});

test('F18 safeFileName gives one NFC name for composed and decomposed spellings', () => {
  const nfc = 'My R\u00e9sum\u00e9.pdf';
  const nfd = 'My Re\u0301sume\u0301.pdf';
  expect(safeFileName(nfd)).toBe(safeFileName(nfc));
  expect(safeFileName(nfd)).toBe(nfc);
  expect(safeFileName(nfd).normalize('NFC')).toBe(safeFileName(nfd));
});

describe('F19 atomicWrite reaches the disk', () => {
  afterEach(() => vi.restoreAllMocks());

  test('F19 the temp file is flushed before the rename, and on POSIX the folder after it', () => {
    const dir = tmpDir();
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const rename = vi.spyOn(fs, 'renameSync');
    atomicWrite(path.join(dir, 'a.json'), '{"a":1}\n');
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('{"a":1}\n');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(process.platform === 'win32' ? 1 : 2);
    expect(fsync.mock.invocationCallOrder[0]!).toBeLessThan(rename.mock.invocationCallOrder[0]!);
    if (process.platform !== 'win32') expect(fsync.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(rename.mock.invocationCallOrder[0]!);
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  test('F19 a failed flush leaves the old file and no temp file', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.json'), 'old');
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    expect(() => atomicWrite(path.join(dir, 'a.json'), 'new')).toThrow(/EIO/);
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });
});

// ---------------------------------------------------------------------------
// F20: minimum git version
// ---------------------------------------------------------------------------

describe.runIf(process.platform !== 'win32')('F20 minimum git version', () => {
  let saved: string | undefined;
  let fakeBin: string;
  beforeEach(() => {
    saved = process.env.PATH;
    fakeBin = tmpDir();
  });
  afterEach(() => {
    process.env.PATH = saved;
  });
  const fakeGit = (version: string) => {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { env: { ...process.env, PATH: saved } }).toString().trim();
    fs.writeFileSync(
      path.join(fakeBin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--version" ] && { echo "git version ${version}"; exit 0; }; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${fakeBin}${path.delimiter}${saved}`;
  };

  test('F20 an old git is refused by init, clone, sync and pull before they do anything, naming both versions', async () => {
    const t = await trio();
    write(t.appDir, 'a.txt', 'a\n');
    const before = snapshot(t.appDir);
    fakeGit('2.30.9');
    const initDir = path.join(tmpDir(), 'init');
    const cloneDir = path.join(tmpDir(), 'clone');
    const calls = [
      () => initPrivateRepo(initDir, { identity }),
      () => cloneDataRepo(t.remote, cloneDir, identity),
      () => syncRepo(t.appDir, 'app', 'x'),
      () => pullRepo(t.appDir, 'app'),
    ];
    for (const call of calls) {
      const err = (await call().catch((e: unknown) => e)) as GitError;
      expect(err).toBeInstanceOf(GitError);
      expect(err.message).toContain('2.30.9');
      expect(err.message).toContain(MIN_GIT_VERSION);
    }
    expect(fs.existsSync(initDir)).toBe(false);
    expect(fs.existsSync(cloneDir)).toBe(false);
    expect(snapshot(t.appDir)).toEqual(before);
  }, T);

  test('F20 the minimum itself, a vendor suffix and a newer git are accepted', async () => {
    for (const v of [MIN_GIT_VERSION, `${MIN_GIT_VERSION}.windows.1`, '2.39.3 (Apple Git-145)', '3.0.0']) {
      fakeGit(v);
      await initPrivateRepo(path.join(tmpDir(), 'ok'), { identity });
    }
  }, T);

  test('F20 README.md states the minimum git version', () => {
    const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../../../README.md'), 'utf8');
    expect(readme).toContain(`git ${MIN_GIT_VERSION.replace(/\.0$/, '')}`);
  });
});

// ---------------------------------------------------------------------------
// F21 / F22 / F24: the public surface, one home per rule, the Slice 1 contract
// ---------------------------------------------------------------------------

test('F21 test-only seams are not part of the public API', () => {
  // @ts-expect-error beforePush is not an option of the public type
  const a: SyncOptions = { beforePush: async () => {} };
  // @ts-expect-error beforeIntegrate is not an option of the public type
  const b: SyncOptions = { beforeIntegrate: async () => {} };
  const c: SyncOptions = { maxAttempts: 2, acceptRewind: true };
  void [a, b, c];
  const exported = Object.keys(core);
  for (const name of ['withTestHooks', 'withLock', 'sameFolder', 'beforePush', 'beforeIntegrate']) expect(exported).not.toContain(name);
  expect(pullRepo.length).toBeLessThanOrEqual(3);
  expect(exported).toEqual(expect.arrayContaining(['HostRewoundError', 'applicationForPosting', 'MIN_GIT_VERSION']));
});

test('F22 each shared rule is written once in src', () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  const count = (re: RegExp) => files.reduce((n, f) => n + (fs.readFileSync(path.join(SRC, f), 'utf8').match(re)?.length ?? 0), 0);
  expect(count(/\[A-Za-z0-9\._-\]\+\$/g)).toBe(1); // the id pattern
  expect(count(/\\\.tmp-/g)).toBe(1); // the temp-file pattern
  expect(count(/\.tmp-\$\{/g)).toBe(1); // the temp-file name
  expect(count(/protocol === 'http:'/g)).toBe(1); // the http(s) check
  expect(count(/function lstatOrNull/g)).toBe(1);
  expect(count(/^export \{[^}]*\};?$/gm)).toBe(0); // no re-export of another module's names
});

test('F24 docs/slice1-agent-tools.md states the contracts Slice 1 needs', () => {
  const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../../../docs/slice1-agent-tools.md'), 'utf8');
  expect(doc).toContain('{ notSent: true, parkAt: row.parkedAt }');
  expect(doc).toMatch(/never clicks? when `beginSubmit` throws/);
  expect(doc).toContain('applicationForPosting');
  expect(doc).toContain('HostRewoundError');
});

// ---------------------------------------------------------------------------
// F23: the whole loop across lanes (probe p09 part 1)
// ---------------------------------------------------------------------------

test('F23 probe p09 part 1: crash after the click, the row, three Retry presses: one Work, one authorised click', async () => {
  const t = await trio();
  t.app.put('point', point);
  await syncRepo(t.appDir, 'app', 'profile');
  await pullRepo(t.agentDir, 'agent');
  let clicks = 0;
  expect(applicationForPosting(t.agent, { link: posting.link })).toBeNull();
  const a = beginSubmit(t.agent, posting, intent);
  clicks++; // the click, then the run dies
  await pullRepo(t.agentDir, 'agent'); // the next run starts
  expect(processQueue(t.agent)).toEqual([]);
  await syncRepo(t.agentDir, 'agent', 'agent run');
  await pullRepo(t.appDir, 'app');
  const row = inboxRows(t.app)[0]!;
  expect(row.rowType).toBe('error_after_submit');
  createCommand(t.app, { verb: 'retry', target: a.id, payload: {} }); // Retry without the answer
  createCommand(t.app, { verb: 'retry', target: a.id, payload: { notSent: true, parkAt: row.parkedAt } });
  createCommand(t.app, { verb: 'retry', target: a.id, payload: { notSent: true, parkAt: row.parkedAt } }); // pressed twice
  await syncRepo(t.appDir, 'app', 'retry');
  await pullRepo(t.agentDir, 'agent');
  const work = processQueue(t.agent);
  expect(work).toHaveLength(1);
  for (const w of work) {
    if (w.type !== 'retry') continue;
    beginSubmit(t.agent, { applicationId: w.applicationId }, intent);
    clicks++;
    recordOutcome(t.agent, { applicationId: w.applicationId }, { type: 'submitted', ...intent });
    finishCommand(t.agent, w.commandId, 'done', 'submitted');
  }
  expect(processQueue(t.agent)).toEqual([]);
  await syncRepo(t.agentDir, 'agent', 'agent run');
  await pullRepo(t.appDir, 'app');
  expect(t.app.get('application', a.id)!.state).toBe('submitted');
  expect(inboxRows(t.app)).toEqual([]);
  expect(t.app.list('command').items.map((c) => c.state)).toEqual(['failed', 'done', 'failed']);
  expect(queuedCommands(t.app)).toEqual([]);
  expect(clicks).toBe(2); // one before the crash, one authorised
  expect(sh(t.appDir, 'status', '--porcelain')).toBe('');
  expect(sh(t.agentDir, 'status', '--porcelain')).toBe('');
}, T);
