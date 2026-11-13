import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  HANDLED_VERBS,
  processCommand,
  processQueue,
  type Work,
} from '../src/process.ts';
import { CONFIRMED, beginSubmit, recordOutcome } from '../src/applications.ts';
import { CommandError, createCommand, queuedCommands } from '../src/commands.ts';
import { DataRepo } from '../src/repo.ts';
import type { Application, Park } from '../src/schema.ts';
import { T0, T1, appInput, pair, sample, seedLanes } from './helpers.ts';

let dir: string;
let app: DataRepo;
let agent: DataRepo;
let seedPark: (id: string, park: Omit<Park, 'at'> | Park, extra?: Partial<Application>) => Application;
let seedInterruptedSubmit: (pointId?: string) => Application;

beforeEach(() => {
  ({ dir, app, agent, seedPark, seedInterruptedSubmit } = pair());
});

describe('process', () => {
  test('a run that stopped after the click becomes a may-have-been-sent error row', () => {
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 1 }));
    const s = beginSubmit(
      agent,
      appInput(),
      { resumeFile: 'cv.pdf', points: [{ pointId: 'p', rev: 1 }] },
      new Date(T0),
    );
    expect(processQueue(agent, new Date(T1))).toEqual([]);
    expect(agent.get('application', s.id)).toMatchObject({
      state: 'parked',
      park: { type: 'error', afterSubmit: true },
      pendingSubmission: { startedAt: T0 },
    });
  });

  test('Done on a may-have-been-sent row records it as submitted at the click time', () => {
    const s = seedInterruptedSubmit('p');
    createCommand(app, { verb: 'done', target: s.id, payload: {} });
    processQueue(agent);
    expect(agent.get('application', s.id)).toMatchObject({
      state: 'submitted',
      park: null,
      pendingSubmission: null,
      submission: { submittedAt: T0 },
    });
  });

  test('Retry on a may-have-been-sent row needs notSent', () => {
    const s = seedInterruptedSubmit('p');
    const c1 = createCommand(app, { verb: 'retry', target: s.id, payload: {} });
    expect(processQueue(agent)).toEqual([]);
    expect(agent.get('command', c1.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: confirm the application was not sent before retrying',
    });
    const c2 = createCommand(app, { verb: 'retry', target: s.id, payload: { notSent: true } });
    expect(processQueue(agent)).toEqual([{ type: 'retry', applicationId: s.id, commandId: c2.id }]);
  });

  test('queue applies status then drop in order', () => {
    const p = seedPark('app-status-drop', { type: 'captcha' });
    createCommand(
      app,
      { verb: 'status', target: p.id, payload: { kind: 'rejection', text: 'Not moving forward' } },
      new Date(T0),
    );
    createCommand(app, { verb: 'drop', target: p.id, payload: { reason: 'rejected' } }, new Date(T1));
    expect(processQueue(agent)).toEqual([]);
    const a = agent.get('application', p.id)!;
    expect(a.state).toBe('dropped');
    expect(a.statusNotes[0]).toMatchObject({ kind: 'rejection', text: 'Not moving forward' });
    expect(queuedCommands(app)).toHaveLength(0);
  });

  test('lane ticks stay queued for a later agent version', () => {
    seedLanes(app);
    createCommand(app, { verb: 'lane_done', target: 'one-outreach', payload: { day: '2026-11-11' } });
    processQueue(agent);
    expect(queuedCommands(app).map((c) => c.verb)).toEqual(['lane_done']);
  });

  test('retry on a closed application fails with a note', () => {
    seedPark('x', { type: 'captcha' });
    createCommand(app, { verb: 'done', target: 'x', payload: {} });
    processQueue(agent);
    const c = createCommand(app, { verb: 'retry', target: 'x', payload: {} });
    processQueue(agent);
    expect(agent.get('command', c.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: application is done',
    });
  });

  // B8
  test('B8 done on afterSubmit error sets note closed: user confirmed it was sent', () => {
    const s = seedInterruptedSubmit('p1');
    const c = createCommand(app, { verb: 'done', target: s.id, payload: {} });
    processQueue(agent);
    expect(agent.get('command', c.id)).toMatchObject({
      state: 'done',
      resultNote: 'closed: user confirmed it was sent',
    });
  });

  // B9
  test('B9 done on other parked row and drop without reason', () => {
    const p1 = seedPark('p1', { type: 'captcha' });
    const c1 = createCommand(app, { verb: 'done', target: p1.id, payload: {} }, new Date(T0));
    processQueue(agent, new Date(T0));
    expect(agent.get('application', p1.id)).toMatchObject({
      state: 'done',
      park: null,
      closedAt: T0,
    });
    expect(agent.get('command', c1.id)).toMatchObject({
      state: 'done',
      resultNote: 'closed: finished by user',
    });

    const p2 = seedPark('p2', { type: 'sign_in' });
    const c2 = createCommand(app, { verb: 'drop', target: p2.id, payload: {} }, new Date(T1));
    processQueue(agent, new Date(T1));
    expect(agent.get('application', p2.id)).toMatchObject({
      state: 'dropped',
      park: null,
      pendingSubmission: null,
      closedAt: T1,
    });
    expect(agent.get('command', c2.id)).toMatchObject({
      state: 'done',
      resultNote: 'closed: dropped',
    });
  });

  // B10
  test('B10 status appends StatusNote with commandId and does not change state', () => {
    const p = seedPark('p-status', { type: 'human', contact: 'recruiter@example.com' });
    const cmd = createCommand(
      app,
      { verb: 'status', target: p.id, payload: { kind: 'reply', text: 'Scheduled interview' } },
      new Date(T0),
    );
    processQueue(agent, new Date(T0));
    const appRecord = agent.get('application', p.id)!;
    expect(appRecord.state).toBe('parked');
    expect(appRecord.statusNotes).toEqual([
      {
        at: T0,
        kind: 'reply',
        text: 'Scheduled interview',
        commandId: cmd.id,
      },
    ]);
    expect(agent.get('command', cmd.id)!.resultNote).toBe('status: reply');
  });

  // B11
  test('B11 verified on parked row produces needs_run retry work', () => {
    const p = seedPark('p-verify', { type: 'verify' });
    const cmd = createCommand(app, { verb: 'verified', target: p.id, payload: {} });
    const work = processQueue(agent);
    expect(work).toEqual([{ type: 'retry', applicationId: p.id, commandId: cmd.id }]);
    // Stays queued
    expect(agent.get('command', cmd.id)!.state).toBe('queued');
  });

  // B12
  test('B12 interview_saved is done with note; run_role produces needs_run work', () => {
    const c1 = createCommand(app, { verb: 'interview_saved', target: null, payload: { interviewId: 'i1' } });
    const c2 = createCommand(app, { verb: 'run_role', target: null, payload: { role: 'finder' } });
    const work = processQueue(agent);
    expect(work).toEqual([{ type: 'run_role', role: 'finder', commandId: c2.id }]);
    expect(agent.get('command', c1.id)).toMatchObject({
      state: 'done',
      resultNote: 'points reloaded',
    });
    expect(agent.get('command', c2.id)!.state).toBe('queued');
  });

  // B13
  test('B13 command whose application target no longer exists fails with failed: unknown application <id>', () => {
    const p = seedPark('app-to-delete', { type: 'captcha' });
    const cmd = createCommand(app, { verb: 'retry', target: p.id, payload: {} });
    // Delete the application directly through agent
    agent.delete('application', p.id);
    expect(processQueue(agent)).toEqual([]);
    expect(agent.get('command', cmd.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: unknown application app-to-delete',
    });
  });

  // B14
  test('B14 verb not in HANDLED_VERBS throws CommandError when processCommand is called directly', () => {
    seedLanes(app);
    const cmd = createCommand(app, {
      verb: 'lane_skip',
      target: 'one-outreach',
      payload: { day: '2026-11-11' },
    });
    expect(() => processCommand(agent, cmd)).toThrow(CommandError);
  });

  // B15
  test('B15 processQueue orders by oldest first and D1 leaves needs_run queued', () => {
    const p1 = seedPark('p1', { type: 'captcha' });
    const p2 = seedPark('p2', { type: 'verify' });
    const c1 = createCommand(app, { verb: 'retry', target: p1.id, payload: {} }, new Date(T0));
    const c2 = createCommand(app, { verb: 'verified', target: p2.id, payload: {} }, new Date(T1));

    const workFirst = processQueue(agent);
    expect(workFirst).toEqual([
      { type: 'retry', applicationId: p1.id, commandId: c1.id },
      { type: 'retry', applicationId: p2.id, commandId: c2.id },
    ]);

    // D1: A second processQueue before finishCommand returns the same work again
    const workSecond = processQueue(agent);
    expect(workSecond).toEqual([
      { type: 'retry', applicationId: p1.id, commandId: c1.id },
      { type: 'retry', applicationId: p2.id, commandId: c2.id },
    ]);
  });

  // B21 (H1)
  test('B21 processQueue returns at most one Work per application per pass and fails duplicate retry commands', () => {
    const p = seedPark('p-dup-retry', { type: 'captcha' });
    const c1 = createCommand(app, { verb: 'retry', target: p.id, payload: {} }, new Date(T0));
    const c2 = createCommand(app, { verb: 'retry', target: p.id, payload: {} }, new Date(T1));
    const work = processQueue(agent);
    expect(work).toEqual([{ type: 'retry', applicationId: p.id, commandId: c1.id }]);
    expect(agent.get('command', c2.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: a retry for this application is already pending',
    });
  });

  // B21 / H1 scenario B
  test('B21 no Work returned if application dropped in the same batch', () => {
    const p = seedPark('p-retry-drop-batch', { type: 'captcha' });
    createCommand(app, { verb: 'retry', target: p.id, payload: {} }, new Date(T0));
    createCommand(app, { verb: 'drop', target: p.id, payload: { reason: 'changed my mind' } }, new Date(T1));
    const work = processQueue(agent);
    expect(work).toEqual([]);
    expect(agent.get('application', p.id)!.state).toBe('dropped');
  });

  // B22 (H2)
  test('B22 retry or verified on may-have-been-sent row fails if park is newer than command', () => {
    // Interrupted submit creates error park with afterSubmit at T0
    const s = seedInterruptedSubmit('p-h2');
    // Command created at T0 (e.g. 10:30)
    const T10_30 = '2026-11-11T10:30:00.000Z';
    const c = createCommand(app, { verb: 'retry', target: s.id, payload: { notSent: true } }, new Date(T10_30));
    // Simulated second crash parks at T12 (newer than command)
    const T12 = '2026-11-11T12:00:00.000Z';
    const secondPark = recordOutcome(
      agent,
      { applicationId: s.id },
      { type: 'park', park: { type: 'error', afterSubmit: true, note: 'Second crash' } },
      new Date(T12),
    );
    expect(secondPark.park!.at).toBe(T12);
    // Next processQueue should fail command and return no work
    const work = processQueue(agent, new Date('2026-11-11T13:00:00.000Z'));
    expect(work).toEqual([]);
    expect(agent.get('command', c.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: confirm the application was not sent before retrying',
    });
  });

  // B14 / B15 amended (M2)
  test('B14 B15 unreadable target application file fails command and does not stop queue', () => {
    const good1 = seedPark('p-good1', { type: 'captcha' });
    const bad = seedPark('p-bad', { type: 'captcha' });
    const good2 = seedPark('p-good2', { type: 'captcha' });

    const c1 = createCommand(app, { verb: 'done', target: good1.id, payload: {} }, new Date(T0));
    const c2 = createCommand(app, { verb: 'done', target: bad.id, payload: {} }, new Date(T0));
    const c3 = createCommand(app, { verb: 'done', target: good2.id, payload: {} }, new Date(T1));

    // Corrupt bad file
    const badFile = path.join(dir, 'applications', `${bad.id}.json`);
    fs.writeFileSync(badFile, '{ invalid json');

    expect(() => processQueue(agent)).not.toThrow();
    expect(agent.get('application', good1.id)!.state).toBe('done');
    expect(agent.get('application', good2.id)!.state).toBe('done');
    expect(agent.get('command', c2.id)!.state).toBe('failed');
    expect(agent.get('command', c2.id)!.resultNote).toMatch(/^failed:/);
  });

  // B9 amended (M3)
  test('B9 drop on submitted application fails with failed: application is submitted', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const s = beginSubmit(agent, appInput(), { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
    const sub = recordOutcome(agent, { applicationId: s.id }, { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
    expect(sub.state).toBe('submitted');

    const cmd = createCommand(app, { verb: 'drop', target: sub.id, payload: {} }, new Date(T1));
    processQueue(agent, new Date(T1));
    expect(agent.get('application', sub.id)!.state).toBe('submitted');
    expect(agent.get('command', cmd.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: application is submitted',
    });
  });

  // m30 [B11]
  test('B11 m30 verified fails on may-have-been-sent row', () => {
    const s = seedInterruptedSubmit('p-m30');
    const c = createCommand(app, { verb: 'verified', target: s.id, payload: {} });
    expect(processQueue(agent)).toEqual([]);
    expect(agent.get('command', c.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: confirm the application was not sent before retrying',
    });
  });

  // m31 [B11]
  test('B11 m31 retry with notSent false fails on may-have-been-sent row', () => {
    const s = seedInterruptedSubmit('p-m31');
    const c = createCommand(app, { verb: 'retry', target: s.id, payload: { notSent: false } });
    expect(processQueue(agent)).toEqual([]);
    expect(agent.get('command', c.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: confirm the application was not sent before retrying',
    });
  });

  // m33 [B9]
  test('B9 m33 drop on parked row clears pendingSubmission', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const s = beginSubmit(agent, appInput(), { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
    const p = recordOutcome(agent, { applicationId: s.id }, { type: 'park', park: { type: 'error', afterSubmit: true, note: 'err' } }, new Date(T0));
    expect(p.pendingSubmission).not.toBeNull();

    createCommand(app, { verb: 'drop', target: p.id, payload: {} }, new Date(T1));
    processQueue(agent, new Date(T1));
    const dropped = agent.get('application', p.id)!;
    expect(dropped.state).toBe('dropped');
    expect(dropped.pendingSubmission).toBeNull();
  });

  // m34 & m35 [B9]
  test('B9 m34 m35 drop with reason uses em dash and includes reason', () => {
    const p = seedPark('p-drop-reason', { type: 'captcha' });
    const c = createCommand(app, { verb: 'drop', target: p.id, payload: { reason: 'not interested' } }, new Date(T0));
    processQueue(agent, new Date(T0));
    expect(agent.get('command', c.id)!.resultNote).toBe('closed: dropped \u2014 not interested');
  });

  // m37 [B8]
  test('B8 m37 done on may-have-been-sent row leaves closedAt null', () => {
    const s = seedInterruptedSubmit('p-m37');
    createCommand(app, { verb: 'done', target: s.id, payload: {} });
    processQueue(agent);
    const appRecord = agent.get('application', s.id)!;
    expect(appRecord.state).toBe('submitted');
    expect(appRecord.closedAt).toBeNull();
  });

  // m42 [D5/B10]
  test('D5 m42 status command updates updatedAt on application', () => {
    const p = seedPark('p-upd-m42', { type: 'captcha' });
    expect(p.updatedAt).toBe(T0);
    createCommand(app, { verb: 'status', target: p.id, payload: { kind: 'note', text: 'hi' } }, new Date(T1));
    processQueue(agent, new Date(T1));
    expect(agent.get('application', p.id)!.updatedAt).toBe(T1);
  });

  // m43 [B9]
  test('B9 m43 done on unparked row fails with failed: application is <state>', () => {
    const p = seedPark('p-done-twice', { type: 'captcha' });
    createCommand(app, { verb: 'done', target: p.id, payload: {} }, new Date(T0));
    processQueue(agent, new Date(T0));
    expect(agent.get('application', p.id)!.state).toBe('done');

    const c2 = createCommand(app, { verb: 'done', target: p.id, payload: {} }, new Date(T1));
    processQueue(agent, new Date(T1));
    expect(agent.get('command', c2.id)).toMatchObject({
      state: 'failed',
      resultNote: 'failed: application is done',
    });
  });

  // m44 [B12]
  test('B12 m44 run_role works for applier and guide', () => {
    const c1 = createCommand(app, { verb: 'run_role', target: null, payload: { role: 'applier' } });
    const c2 = createCommand(app, { verb: 'run_role', target: null, payload: { role: 'guide' } });
    const work = processQueue(agent);
    expect(work).toContainEqual({ type: 'run_role', role: 'applier', commandId: c1.id });
    expect(work).toContainEqual({ type: 'run_role', role: 'guide', commandId: c2.id });
  });

  // L1 / B10 amended
  test('B10 L1 status is idempotent by commandId', () => {
    const p = seedPark('p-status-idemp', { type: 'captcha' });
    const cmd = createCommand(app, { verb: 'status', target: p.id, payload: { kind: 'note', text: 'once' } }, new Date(T0));
    processCommand(agent, cmd, new Date(T0));
    expect(agent.get('application', p.id)!.statusNotes).toHaveLength(1);

    // Replay same command
    processCommand(agent, cmd, new Date(T1));
    expect(agent.get('application', p.id)!.statusNotes).toHaveLength(1);
  });
});
