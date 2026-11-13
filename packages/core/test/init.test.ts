import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { DataRepo } from '../src/repo.ts';
import { DEFAULT_LANES, initDataLayout } from '../src/init.ts';
import { PRIVATE_REPO_NOTICE } from '../src/copy.ts';
import { tmpDir } from './helpers.ts';

let dir: string;
let app: DataRepo;

beforeEach(() => {
  dir = tmpDir();
  app = new DataRepo(dir, 'app');
});

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(path.join(root, r)).isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

test('20.13 a fresh layout has no sources', () => {
  initDataLayout(dir);
  expect(app.list('source').items).toEqual([]);
  expect(fs.readFileSync(path.join(dir, 'sources/README.md'), 'utf8')).toContain('https://careers.example.com/jobs');
});

test('20.16 three starting lanes and no other routine', () => {
  initDataLayout(dir);
  expect(app.getSingleton('lanes')!.lanes.map((l) => l.name)).toEqual(['People you owe', 'Applications waiting on you', 'One outreach']);
  expect(fs.readdirSync(path.join(dir, 'guide'))).toEqual(['lanes.json']);
});

test('init refuses a non-empty folder but accepts one holding only .git', () => {
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  expect(() => initDataLayout(dir)).toThrow();
  const d2 = tmpDir();
  fs.mkdirSync(path.join(d2, '.git'));
  expect(() => initDataLayout(d2)).not.toThrow();
  expect(new DataRepo(d2, 'app').getSingleton('meta')).toMatchObject({ schemaVersion: 1 });
});

test('B1 writes exactly the documented files', () => {
  const now = new Date('2026-11-12T08:00:00.000Z');
  initDataLayout(dir, now);
  expect(walk(dir)).toEqual(['.gitignore', 'README.md', 'cob.json', 'guide/lanes.json', 'profile/declarations.json', 'sources/README.md']);
  expect(app.getSingleton('meta')).toEqual({ schemaVersion: 1, createdAt: now.toISOString() });
  expect(app.getSingleton('lanes')).toEqual({ lanes: DEFAULT_LANES });
  expect(DEFAULT_LANES.map((l) => l.id)).toEqual(['people-owed', 'waiting-on-you', 'one-outreach']);
  expect(app.getSingleton('declarations')).toEqual({ hardNosNone: false, sourcesDecideLater: false });
  expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain(PRIVATE_REPO_NOTICE);
  expect(PRIVATE_REPO_NOTICE).toBe('This private repo holds your interview transcripts and your resume files. Keep it private.');
  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n');
  for (const line of ['cookies/', '*.cookies.json', 'storage-state*.json', 'secrets/', '.env*']) expect(ignore).toContain(line);
});

test('B1 the example source URL appears only inside a fenced example block', () => {
  initDataLayout(dir);
  const text = fs.readFileSync(path.join(dir, 'sources/README.md'), 'utf8');
  const outside = text.replace(/```[\s\S]*?```/g, '');
  expect(outside).not.toContain('careers.example.com');
  expect(text.match(/```[\s\S]*?```/g)!.join('')).toContain('https://careers.example.com/jobs');
});

test('B1 a dir holding only .git is accepted and the .git is left alone', () => {
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'marker'), 'keep');
  initDataLayout(dir);
  expect(fs.readFileSync(path.join(dir, '.git', 'marker'), 'utf8')).toBe('keep');
});

test('B2 a folder with any other entry throws and nothing is written', () => {
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, 'empty-folder'));
  expect(() => initDataLayout(dir)).toThrow(/not empty/);
  expect(walk(dir)).toEqual([]);
  expect(fs.readdirSync(dir).sort()).toEqual(['.git', 'empty-folder']);
});

test('init creates the folder when it does not exist', () => {
  const target = path.join(dir, 'a', 'b');
  initDataLayout(target);
  expect(new DataRepo(target, 'app').getSingleton('meta')).toMatchObject({ schemaVersion: 1 });
});
