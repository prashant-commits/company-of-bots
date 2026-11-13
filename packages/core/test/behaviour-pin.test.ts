import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ownerOfPath, KINDS } from '../src/layout.ts';
import { DataRepo, OwnershipError, UnsupportedSchemaError } from '../src/repo.ts';
import {
  ApplicationSchema,
  CommandSchema,
  PointRefSchema,
  ParkSchema,
  SourceSchema,
} from '../src/schema.ts';
import { CONFIRMED, isSendable, rankText, sortForProfile } from '../src/confidence.ts';
import { applyPointOp, PointOpError } from '../src/points.ts';
import {
  createCommand,
  finishCommand,
  queuedCommands,
  CommandError,
  type CommandInput,
} from '../src/commands.ts';
import { OwnershipError as OwnErr } from '../src/repo.ts';
import { UnsafeNameError } from '../src/ids.ts';
import { pair, sample, said, seedLanes, T0, T1, tmpDir, tmpRepo } from './helpers.ts';

test('B1 list returns records sorted by id', () => {
  const r = tmpRepo('app');
  r.put('point', sample.point({ id: 'z' }));
  r.put('point', sample.point({ id: 'a' }));
  expect(r.list('point').items.map((p) => p.id)).toEqual(['a', 'z']);
});

test('B1 transcript file is named by interviewId', () => {
  const r = tmpRepo('app');
  const t = sample.transcript({ interviewId: 'int-99' });
  r.put('transcript', t);
  expect(fs.existsSync(path.join(r.dir, 'profile/transcripts/int-99.json'))).toBe(true);
});

test('B1 dayLog file is named by day', () => {
  const r = tmpRepo('agent');
  const d = sample.dayLog({ day: '2026-12-01' });
  r.put('dayLog', d);
  expect(fs.existsSync(path.join(r.dir, 'guide/log/2026-12-01.json'))).toBe(true);
});

test('B1 written JSON uses schema key order not caller key order', () => {
  const r = tmpRepo('app');
  const shuffled = JSON.parse(JSON.stringify(sample.point({ id: 'order' })));
  const keys = Object.keys(shuffled).reverse();
  const reordered = Object.fromEntries(keys.map((k) => [k, shuffled[k]]));
  r.put('point', reordered as typeof shuffled);
  const raw = fs.readFileSync(path.join(r.dir, 'profile/points/order.json'), 'utf8');
  const parsedKeys = Object.keys(JSON.parse(raw));
  const schemaKeys = Object.keys(KINDS.point.schema.parse(reordered));
  expect(parsedKeys).toEqual(schemaKeys);
});

test('B2 put rejects invalid records before writing', () => {
  const r = tmpRepo('app');
  const { evidence: _e, ...bad } = sample.point({ id: 'b2' });
  expect(() => r.put('point', bad as never)).toThrow();
  expect(fs.existsSync(path.join(r.dir, 'profile/points/b2.json'))).toBe(false);
});

test('B2 putSingleton rejects invalid singletons before writing', () => {
  const r = tmpRepo('app');
  expect(() => r.putSingleton('lanes', { lanes: [{ id: 'x', name: '' }] })).toThrow();
  expect(fs.existsSync(path.join(r.dir, 'guide/lanes.json'))).toBe(false);
});

test('B2 source url rejects ftp protocol', () => {
  expect(SourceSchema.safeParse(sample.source({ url: 'ftp://files.example.com/x' })).success).toBe(false);
});

test('B3 PointRef keeps unknown fields on parse', () => {
  expect(PointRefSchema.parse({ pointId: 'p', rev: 1, extra: 1 })).toHaveProperty('extra', 1);
});

test('B3 Park keeps unknown fields on parse', () => {
  expect(ParkSchema.parse({ type: 'captcha', at: T0, adapterX: true })).toHaveProperty('adapterX', true);
});

test('B3 Application keeps unknown top-level fields on parse', () => {
  expect(ApplicationSchema.parse({ ...sample.application(), adapterY: 2 })).toHaveProperty('adapterY', 2);
});

test('B3 Command base keeps unknown fields on parse', () => {
  expect(CommandSchema.parse({ ...sample.command(), adapterZ: 3 })).toHaveProperty('adapterZ', 3);
});

test('B4 putSingleton rejects wrong writer before write', () => {
  const dir = tmpDir();
  const agent = tmpRepo('agent', dir);
  expect(() => agent.putSingleton('lanes', sample.lanes())).toThrow(OwnershipError);
  expect(fs.existsSync(path.join(dir, 'guide/lanes.json'))).toBe(false);
});

test('B4 delete rejects wrong writer', () => {
  const dir = tmpDir();
  const app = tmpRepo('app', dir);
  app.put('point', sample.point({ id: 'del' }));
  expect(() => tmpRepo('agent', dir).delete('point', 'del')).toThrow(OwnershipError);
  expect(app.get('point', 'del')).not.toBeNull();
});

test('B4 layout owners match constraints table', () => {
  expect(KINDS.interview.owner).toBe('app');
  expect(KINDS.transcript.owner).toBe('app');
  expect(KINDS.source.owner).toBe('app');
  expect(KINDS.role.owner).toBe('agent');
  expect(KINDS.dayLog.owner).toBe('agent');
  expect(ownerOfPath('guide/lanes.json')).toBe('app');
  expect(ownerOfPath('profile/master.json')).toBe('app');
  expect(ownerOfPath('agent/status.json')).toBe('agent');
});

test('B4 failed put writes nothing to disk', () => {
  const dir = tmpDir();
  expect(() => tmpRepo('agent', dir).put('point', sample.point({ id: 'nw' }))).toThrow(OwnershipError);
  expect(fs.existsSync(path.join(dir, 'profile/points/nw.json'))).toBe(false);
});

test('B4 failed putSingleton writes nothing to disk', () => {
  const dir = tmpDir();
  expect(() => tmpRepo('agent', dir).putSingleton('lanes', sample.lanes())).toThrow(OwnershipError);
  expect(fs.existsSync(path.join(dir, 'guide/lanes.json'))).toBe(false);
});

test('B4b agent cannot writeBlob over a point file', () => {
  const { app, agent } = pair();
  app.put('point', sample.point({ id: 'p1', rank: 0 }));
  const buf = new Uint8Array(Buffer.from(JSON.stringify({ ...sample.point({ id: 'p1', rank: 100 }) }), 'utf8'));
  expect(() => agent.writeBlob('profile/points/p1.json', buf)).toThrow(OwnershipError);
  expect(app.get('point', 'p1')?.rank).toBe(0);
});

test('B4b app cannot writeBlob under commands', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application());
  const c = createCommand(app, { verb: 'done', target: 'a1', payload: {} });
  finishCommand(agent, c.id, 'done', 'ok');
  expect(() => app.writeBlob(`commands/${c.id}.json`, new Uint8Array([1]))).toThrow(OwnershipError);
  expect(app.get('command', c.id)?.state).toBe('done');
});

test('B4b only app may write resume blobs', () => {
  const { app, agent } = pair();
  expect(() => agent.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1]))).toThrow(OwnershipError);
  expect(() => app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1, 2]))).not.toThrow();
});

test('B4b blob write rejects .git paths', () => {
  const app = tmpRepo('app');
  expect(() => app.writeBlob('.git/hooks/pre-commit', new Uint8Array([1]))).toThrow(UnsafeNameError);
  expect(() => app.readBlob('.git/config')).toThrow(UnsafeNameError);
});

test('B5b getSingleton throws for broken singleton', () => {
  const r = tmpRepo('app');
  fs.mkdirSync(path.join(r.dir, 'guide'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'guide/lanes.json'), '{bad');
  expect(() => r.getSingleton('lanes')).toThrow(/lanes\.json/);
});

test('B5c list reports record whose id does not match file name', () => {
  const r = tmpRepo('app');
  r.put('point', sample.point({ id: 'good' }));
  fs.writeFileSync(path.join(r.dir, 'profile/points/copy.json'), JSON.stringify(sample.point({ id: 'good' })));
  const { items, errors } = r.list('point');
  expect(items).toHaveLength(1);
  expect(errors.some((e) => e.file.endsWith('copy.json'))).toBe(true);
});

test('B5c get throws when record id does not match file name', () => {
  const r = tmpRepo('app');
  const file = path.join(r.dir, 'profile/points/wrong.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sample.point({ id: 'other' })));
  expect(() => r.get('point', 'wrong')).toThrow(/wrong\.json/);
});

test('B6 get rejects unsafe id', () => {
  const r = tmpRepo('app');
  expect(() => r.get('point', '../escape')).toThrow(UnsafeNameError);
});

test('B6 delete rejects unsafe id', () => {
  const r = tmpRepo('app');
  expect(() => r.delete('point', '../escape')).toThrow(UnsafeNameError);
});

test('B6 sibling repo prefix cannot escape via blob read', () => {
  const base = tmpDir();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const sibling = path.join(base, 'repoSibling');
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'SECRET');
  const r = tmpRepo('app', repo);
  expect(() => r.readBlob(path.join('..', 'repoSibling/secret.txt'))).toThrow(UnsafeNameError);
});

test('B6 symlinked kind directory is refused on put', () => {
  const base = tmpDir();
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'profile'), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, 'profile/points'));
  const r = tmpRepo('app', repo);
  expect(() => r.put('point', sample.point({ id: 'sy' }))).toThrow(UnsafeNameError);
  expect(fs.existsSync(path.join(outside, 'sy.json'))).toBe(false);
});

test('B6 writeBlob dot path throws without writing outside', () => {
  const dir = tmpDir();
  const r = tmpRepo('app', dir);
  expect(() => r.writeBlob('.', new Uint8Array([1]))).toThrow(UnsafeNameError);
  expect(fs.readdirSync(path.dirname(dir)).every((n) => !n.includes('.tmp-'))).toBe(true);
});

test('B7 list never returns tmp artifact names', () => {
  const r = tmpRepo('app');
  const d = path.join(r.dir, 'profile/resumes');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'cv.pdf'), 'x');
  fs.writeFileSync(path.join(d, 'cv.pdf.tmp-deadbeef'), 'leftover');
  expect(r.listBlobs('profile/resumes')).toEqual(['cv.pdf']);
});

test('B8 exact version message when createdAt missing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'cob.json'), JSON.stringify({ schemaVersion: 2 }));
  expect(() => new DataRepo(dir, 'app')).toThrow(
    'This data repo uses format version 2; this app supports version 1. Update the app.',
  );
});

test('B8 refuses older schemaVersion not only newer', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'cob.json'), JSON.stringify({ schemaVersion: 0, createdAt: T0 }));
  expect(() => new DataRepo(dir, 'app')).toThrow(/version 0/);
});

test('B8 invalid cob.json shape is refused', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'cob.json'), JSON.stringify({ createdAt: T0 }));
  expect(() => new DataRepo(dir, 'app')).toThrow(UnsupportedSchemaError);
});

test('B9 ownerOfPath maps non-json files under kind dirs', () => {
  expect(ownerOfPath('commands/README.md')).toBe('agent');
  expect(ownerOfPath('sources/README.md')).toBe('app');
  expect(ownerOfPath('profile/resume-text/cv.txt')).toBe('app');
});

test('B9 ownerOfPath recognises all singleton paths', () => {
  expect(ownerOfPath('cob.json')).toBe('app');
  expect(ownerOfPath('profile/master.json')).toBe('app');
  expect(ownerOfPath('agent/status.json')).toBe('agent');
});

test('B10 remove on missing point throws', () => {
  const ctx = { interviewId: 'i', now: T0, id: () => 'p' };
  expect(() => applyPointOp(null, { op: 'remove', pointId: 'x', evidence: said('x') }, ctx)).toThrow(PointOpError);
});

test('B10 confirm below Confirmed does not bump rev', () => {
  const ctx = { interviewId: 'i', now: T0, id: () => 'p' };
  const out = applyPointOp(sample.point({ rank: 0, rev: 2 }), { op: 'confirm', pointId: 'x', evidence: said('y') }, ctx)!;
  expect(out).toMatchObject({ rank: CONFIRMED, rev: 2 });
});

test('B10 confirm updates interviewId and updatedAt', () => {
  const ctx = { interviewId: 'i-new', now: T1, id: () => 'p' };
  const p = sample.point({ id: 'p' });
  const out = applyPointOp(p, { op: 'confirm', pointId: 'p', evidence: said('yes') }, ctx)!;
  expect(out.interviewId).toBe('i-new');
  expect(out.updatedAt).toBe(T1);
});

test('B10 correct replaces evidence', () => {
  const ctx = { interviewId: 'i', now: T0, id: () => 'p' };
  const ev = said('new evidence');
  const out = applyPointOp(sample.point(), { op: 'correct', pointId: 'x', text: 't', evidence: ev }, ctx)!;
  expect(out.evidence).toEqual(ev);
});

test('B10 unsure does not bump rev', () => {
  const ctx = { interviewId: 'i', now: T0, id: () => 'p' };
  const out = applyPointOp(sample.point({ rev: 3 }), { op: 'unsure', pointId: 'x', evidence: said('u') }, ctx)!;
  expect(out.rev).toBe(3);
});

test('B10 add preserves label and instruction', () => {
  const ctx = { interviewId: 'i', now: T0, id: () => 'p' };
  const out = applyPointOp(
    null,
    { op: 'add', kind: 'answer', text: 't', label: 'L', instruction: 'I', evidence: said('q') },
    ctx,
  )!;
  expect(out).toMatchObject({ label: 'L', instruction: 'I' });
});

test('B10 sortForProfile tie-breaks by updatedAt then id', () => {
  const ps = [
    sample.point({ id: 'b', rank: 100, updatedAt: T0 }),
    sample.point({ id: 'a', rank: 100, updatedAt: T0 }),
    sample.point({ id: 'c', rank: 100, updatedAt: T1 }),
  ];
  expect(sortForProfile(ps).map((p) => p.id)).toEqual(['a', 'b', 'c']);
});

test('B10 rankText treats ranks below 100 as Unsure', () => {
  expect(rankText(99)).toBe('Unsure');
  expect(isSendable({ rank: 99 })).toBe(false);
  expect(isSendable({ rank: CONFIRMED })).toBe(true);
});

test('B11 queuedCommands tie-breaks by id when createdAt equal', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  seedLanes(app);
  const t = new Date('2026-11-11T10:00:00Z');
  const c1 = createCommand(app, { verb: 'done', target: 'a1', payload: {} }, t);
  const c2 = createCommand(app, { verb: 'drop', target: 'a1', payload: {} }, t);
  const ids = queuedCommands(app).map((c) => c.id);
  expect(ids).toEqual([c1.id, c2.id].sort());
});

test('B11 lane_skip target must be a lane id', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  seedLanes(app);
  expect(() => createCommand(app, { verb: 'lane_skip', target: 'a1', payload: { day: '2026-11-11' } })).toThrow(
    CommandError,
  );
});

test('B11 done verb requires existing application target', () => {
  const { app } = pair();
  seedLanes(app);
  expect(() => createCommand(app, { verb: 'done', target: 'missing', payload: {} })).toThrow(CommandError);
});

test('B11 interview_saved requires null target', () => {
  const { app } = pair();
  expect(() =>
    createCommand(app, { verb: 'interview_saved', target: 'a1', payload: { interviewId: 'i1' } }),
  ).toThrow(CommandError);
});

test('B11 unsafe application target throws CommandError not UnsafeNameError', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application());
  expect(() => createCommand(app, { verb: 'retry', target: 'has space', payload: {} })).toThrow(CommandError);
  expect(() => createCommand(app, { verb: 'retry', target: '', payload: {} })).toThrow(CommandError);
});

test('B11 finishCommand always sets finishedAt', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  const c = createCommand(app, { verb: 'done', target: 'a1', payload: {} });
  const f = finishCommand(agent, c.id, 'failed', 'n', new Date('2026-11-11T12:00:00Z'));
  expect(f.finishedAt).toBe('2026-11-11T12:00:00.000Z');
});

test('B11 finishCommand rejects non-queued commands', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  const c = createCommand(app, { verb: 'done', target: 'a1', payload: {} });
  finishCommand(agent, c.id, 'failed', 'nope');
  expect(() => finishCommand(agent, c.id, 'done', 'again')).toThrow(CommandError);
});

test('B11 queuedCommands excludes failed commands', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  const c = createCommand(app, { verb: 'done', target: 'a1', payload: {} });
  finishCommand(agent, c.id, 'failed', 'x');
  expect(queuedCommands(app)).toHaveLength(0);
});

test('B11 createCommand is app-only', () => {
  const { agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  expect(() => createCommand(agent, { verb: 'done', target: 'a1', payload: {} })).toThrow(OwnErr);
});

test('B11 finishCommand is agent-only', () => {
  const { app, agent } = pair();
  agent.put('application', sample.application({ id: 'a1' }));
  const c = createCommand(app, { verb: 'done', target: 'a1', payload: {} });
  expect(() => finishCommand(app, c.id, 'done', 'n')).toThrow(OwnErr);
});

/** Compile-time CommandInput checks; never called at runtime. */
function commandInputTypeRegression(): void {
  const _status: CommandInput = { verb: 'status', target: 'a1', payload: { kind: 'reply', text: 'x' } };
  void _status;
  // @ts-expect-error status requires kind and text in payload
  const _badStatus: CommandInput = { verb: 'status', target: 'a1', payload: {} };
  void _badStatus;
  // @ts-expect-error lane_done requires day in payload
  const _badLane: CommandInput = { verb: 'lane_done', target: 'l', payload: {} };
  void _badLane;
  // @ts-expect-error run_role role must be finder|applier|guide
  const _badRole: CommandInput = { verb: 'run_role', target: null, payload: { role: 'interviewer' } };
  void _badRole;
  // @ts-expect-error retry payload cannot carry day
  const _badRetry: CommandInput = { verb: 'retry', target: 'a1', payload: { day: '2026-11-11' } };
  void _badRetry;
}

void commandInputTypeRegression;
