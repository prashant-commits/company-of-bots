import { beforeEach, describe, expect, test } from 'vitest';
import {
  ApplicationStateError,
  UnsendablePointError,
  assertSendable,
  beginSubmit,
  recordOutcome,
  recoverInterrupted,
  sendablePoints,
  upsertRole,
  type ParkInput,
} from '../src/applications.ts';
import { createCommand } from '../src/commands.ts';
import { CONFIRMED, UNSURE } from '../src/confidence.ts';
import { processQueue } from '../src/process.ts';
import { OwnershipError } from '../src/repo.ts';
import { DataRepo } from '../src/repo.ts';
import type { Application, Park } from '../src/schema.ts';
import { T0, T1, appInput, pair, roleInput, sample } from './helpers.ts';

let app: DataRepo;
let agent: DataRepo;
let seedPark: (id: string, park: ParkInput | Park, extra?: Partial<Application>) => Application;
let seedInterruptedSubmit: (pointId?: string) => Application;

beforeEach(() => {
  ({ app, agent, seedPark, seedInterruptedSubmit } = pair());
});

describe('applications', () => {
  test('upsertRole dedupes tracking-param variants and keeps foundAt', () => {
    const a = upsertRole(agent, roleInput({ link: 'https://careers.example.com/jobs/7' }), new Date(T0));
    const b = upsertRole(agent, roleInput({ link: 'https://careers.example.com/jobs/7/?utm_source=x' }), new Date(T1));
    expect(b.isNew).toBe(false);
    expect(b.role.id).toBe(a.role.id);
    expect(b.role.foundAt).toBe(a.role.foundAt);
  });

  test('20.3 an unsure point is refused before the click and nothing is written', () => {
    app.put('point', sample.point({ id: 'u', rank: UNSURE, rev: 1 }));
    expect(sendablePoints(agent).map((p) => p.id)).not.toContain('u');
    expect(() =>
      beginSubmit(agent, appInput(), {
        resumeFile: 'cv.pdf',
        points: [{ pointId: 'u', rev: 1, field: 'Notice period' }],
      }),
    ).toThrow(UnsendablePointError);
    expect(agent.list('application').items).toEqual([]);
  });

  test('a correction that lands before the click makes the old revision stale', () => {
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 2 }));
    expect(() => assertSendable(agent, [{ pointId: 'p', rev: 1 }])).toThrow(UnsendablePointError);
    expect(() => assertSendable(agent, [{ pointId: 'p', rev: 2 }])).not.toThrow();
  });

  test('beginSubmit then recordOutcome: the record keeps fields and the revision that was sent', () => {
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 1 }));
    const refs = [{ pointId: 'p', rev: 1, field: 'Notice period' }];
    const s = beginSubmit(agent, appInput(), { resumeFile: 'cv.pdf', points: refs }, new Date(T0));
    expect(s).toMatchObject({
      state: 'submitting',
      pendingSubmission: { resumeFile: 'cv.pdf', points: refs, startedAt: T0 },
    });
    const a = recordOutcome(
      agent,
      { applicationId: s.id },
      { type: 'submitted', resumeFile: 'cv.pdf', points: refs },
      new Date(T1),
    );
    expect(a).toMatchObject({
      state: 'submitted',
      pendingSubmission: null,
      submission: { points: refs, submittedAt: T1 },
    });
    app.put('point', sample.point({ id: 'p', rank: CONFIRMED, rev: 2, text: 'corrected' }));
    expect(agent.get('application', a.id)!.submission!.points).toEqual(refs);
  });

  test('20.20 an error before the click parks with the agent’s note and retries freely', () => {
    const a = recordOutcome(
      agent,
      appInput(),
      { type: 'park', park: { type: 'error', note: 'Upload failed' } },
      new Date(T0),
    );
    expect(a.park).toMatchObject({ type: 'error', note: 'Upload failed' });
    expect(a.park!.afterSubmit).toBeUndefined();
    createCommand(app, { verb: 'retry', target: a.id, payload: {} });
    expect(processQueue(agent)).toHaveLength(1);
  });

  test('parks keep history', () => {
    const a = recordOutcome(
      agent,
      appInput(),
      { type: 'park', park: { type: 'sign_in', site: 'jobs.example.com' } },
      new Date(T0),
    );
    const b = recordOutcome(
      agent,
      { applicationId: a.id },
      { type: 'park', park: { type: 'captcha' } },
      new Date(T1),
    );
    expect(b.parkHistory.map((h) => h.type)).toEqual(['sign_in', 'captcha']);
  });

  test('skip records the matching hard no and refuses anything else', () => {
    app.put('point', sample.point({ id: 'h', kind: 'hard_no', rank: CONFIRMED }));
    app.put('point', sample.point({ id: 's', kind: 'skill', rank: CONFIRMED }));
    expect(recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: 'h' })).toMatchObject({
      state: 'skipped',
      skip: { hardNoPointId: 'h' },
    });
    expect(() => recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: 's' })).toThrow(
      UnsendablePointError,
    );
  });

  // B1
  test('B1 sendablePoints returns only points with rank >= CONFIRMED across all kinds', () => {
    app.put('point', sample.point({ id: 'p1', kind: 'work', rank: CONFIRMED }));
    app.put('point', sample.point({ id: 'p2', kind: 'place', rank: CONFIRMED + 10 }));
    app.put('point', sample.point({ id: 'p3', kind: 'skill', rank: UNSURE }));
    app.put('point', sample.point({ id: 'p4', kind: 'other', rank: 99 }));
    const sendable = sendablePoints(agent);
    expect(sendable.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  // B2
  test('B2 assertSendable lists every bad ref in error message', () => {
    app.put('point', sample.point({ id: 'good', rank: CONFIRMED, rev: 1 }));
    app.put('point', sample.point({ id: 'unsure', rank: UNSURE, rev: 1 }));
    app.put('point', sample.point({ id: 'stale', rank: CONFIRMED, rev: 2 }));
    expect(() =>
      assertSendable(agent, [
        { pointId: 'good', rev: 1 },
        { pointId: 'unsure', rev: 1 },
        { pointId: 'stale', rev: 1 },
        { pointId: 'missing', rev: 1 },
      ]),
    ).toThrowError(/unsure.*stale.*missing/);
  });

  // B3
  test('B3 beginSubmit updates an existing applicationId and clears park', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const parked = seedPark('app-existing', { type: 'error', note: 'First error' });
    const s = beginSubmit(
      agent,
      { applicationId: parked.id },
      { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1, field: 'phone' }] },
      new Date(T1),
    );
    expect(s.id).toBe('app-existing');
    expect(s.state).toBe('submitting');
    expect(s.park).toBeNull();
    expect(s.pendingSubmission).toMatchObject({
      resumeFile: 'cv.pdf',
      points: [{ pointId: 'p1', rev: 1, field: 'phone' }],
      startedAt: T1,
    });
  });

  // B4
  test('B4 recordOutcome submitted never throws over point state after submit', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const s = beginSubmit(
      agent,
      appInput(),
      { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      new Date(T0),
    );
    // Delete the point or demote it
    app.delete('point', 'p1');
    expect(() =>
      recordOutcome(
        agent,
        { applicationId: s.id },
        { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
        new Date(T1),
      ),
    ).not.toThrow();
  });

  // B5
  test('B5 recordOutcome park keeps pendingSubmission only when afterSubmit: true', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const s1 = beginSubmit(
      agent,
      appInput(),
      { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      new Date(T0),
    );
    const p1 = recordOutcome(
      agent,
      { applicationId: s1.id },
      { type: 'park', park: { type: 'error', afterSubmit: true, note: 'Timeout' } },
      new Date(T1),
    );
    expect(p1.pendingSubmission).not.toBeNull();

    const s2 = beginSubmit(
      agent,
      appInput({ link: 'https://careers.example.com/jobs/2' }), // another posting (one application per posting, R52)
      { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      new Date(T0),
    );
    const p2 = recordOutcome(
      agent,
      { applicationId: s2.id },
      { type: 'park', park: { type: 'captcha' } },
      new Date(T1),
    );
    expect(p2.pendingSubmission).toBeNull();
  });

  // B7 (idempotent)
  test('B7 recoverInterrupted is idempotent on repeated calls', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const s = beginSubmit(
      agent,
      appInput(),
      { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      new Date(T0),
    );
    const first = recoverInterrupted(agent, new Date(T1));
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe(s.id);
    expect(first[0]!.state).toBe('parked');
    expect(first[0]!.park).toMatchObject({
      type: 'error',
      afterSubmit: true,
      note: 'The run stopped after the submit click. The application may have been sent.',
    });

    const second = recoverInterrupted(agent, new Date(T1));
    expect(second).toEqual([]);
    expect(agent.get('application', s.id)!.state).toBe('parked');
  });

  // B17 (bad link)
  test('B17 upsertRole throws on invalid URL and writes nothing', () => {
    expect(() =>
      upsertRole(agent, roleInput({ link: 'not-a-valid-url' }), new Date(T0)),
    ).toThrow();
    expect(agent.list('role').items).toEqual([]);
  });

  // B17 (ownership)
  test('B17 upsertRole throws OwnershipError when called by app', () => {
    expect(() =>
      upsertRole(app, roleInput({ link: 'https://careers.example.com/jobs/10' })),
    ).toThrow(OwnershipError);
  });

  // B18
  test('B18 outsider input with quotes, unicode, and newlines is stored verbatim', () => {
    const weirdTitle = 'Senior "Wizard" & Lead\nNewline \u2603 \u{1F354}';
    const weirdOrg = 'Org with "Quotes" & emoji \u{1F680}';
    const weirdNote = 'Note with "quotes" and \n newlines and \u{1F389}';
    const a = recordOutcome(
      agent,
      appInput({ title: weirdTitle, organization: weirdOrg }),
      { type: 'park', park: { type: 'human', note: weirdNote } },
      new Date(T0),
    );
    const loaded = agent.get('application', a.id)!;
    expect(loaded.title).toBe(weirdTitle);
    expect(loaded.organization).toBe(weirdOrg);
    expect(loaded.park!.note).toBe(weirdNote);
  });

  // D2
  test('D2 beginSubmit and recordOutcome throw when applicationId does not exist', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    expect(() =>
      beginSubmit(
        agent,
        { applicationId: 'nonexistent-id' },
        { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      ),
    ).toThrowError(/nonexistent-id/);

    expect(() =>
      recordOutcome(
        agent,
        { applicationId: 'nonexistent-id' },
        { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      ),
    ).toThrowError(/nonexistent-id/);
  });

  // B20 (H1)
  test.each(['submitting', 'submitted', 'skipped', 'done', 'dropped'] as const)(
    'B20 beginSubmit with { applicationId } throws ApplicationStateError when state is %s',
    (state) => {
      app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
      let appRecord: Application;
      if (state === 'submitting') {
        appRecord = beginSubmit(agent, appInput(), { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
      } else if (state === 'submitted') {
        const s = beginSubmit(agent, appInput(), { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
        appRecord = recordOutcome(agent, { applicationId: s.id }, { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
      } else if (state === 'skipped') {
        app.put('point', sample.point({ id: 'hn', kind: 'hard_no', rank: CONFIRMED, rev: 1 }));
        appRecord = recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: 'hn' }, new Date(T0));
      } else if (state === 'done') {
        const p = seedPark('p-done', { type: 'captcha' });
        createCommand(app, { verb: 'done', target: p.id, payload: {} }, new Date(T0));
        processQueue(agent, new Date(T0));
        appRecord = agent.get('application', p.id)!;
      } else {
        const p = seedPark('p-drop', { type: 'captcha' });
        createCommand(app, { verb: 'drop', target: p.id, payload: {} }, new Date(T0));
        processQueue(agent, new Date(T0));
        appRecord = agent.get('application', p.id)!;
      }
      expect(appRecord.state).toBe(state);
      const before = agent.get('application', appRecord.id);
      let thrown: unknown;
      try {
        beginSubmit(
          agent,
          { applicationId: appRecord.id },
          { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
          new Date(T1),
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApplicationStateError);
      expect((thrown as Error).message).toContain(appRecord.id);
      expect((thrown as Error).message).toContain(state);
      const after = agent.get('application', appRecord.id);
      expect(after).toEqual(before);
    },
  );

  // B20 amended (N2)
  test('B20 amended: beginSubmit with { applicationId } on error park with afterSubmit: true throws ApplicationStateError and writes nothing', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const s = seedInterruptedSubmit('p1');
    expect(s.park?.type).toBe('error');
    expect(s.park?.afterSubmit).toBe(true);

    const before = agent.get('application', s.id)!;
    let thrown: unknown;
    try {
      beginSubmit(
        agent,
        { applicationId: s.id },
        { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
        new Date(T1),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApplicationStateError);
    expect((thrown as Error).message).toContain(s.id);
    expect((thrown as Error).message).toContain(s.state);
    const after = agent.get('application', s.id);
    expect(after).toEqual(before);
  });

  // B23 (M1)
  test.each(['submitted', 'done', 'dropped', 'skipped'] as const)(
    'B23 recordOutcome with park or skipped on %s throws ApplicationStateError and writes nothing',
    (state) => {
      app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
      app.put('point', sample.point({ id: 'hn', kind: 'hard_no', rank: CONFIRMED, rev: 1 }));
      let appRecord: Application;
      if (state === 'submitted') {
        const s = beginSubmit(agent, appInput(), { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
        appRecord = recordOutcome(agent, { applicationId: s.id }, { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
      } else if (state === 'skipped') {
        appRecord = recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: 'hn' }, new Date(T0));
      } else if (state === 'done') {
        const p = seedPark('p-done2', { type: 'captcha' });
        createCommand(app, { verb: 'done', target: p.id, payload: {} }, new Date(T0));
        processQueue(agent, new Date(T0));
        appRecord = agent.get('application', p.id)!;
      } else {
        const p = seedPark('p-drop2', { type: 'captcha' });
        createCommand(app, { verb: 'drop', target: p.id, payload: {} }, new Date(T0));
        processQueue(agent, new Date(T0));
        appRecord = agent.get('application', p.id)!;
      }
      const before = agent.get('application', appRecord.id);
      expect(() =>
        recordOutcome(agent, { applicationId: appRecord.id }, { type: 'park', park: { type: 'captcha' } }, new Date(T1)),
      ).toThrow(ApplicationStateError);
      expect(() =>
        recordOutcome(agent, { applicationId: appRecord.id }, { type: 'skipped', hardNoPointId: 'hn' }, new Date(T1)),
      ).toThrow(ApplicationStateError);
      expect(agent.get('application', appRecord.id)).toEqual(before);
    },
  );

  // B23 (M1) submitted idempotent on already submitted
  test('B23 recordOutcome submitted on already submitted returns existing record unchanged', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const s = beginSubmit(agent, appInput(), { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
    const first = recordOutcome(agent, { applicationId: s.id }, { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
    const second = recordOutcome(agent, { applicationId: s.id }, { type: 'submitted', resumeFile: 'other.pdf', points: [] }, new Date(T1));
    expect(second).toEqual(first);
    expect(agent.get('application', s.id)).toEqual(first);
  });

  // B23 (M1) submitted always recorded even from done or dropped
  test('B23 recordOutcome submitted on done or dropped application records submission', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const p = seedPark('p-done-sub', { type: 'captcha' });
    createCommand(app, { verb: 'done', target: p.id, payload: {} }, new Date(T0));
    processQueue(agent, new Date(T0));
    expect(agent.get('application', p.id)!.state).toBe('done');

    const result = recordOutcome(
      agent,
      { applicationId: p.id },
      { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      new Date(T1),
    );
    expect(result.state).toBe('submitted');
    expect(result.submission).toMatchObject({ resumeFile: 'cv.pdf', submittedAt: T1 });
    expect(result.closedAt).toBeNull();
    expect(agent.get('application', p.id)!.state).toBe('submitted');
    expect(agent.get('application', p.id)!.closedAt).toBeNull();

    const pDrop = seedPark('p-drop-sub', { type: 'captcha' });
    createCommand(app, { verb: 'drop', target: pDrop.id, payload: { reason: 'not interested' } }, new Date(T0));
    processQueue(agent, new Date(T0));
    expect(agent.get('application', pDrop.id)!.state).toBe('dropped');
    expect(agent.get('application', pDrop.id)!.closedAt).not.toBeNull();

    const resDrop = recordOutcome(
      agent,
      { applicationId: pDrop.id },
      { type: 'submitted', resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      new Date(T1),
    );
    expect(resDrop.state).toBe('submitted');
    expect(resDrop.closedAt).toBeNull();
    expect(agent.get('application', pDrop.id)!.closedAt).toBeNull();
  });

  // B24 (L3, r26)
  test.each(['human', 'sign_in', 'code', 'missing_answer', 'verify', 'captcha'] as const)(
    'B24 recordOutcome with afterSubmit true on %s park throws Error and writes nothing',
    (parkType) => {
      expect(() =>
        recordOutcome(
          agent,
          appInput(),
          { type: 'park', park: { type: parkType, afterSubmit: true, note: `${parkType} after submit` } },
          new Date(T0),
        ),
      ).toThrow();
      expect(agent.list('application').items).toEqual([]);
    },
  );

  // B25 (L4)
  test('B25 recordOutcome with unknown outcome type throws Error and writes nothing', () => {
    expect(() =>
      recordOutcome(
        agent,
        appInput(),
        { type: 'done' } as any,
        new Date(T0),
      ),
    ).toThrow();
    expect(agent.list('application').items).toEqual([]);
  });

  // B26 (L6)
  test('B26 beginSubmit, recordOutcome and upsertRole throw when link is not http or https', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const badLinks = [
      'javascript:alert(document.cookie)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
    ];
    for (const link of badLinks) {
      expect(() =>
        upsertRole(agent, roleInput({ link }), new Date(T0)),
      ).toThrow();
      expect(() =>
        beginSubmit(
          agent,
          appInput({ link }),
          { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
          new Date(T0),
        ),
      ).toThrow();
      expect(() =>
        recordOutcome(
          agent,
          appInput({ link }),
          { type: 'park', park: { type: 'human' } },
          new Date(T0),
        ),
      ).toThrow();
    }
    expect(agent.list('role').items).toEqual([]);
    expect(agent.list('application').items).toEqual([]);
  });

  // L2 / B2
  test('B2 assertSendable with unsafe or non-id-shaped pointId throws UnsendablePointError', () => {
    const badPointIds = ['../../cob', 'Notice period', '', 'a/b'];
    for (const badId of badPointIds) {
      expect(() =>
        assertSendable(agent, [{ pointId: badId, rev: 1 }]),
      ).toThrow(UnsendablePointError);
    }
    expect(() =>
      assertSendable(agent, [{ pointId: 'p1', rev: 0 }]),
    ).toThrow(UnsendablePointError);
    expect(() =>
      assertSendable(agent, [{ pointId: 'p1', rev: '1' as any }]),
    ).toThrow(UnsendablePointError);
  });

  // L2 / B6
  test('B6 recordOutcome skipped with non-id-shaped hardNoPointId throws UnsendablePointError', () => {
    expect(() =>
      recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: '../x' }, new Date(T0)),
    ).toThrow(UnsendablePointError);
    expect(agent.list('application').items).toEqual([]);
  });

  // m04 [B2]
  test('B2 m04 beginSubmit with bad ref on existing application leaves it unchanged', () => {
    const parked = seedPark('p-existing-m04', { type: 'captcha' });
    const before = agent.get('application', parked.id);
    expect(() =>
      beginSubmit(
        agent,
        { applicationId: parked.id },
        { resumeFile: 'cv.pdf', points: [{ pointId: 'missing-point', rev: 1 }] },
        new Date(T1),
      ),
    ).toThrow(UnsendablePointError);
    const after = agent.get('application', parked.id);
    expect(after).toEqual(before);
  });

  // m11 [B5]
  test('B5 m11 recordOutcome park sets park.at to now', () => {
    const a = recordOutcome(agent, appInput(), { type: 'park', park: { type: 'captcha' } }, new Date(T1));
    expect(a.park!.at).toBe(T1);
  });

  // m12 [B6]
  test('B6 m12 skip refuses an unsure hard_no', () => {
    app.put('point', sample.point({ id: 'hu', kind: 'hard_no', rank: UNSURE, rev: 1 }));
    expect(() =>
      recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: 'hu' }, new Date(T0)),
    ).toThrow(UnsendablePointError);
    expect(agent.list('application').items).toEqual([]);
  });

  // m14 [B6]
  test('B6 m14 skip with refused point writes nothing to disk', () => {
    app.put('point', sample.point({ id: 's', kind: 'skill', rank: CONFIRMED, rev: 1 }));
    expect(() =>
      recordOutcome(agent, appInput(), { type: 'skipped', hardNoPointId: 's' }, new Date(T0)),
    ).toThrow(UnsendablePointError);
    expect(agent.list('application').items).toEqual([]);
  });

  // m20 [D5]
  test('D5 m20 recordOutcome on existing application updates updatedAt', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const p = seedPark('p-upd-m20', { type: 'captcha' });
    expect(p.updatedAt).toBe(T0);
    const updated = recordOutcome(
      agent,
      { applicationId: p.id },
      { type: 'park', park: { type: 'human' } },
      new Date(T1),
    );
    expect(updated.updatedAt).toBe(T1);
    expect(agent.get('application', p.id)!.updatedAt).toBe(T1);
  });

  // m21 [D5]
  test('D5 m21 beginSubmit on existing application updates updatedAt', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const p = seedPark('p-upd-m21', { type: 'captcha' });
    expect(p.updatedAt).toBe(T0);
    const updated = beginSubmit(
      agent,
      { applicationId: p.id },
      { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] },
      new Date(T1),
    );
    expect(updated.updatedAt).toBe(T1);
    expect(agent.get('application', p.id)!.updatedAt).toBe(T1);
  });

  // B23 amended (N5): recordOutcome park (unless error + afterSubmit) or skipped on error with afterSubmit throws ApplicationStateError
  test('B23 amended (N5): recordOutcome with plain park or skipped on error with afterSubmit throws ApplicationStateError and writes nothing', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    app.put('point', sample.point({ id: 'hn', kind: 'hard_no', rank: CONFIRMED, rev: 1 }));
    const s = seedInterruptedSubmit('p1');
    expect(s.park?.type).toBe('error');
    expect(s.park?.afterSubmit).toBe(true);

    const before = agent.get('application', s.id)!;

    // Plain park (e.g. sign_in) throws ApplicationStateError and writes nothing
    let thrownPark: unknown;
    try {
      recordOutcome(
        agent,
        { applicationId: s.id },
        { type: 'park', park: { type: 'sign_in', site: 'jobs.example.com' } },
        new Date(T1),
      );
    } catch (err) {
      thrownPark = err;
    }
    expect(thrownPark).toBeInstanceOf(ApplicationStateError);
    expect((thrownPark as Error).message).toContain(s.id);
    expect((thrownPark as Error).message).toContain(s.state);
    expect(agent.get('application', s.id)).toEqual(before);

    // Skipped throws ApplicationStateError and writes nothing
    let thrownSkip: unknown;
    try {
      recordOutcome(
        agent,
        { applicationId: s.id },
        { type: 'skipped', hardNoPointId: 'hn' },
        new Date(T1),
      );
    } catch (err) {
      thrownSkip = err;
    }
    expect(thrownSkip).toBeInstanceOf(ApplicationStateError);
    expect((thrownSkip as Error).message).toContain(s.id);
    expect((thrownSkip as Error).message).toContain(s.state);
    expect(agent.get('application', s.id)).toEqual(before);

    // Recording another error park with afterSubmit: true IS allowed
    const secondErrorPark = recordOutcome(
      agent,
      { applicationId: s.id },
      { type: 'park', park: { type: 'error', afterSubmit: true, note: 'Second crash' } },
      new Date(T1),
    );
    expect(secondErrorPark.park?.type).toBe('error');
    expect(secondErrorPark.park?.afterSubmit).toBe(true);
    expect(secondErrorPark.park?.note).toBe('Second crash');
  });

  // B28 (N8): new park written on application always has at strictly later than previous park at
  test('B28 (N8): new park written on an application always has at strictly later than previous park at', () => {
    app.put('point', sample.point({ id: 'p1', rank: CONFIRMED, rev: 1 }));
    const p = recordOutcome(
      agent,
      appInput(),
      { type: 'park', park: { type: 'captcha' } },
      new Date(T1),
    );
    expect(p.park!.at).toBe(T1); // '2026-11-11T10:00:00.000Z'

    // Candidate clock is same timestamp (T1) -> must become T1 + 1ms
    const pSame = recordOutcome(
      agent,
      { applicationId: p.id },
      { type: 'park', park: { type: 'human' } },
      new Date(T1),
    );
    expect(pSame.park!.at).toBe('2026-11-11T10:00:00.001Z');
    expect(pSame.parkHistory[1]!.at).toBe('2026-11-11T10:00:00.001Z');

    // Candidate clock is earlier than previous park at (T0 < 10:00:00.001Z) -> must become 10:00:00.001Z + 1ms = 10:00:00.002Z
    const pEarlier = recordOutcome(
      agent,
      { applicationId: p.id },
      { type: 'park', park: { type: 'verify' } },
      new Date(T0),
    );
    expect(pEarlier.park!.at).toBe('2026-11-11T10:00:00.002Z');
    expect(pEarlier.parkHistory[2]!.at).toBe('2026-11-11T10:00:00.002Z');

    // Also verify recoverInterrupted enforces B28 when candidate time is same as previous park
    const R = new Date(T1);
    // Another posting (one application per posting, R52)
    const sub = beginSubmit(agent, appInput({ link: 'https://careers.example.com/jobs/2' }), { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T0));
    // Initial recovery at R
    const rec1 = recoverInterrupted(agent, R);
    expect(rec1[0]!.park!.at).toBe(T1);

    // Confirm retry so beginSubmit is allowed
    createCommand(app, { verb: 'retry', target: sub.id, payload: { notSent: true, parkAt: T1 } }, new Date('2026-11-11T10:30:00.000Z'));
    processQueue(agent, new Date('2026-11-11T10:31:00.000Z'));

    // Begin submit again, then recover with the same R
    const subAgain = beginSubmit(agent, { applicationId: sub.id }, { resumeFile: 'cv.pdf', points: [{ pointId: 'p1', rev: 1 }] }, new Date(T1));
    expect(subAgain.park).toBeNull();
    const rec2 = recoverInterrupted(agent, R);
    expect(rec2[0]!.park!.at).toBe('2026-11-11T10:00:00.001Z');
  });
});
