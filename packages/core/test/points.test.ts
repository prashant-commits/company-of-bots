import { expect, test } from 'vitest';
import { CONFIRMED, UNSURE, isSendable, rankText, sortForProfile } from '../src/confidence.ts';
import { applyPointOp, PointOpError } from '../src/points.ts';
import { sample, said } from './helpers.ts';

const ctx = { interviewId: 'i1', now: '2026-11-11T10:00:00.000Z', id: () => 'p1' };

test('stated fact starts at Confirmed, revision 1, sendable', () => {
  const p = applyPointOp(null, { op: 'add', kind: 'skill', text: 'Forklift licence', evidence: said('forklift licence') }, ctx)!;
  expect(p).toMatchObject({ rank: CONFIRMED, rev: 1, interviewId: 'i1' });
  expect(isSendable(p)).toBe(true);
});

test('reconfirm raises rank within Confirmed and keeps the revision', () => {
  const p = sample.point({ rank: CONFIRMED, rev: 2 });
  expect(applyPointOp(p, { op: 'confirm', pointId: p.id, evidence: said('yes') }, ctx)).toMatchObject({
    rank: CONFIRMED + 1,
    rev: 2,
  });
});

test('20.4 correction replaces wording, resets rank and raises the revision', () => {
  const p = sample.point({ rank: CONFIRMED + 3, rev: 1, text: 'Excel' });
  const c = applyPointOp(
    p,
    { op: 'correct', pointId: p.id, text: 'Excel and Google Sheets', evidence: said('excel and google sheets') },
    ctx,
  )!;
  expect(c).toMatchObject({ id: p.id, text: 'Excel and Google Sheets', rank: CONFIRMED, rev: 2 });
});

test('unsure drops below Confirmed and is not sendable', () => {
  expect(isSendable(applyPointOp(sample.point(), { op: 'unsure', pointId: 'x', evidence: said('not sure') }, ctx)!)).toBe(false);
  expect(
    isSendable(
      applyPointOp(
        null,
        {
          op: 'add',
          kind: 'answer',
          label: 'Notice period',
          text: 'maybe 30 days',
          unsure: true,
          evidence: said('maybe 30 days'),
        },
        ctx,
      )!,
    ),
  ).toBe(false);
});

test('confirming an unsure point brings it back to Confirmed', () => {
  expect(applyPointOp(sample.point({ rank: UNSURE }), { op: 'confirm', pointId: 'x', evidence: said('yes') }, ctx)!.rank).toBe(
    CONFIRMED,
  );
});

test('ops on a missing point throw; remove returns null', () => {
  expect(() => applyPointOp(null, { op: 'confirm', pointId: 'x', evidence: said('yes') }, ctx)).toThrow(PointOpError);
  expect(applyPointOp(sample.point(), { op: 'remove', pointId: 'x', evidence: said('drop that') }, ctx)).toBeNull();
});

test('profile order is lowest rank first; rankText labels', () => {
  const ps = [sample.point({ id: 'a', rank: 102 }), sample.point({ id: 'b', rank: 0 }), sample.point({ id: 'c', rank: 100 })];
  expect(sortForProfile(ps).map((p) => p.id)).toEqual(['b', 'c', 'a']);
  expect([rankText(0), rankText(100), rankText(102)]).toEqual(['Unsure', 'Confirmed', 'Confirmed ×3']);
});
