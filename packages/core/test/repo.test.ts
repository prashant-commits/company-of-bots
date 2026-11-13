import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { DataRepo, OwnershipError, UnsupportedSchemaError } from '../src/repo.ts';
import { UnsafeNameError } from '../src/ids.ts';
import { pair, sample, T0, tmpDir, tmpRepo } from './helpers.ts';

test('put then get round-trips and writes pretty JSON with a trailing newline', () => {
  const r = tmpRepo('app');
  const p = sample.point();
  r.put('point', p);
  expect(r.get('point', p.id)).toEqual(p);
  const raw = fs.readFileSync(path.join(r.dir, 'profile/points', `${p.id}.json`), 'utf8');
  expect(raw.endsWith('}\n')).toBe(true);
  expect(raw).toContain('\n  "id"');
});

test('list skips corrupt and invalid files and reports them', () => {
  const r = tmpRepo('app');
  r.put('point', sample.point({ id: 'a' }));
  fs.writeFileSync(path.join(r.dir, 'profile/points/b.json'), '{not json');
  fs.writeFileSync(path.join(r.dir, 'profile/points/c.json'), JSON.stringify({ id: 'c' }));
  const { items, errors } = r.list('point');
  expect(items.map((p) => p.id)).toEqual(['a']);
  expect(errors.map((e) => path.basename(e.file)).sort()).toEqual(['b.json', 'c.json']);
});

test('writers may only touch what they own', () => {
  const dir = tmpDir();
  expect(() => tmpRepo('agent', dir).put('point', sample.point())).toThrow(OwnershipError);
  expect(() => tmpRepo('app', dir).put('application', sample.application())).toThrow(OwnershipError);
});

test('commands: app creates only, agent updates only, nobody deletes', () => {
  const dir = tmpDir();
  const app = tmpRepo('app', dir);
  const agent = tmpRepo('agent', dir);
  const c = sample.command();
  expect(() => agent.put('command', c)).toThrow(OwnershipError);
  app.put('command', c);
  expect(() => app.put('command', { ...c, state: 'done' })).toThrow(OwnershipError);
  expect(() => agent.put('command', { ...c, state: 'done' })).not.toThrow();
  expect(() => agent.delete('command', c.id)).toThrow(OwnershipError);
});

test('ids and blob paths cannot escape the repo', () => {
  const r = tmpRepo('app');
  expect(() => r.put('point', sample.point({ id: '../x' }))).toThrow(UnsafeNameError);
  expect(() => r.writeBlob('../outside.pdf', new Uint8Array([1]))).toThrow(UnsafeNameError);
});

test('a repo with an unknown format version is refused', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'cob.json'), JSON.stringify({ schemaVersion: 2, createdAt: T0 }));
  expect(() => new DataRepo(dir, 'app')).toThrow(UnsupportedSchemaError);
  fs.writeFileSync(path.join(dir, 'cob.json'), JSON.stringify({ schemaVersion: 1, createdAt: T0 }));
  expect(() => new DataRepo(dir, 'app')).not.toThrow();
});

test('put leaves no temp files', () => {
  const r = tmpRepo('app');
  r.put('point', sample.point());
  expect(fs.readdirSync(path.join(r.dir, 'profile/points')).every((f) => f.endsWith('.json'))).toBe(true);
});

// B5b: get on a broken existing file throws with the path in the message
test('B5b get throws for a broken existing file instead of returning null', () => {
  const r = tmpRepo('app');
  const file = path.join(r.dir, 'profile/points/broken.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  expect(() => r.get('point', 'broken')).toThrow(/broken\.json/);
  fs.writeFileSync(file, JSON.stringify({ id: 'broken' }));
  expect(() => r.get('point', 'broken')).toThrow(/broken\.json/);
});

// B7: putting the same record twice yields byte-identical files
test('B7 repeated put gives byte-identical files', () => {
  const r = tmpRepo('app');
  const p = sample.point({ id: 'dup' });
  r.put('point', p);
  const first = fs.readFileSync(path.join(r.dir, 'profile/points/dup.json'));
  r.put('point', p);
  const second = fs.readFileSync(path.join(r.dir, 'profile/points/dup.json'));
  expect(Buffer.compare(first, second)).toBe(0);
});

// B12: app and agent repos on one dir each touch only owned files
test('B12 two repos on one dir write only their own kinds', () => {
  const { app, agent } = pair();
  app.put('point', sample.point({ id: 'only-app' }));
  agent.put('application', sample.application({ id: 'only-agent' }));
  expect(app.get('point', 'only-app')).not.toBeNull();
  expect(agent.get('application', 'only-agent')).not.toBeNull();
  expect(agent.get('point', 'only-app')).toEqual(app.get('point', 'only-app'));
});
