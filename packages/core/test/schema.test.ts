import { expect, test } from 'vitest';
import {
  ApplicationSchema,
  CommandSchema,
  PointSchema,
  SourceSchema,
  type Command,
} from '../src/schema.ts';
import { KINDS, ownerOfPath, type KindName } from '../src/layout.ts';
import { sample, T0 } from './helpers.ts';

test.each(Object.keys(KINDS) as KindName[])('%s sample round-trips', (k) => {
  const rec = sample[k]();
  expect(KINDS[k].schema.parse(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
});

test('unknown fields survive a parse', () => {
  expect(PointSchema.parse({ ...sample.point(), adapterX: 1 })).toHaveProperty('adapterX', 1);
});

test('a point needs evidence, an integer rank and a revision', () => {
  const { evidence: _evidence, ...noEv } = sample.point();
  expect(PointSchema.safeParse(noEv).success).toBe(false);
  expect(PointSchema.safeParse({ ...sample.point(), rank: 100.5 }).success).toBe(false);
  expect(PointSchema.safeParse({ ...sample.point(), rev: 0 }).success).toBe(false);
});

test('command payload must fit its verb', () => {
  expect(
    CommandSchema.safeParse({ ...sample.command(), verb: 'lane_done', payload: {} } as unknown as Command).success,
  ).toBe(false);
  expect(
    CommandSchema.safeParse(sample.command({ verb: 'lane_done', payload: { day: '2026-11-11' }, target: 'one-outreach' }))
      .success,
  ).toBe(true);
  expect(CommandSchema.safeParse(sample.command({ verb: 'status', payload: { kind: 'reply', text: '' } })).success).toBe(
    false,
  );
  expect(CommandSchema.safeParse(sample.command({ verb: 'run_role', payload: { role: 'interviewer' as 'finder' } })).success).toBe(
    false,
  );
  expect(CommandSchema.safeParse(sample.command({ verb: 'retry', payload: { notSent: true }, target: 'a1' })).success).toBe(true);
});

test('a submitting application carries its intended submission; error parks can be after the click', () => {
  expect(
    ApplicationSchema.safeParse(
      sample.application({
        state: 'submitting',
        park: null,
        pendingSubmission: {
          resumeFile: 'cv.pdf',
          points: [{ pointId: 'p', rev: 1, field: 'Notice period' }],
          startedAt: T0,
        },
      }),
    ).success,
  ).toBe(true);
  expect(
    ApplicationSchema.safeParse(
      sample.application({ park: { type: 'error', at: T0, afterSubmit: true, note: 'Error page after submit' } }),
    ).success,
  ).toBe(true);
  expect(ApplicationSchema.safeParse(sample.application({ park: { type: 'email' as 'captcha', at: T0 } })).success).toBe(false);
});

test('source url must be http(s)', () => {
  expect(SourceSchema.safeParse(sample.source({ url: 'javascript:alert(1)' })).success).toBe(false);
});

test('ownerOfPath maps every layout path to its owner', () => {
  expect(ownerOfPath('profile/points/p1.json')).toBe('app');
  expect(ownerOfPath('profile/resumes/My Résumé.pdf')).toBe('app');
  expect(ownerOfPath('guide/lanes.json')).toBe('app');
  expect(ownerOfPath('applications/a1.json')).toBe('agent');
  expect(ownerOfPath('commands/c1.json')).toBe('agent');
  expect(ownerOfPath('guide/log/2026-11-11.json')).toBe('agent');
  expect(ownerOfPath('commands/README.md')).toBe('agent');
  expect(ownerOfPath('sources/README.md')).toBe('app');
  expect(ownerOfPath('notes.txt')).toBeNull();
});
