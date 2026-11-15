import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { DataRepo, OwnershipError, UnsupportedSchemaError } from '../src/repo.ts';
import { UnsafeNameError } from '../src/ids.ts';
import { KINDS, SINGLETONS } from '../src/layout.ts';
import {
  assertEntryIsPlainFile,
  assertRepoRelPath,
  atomicWrite,
  recordRelPath,
  resolveRepoPath,
  type GuardFs,
  type PathApi,
} from '../src/repo-paths.ts';
import { queuedCommands } from '../src/commands.ts';
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

test('B5d UTF-8 BOM on cob.json and record files is ignored on read', () => {
  const dir = tmpDir();
  const meta = JSON.stringify({ schemaVersion: 1, createdAt: T0 });
  fs.writeFileSync(path.join(dir, 'cob.json'), `\uFEFF${meta}`);
  expect(() => new DataRepo(dir, 'app')).not.toThrow();

  const r = new DataRepo(dir, 'app');
  const p = sample.point({ id: 'bom-point' });
  r.put('point', p);
  const file = path.join(r.dir, 'profile/points/bom-point.json');
  const body = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `\uFEFF${body}`);
  expect(r.get('point', 'bom-point')).toEqual(p);
  expect(r.list('point').items).toContainEqual(p);
});

test('B5d files written by the repo do not start with a UTF-8 BOM', () => {
  const r = tmpRepo('app');
  r.put('point', sample.point({ id: 'no-bom' }));
  const bytes = fs.readFileSync(path.join(r.dir, 'profile/points/no-bom.json'));
  expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
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

test('B4b deleteBlob refuses non-resume paths and .git', () => {
  const app = tmpRepo('app');
  app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1, 2]));
  expect(() => app.deleteBlob('profile/points/x.json')).toThrow(OwnershipError);
  expect(() => app.deleteBlob('.git/config')).toThrow(UnsafeNameError);
  expect(() => app.deleteBlob('profile/resumes/cv.pdf')).not.toThrow();
  expect(app.readBlob('profile/resumes/cv.pdf')).toBeNull();
});

test('B6 deleteBlob and listBlobs refuse escaping paths', () => {
  const app = tmpRepo('app');
  expect(() => app.deleteBlob('../x.pdf')).toThrow(UnsafeNameError);
  expect(() => app.listBlobs('..')).toThrow(UnsafeNameError);
});

test('B6 backslash paths throw UnsafeNameError on blob methods', () => {
  const app = tmpRepo('app');
  expect(() => app.writeBlob('profile\\resumes\\cv.pdf', new Uint8Array([1]))).toThrow(UnsafeNameError);
  expect(fs.existsSync(path.join(app.dir, 'profile\\resumes\\cv.pdf'))).toBe(false);
});

test('B6 symlink is refused by get, delete, getSingleton and putSingleton', () => {
  const dir = tmpDir();
  const app = tmpRepo('app', dir);
  app.put('point', sample.point({ id: 'real' }));
  const link = path.join(dir, 'profile/points/link.json');
  fs.symlinkSync('/nonexistent-target', link);
  expect(() => app.get('point', 'link')).toThrow(UnsafeNameError);
  expect(() => app.delete('point', 'link')).toThrow(UnsafeNameError);

  const lanesFile = path.join(dir, 'guide/lanes.json');
  fs.mkdirSync(path.dirname(lanesFile), { recursive: true });
  fs.writeFileSync(lanesFile, JSON.stringify({ lanes: [] }));
  fs.unlinkSync(lanesFile);
  fs.symlinkSync('/missing-lanes', lanesFile);
  expect(() => app.getSingleton('lanes')).toThrow(UnsafeNameError);
  expect(() => app.putSingleton('lanes', { lanes: [{ id: 'l', name: 'L' }] })).toThrow(UnsafeNameError);

  const { errors } = app.list('point');
  expect(errors.some((e) => path.basename(e.file) === 'link.json')).toBe(true);
});

test('B6b operations work when the repo dir does not exist yet', () => {
  const dir = path.join(tmpDir(), 'fresh-repo');
  const app = new DataRepo(dir, 'app');
  expect(() => app.put('point', sample.point({ id: 'fresh' }))).not.toThrow();
  expect(app.get('point', 'fresh')).not.toBeNull();
  expect(() => app.putSingleton('master', { file: 'cv.pdf' })).not.toThrow();
  expect(() => app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([9]))).not.toThrow();
  const before = new DataRepo(path.join(tmpDir(), 'read-only-new'), 'app');
  expect(before.readBlob('profile/resumes/nope.pdf')).toBeNull();
  expect(before.listBlobs('profile/resumes')).toEqual([]);
});

test('B7 list and listBlobs keep names that only contain .tmp- in the middle', () => {
  const app = tmpRepo('app');
  app.writeBlob('profile/resumes/resume.tmp-final.pdf', new Uint8Array([1]));
  expect(app.listBlobs('profile/resumes')).toContain('resume.tmp-final.pdf');
  app.put('point', sample.point({ id: 'draft.tmp-1' }));
  expect(app.list('point').items.map((p) => p.id)).toContain('draft.tmp-1');
});

test('B7 put replaces a read-only file via rename', () => {
  const app = tmpRepo('app');
  app.put('point', sample.point({ id: 'ro', text: 'before' }));
  const file = path.join(app.dir, 'profile/points/ro.json');
  fs.chmodSync(file, 0o444);
  expect(() => app.put('point', sample.point({ id: 'ro', text: 'after' }))).not.toThrow();
  expect(app.get('point', 'ro')?.text).toBe('after');
  fs.chmodSync(file, 0o644);
});

// ---------------------------------------------------------------------------------------------
// Path layer rows P1-P6. Tests whose name contains "[path.win32]" run the path layer under
// Windows path rules (backslash separators, drive letters) on whatever OS runs the suite.
// ---------------------------------------------------------------------------------------------

type FakeNode = { t: 'dir' } | { t: 'file' } | { t: 'link'; target: string };

/** An in-memory file system keyed by paths of one path implementation. Links are followed by `realpath` only. */
function fakeFs(api: PathApi) {
  const nodes = new Map<string, FakeNode>();
  const key = (p: string) => api.resolve(p);
  const add = (p: string, node: FakeNode) => {
    const abs = key(p);
    let up = api.dirname(abs);
    while (up !== api.dirname(up) && !nodes.has(up)) {
      nodes.set(up, { t: 'dir' });
      up = api.dirname(up);
    }
    nodes.set(up, nodes.get(up) ?? { t: 'dir' });
    nodes.set(abs, node);
  };
  const probe: GuardFs = {
    lstat(p) {
      const n = nodes.get(key(p));
      if (!n) return null;
      return { isSymbolicLink: () => n.t === 'link', isDirectory: () => n.t === 'dir', isFile: () => n.t === 'file' };
    },
    realpath(p) {
      const full = key(p);
      const top = api.parse(full).root;
      const parts = api.relative(top, full).split(api.sep).filter(Boolean);
      let cur = top;
      for (let hops = 0; parts.length > 0; ) {
        const part = parts.shift()!;
        const next = api.join(cur, part);
        const n = nodes.get(key(next));
        if (!n) return null;
        if (n.t === 'link') {
          if (++hops > 40) return null;
          const target = api.resolve(cur, n.target);
          const root = api.parse(target).root;
          cur = root;
          parts.unshift(...api.relative(root, target).split(api.sep).filter(Boolean));
        } else cur = next;
      }
      return cur;
    },
  };
  return {
    probe,
    dir: (p: string) => add(p, { t: 'dir' }),
    file: (p: string) => add(p, { t: 'file' }),
    link: (p: string, target: string) => add(p, { t: 'link', target }),
  };
}

const RULES: { name: string; api: PathApi; repo: string; outside: string }[] = [
  { name: 'path.win32', api: path.win32, repo: 'C:\\data\\repo', outside: 'C:\\data\\outside' },
  { name: 'path.posix', api: path.posix, repo: '/data/repo', outside: '/data/outside' },
];

for (const { name, api, repo, outside } of RULES) {
  const tag = `[${name}]`;
  const native = (...parts: string[]) => api.join(repo, ...parts);

  describe(`P1 ${tag} store-built paths work under these path rules`, () => {
    test(`P1 ${tag} every kind: <kind dir>/<id>.json resolves, for a missing repo dir, a missing kind dir and an existing record`, () => {
      for (const [kind, entry] of Object.entries(KINDS)) {
        const rel = recordRelPath(entry.dir, 'abc.def-1_2');
        expect(rel).not.toContain('\\');
        const expected = native(...entry.dir.split('/'), 'abc.def-1_2.json');

        expect(resolveRepoPath(api, fakeFs(api).probe, repo, rel), `${kind}, repo dir missing`).toBe(expected);

        const f = fakeFs(api);
        f.dir(repo);
        expect(resolveRepoPath(api, f.probe, repo, rel), `${kind}, kind dir missing`).toBe(expected);

        f.file(expected);
        expect(resolveRepoPath(api, f.probe, repo, rel), `${kind}, record exists`).toBe(expected);
        expect(() => assertEntryIsPlainFile(api, f.probe, expected, rel), kind).not.toThrow();

        const listed = fakeFs(api);
        listed.dir(native(...entry.dir.split('/')));
        expect(resolveRepoPath(api, listed.probe, repo, entry.dir, { allowExistingDirectory: true }), `${kind}, list dir`).toBe(
          native(...entry.dir.split('/')),
        );
      }
    });

    test(`P1 ${tag} every singleton path resolves`, () => {
      for (const [singleton, entry] of Object.entries(SINGLETONS)) {
        const f = fakeFs(api);
        f.file(native(...entry.path.split('/')));
        expect(resolveRepoPath(api, f.probe, repo, entry.path), singleton).toBe(native(...entry.path.split('/')));
      }
    });

    test(`P1 ${tag} a repo dir at the drive or file-system root, and one reached through a link, work`, () => {
      const rootDir = api.parse(repo).root;
      expect(resolveRepoPath(api, fakeFs(api).probe, rootDir, 'profile/points/a.json')).toBe(api.join(rootDir, 'profile', 'points', 'a.json'));

      const f = fakeFs(api);
      f.dir(outside);
      f.link(repo, outside); // the repo dir is a link to a real directory
      const real = api.join(api.dirname(repo), 'real-repo');
      f.dir(api.join(real, 'profile'));
      f.link(repo, real);
      expect(resolveRepoPath(api, f.probe, repo, 'profile/points/a.json')).toBe(native('profile', 'points', 'a.json'));
    });

    test(`P1 ${tag} a store-built path is never refused for its separators, with a caller path that has none`, () => {
      expect(() => assertRepoRelPath(api, recordRelPath('guide/log', '2026-11-11'))).not.toThrow();
      expect(() => assertRepoRelPath(api, 'profile/resumes/cv.pdf')).not.toThrow();
    });
  });

  describe(`P2 ${tag} caller-supplied blob paths`, () => {
    const refused = [
      'profile\\resumes\\cv.pdf',
      'profile\\resumes/cv.pdf',
      '..\\x.pdf',
      '../x.pdf',
      'profile/../../x.pdf',
      '/etc/passwd',
      `${repo.replace(/\\/g, '/')}/profile/resumes/cv.pdf`, // absolute, and inside the repo
      '//host/share/x.pdf',
      '\\\\host\\share\\x.pdf',
      '\\x.pdf',
      'C:x.pdf',
      'C:/x.pdf',
      'C:\\x.pdf',
      'c:x.pdf',
      '.git/config',
      '.GIT/config',
      'profile/.Git/config',
      '.git./config',
      '.git /config',
    ];
    test(`P2 ${tag} backslash, escape, absolute, drive, UNC and .git paths throw UnsafeNameError`, () => {
      const f = fakeFs(api);
      f.dir(repo);
      for (const rel of refused) {
        expect(() => resolveRepoPath(api, f.probe, repo, rel), rel).toThrow(UnsafeNameError);
        expect(() => resolveRepoPath(api, fakeFs(api).probe, repo, rel, { allowExistingDirectory: true }), `${rel} (no repo dir)`).toThrow(
          UnsafeNameError,
        );
      }
    });

    test(`P2 ${tag} plain repo-relative names pass`, () => {
      const f = fakeFs(api);
      f.dir(repo);
      for (const rel of ['profile/resumes/cv.pdf', 'profile/resumes/a b.pdf', 'profile/resume-text/cv.pdf.txt', 'profile/resumes/.hidden']) {
        expect(() => resolveRepoPath(api, f.probe, repo, rel), rel).not.toThrow();
      }
    });

    test(`P2 ${tag} an empty path is the repo root only when the caller allows it; '.' and './' never pass`, () => {
      const f = fakeFs(api);
      f.dir(repo);
      expect(() => resolveRepoPath(api, f.probe, repo, '')).toThrow(UnsafeNameError);
      expect(resolveRepoPath(api, f.probe, repo, '', { allowRepoRoot: true, allowExistingDirectory: true })).toBe(api.resolve(repo));
      for (const rel of ['.', './', 'profile/..']) {
        expect(() => resolveRepoPath(api, f.probe, repo, rel, { allowRepoRoot: true, allowExistingDirectory: true }), rel).toThrow(UnsafeNameError);
      }
    });
  });

  describe(`Q2 ${tag} names that Windows would normalise`, () => {
    const refusedNames = [
      '.. /x.pdf', 'profile/.. /x.pdf', 'profile/resumes/.. ', 'name. ', 'profile/resumes/cv.pdf.', 'profile/resumes/cv.pdf ', 'profile/resumes/a. .',
      'profile/.../x.pdf', 'profile/resumes/. ', 'profile/./resumes/cv.pdf', 'profile/../roles/x.json', 'profile//resumes/cv.pdf', 'profile/resumes/',
      'profile/resumes/CON', 'profile/resumes/con', 'profile/resumes/Con.txt', 'profile/resumes/PRN', 'profile/resumes/aux.tar.gz', 'profile/resumes/NUL',
      'profile/resumes/nul.', 'profile/resumes/COM1', 'profile/resumes/com9.pdf', 'profile/resumes/LPT1', 'profile/resumes/lpt9.x', 'profile/resumes/COM\u00b9',
      'GIT~1/config', 'git~1/config', 'Git~12/x', 'profile/GIT~1', 'GIT~1./x',
    ];
    test(`Q2 ${tag} trailing dots or spaces, empty, '.' and '..' segments, device names and GIT~n are refused`, () => {
      const f = fakeFs(api);
      f.dir(repo);
      for (const rel of refusedNames) {
        expect(() => resolveRepoPath(api, f.probe, repo, rel, { allowExistingDirectory: true }), rel).toThrow(UnsafeNameError);
        expect(() => resolveRepoPath(api, fakeFs(api).probe, repo, rel, { allowExistingDirectory: true }), `${rel} (no repo dir)`).toThrow(UnsafeNameError);
      }
    });

    test(`Q2 ${tag} names that look close but are fine pass`, () => {
      const f = fakeFs(api);
      f.dir(repo);
      for (const rel of ['profile/resumes/COM0', 'profile/resumes/COM10', 'profile/resumes/console.pdf', 'profile/resumes/connect', 'profile/resumes/git~', 'profile/resumes/git~a', 'profile/resumes/.hidden', 'profile/resumes/a.b.c', 'profile/resumes/..a', 'profile/resumes/a..b', 'profile/resumes/LPT0', 'profile/resumes/prn-1.pdf']) {
        expect(() => resolveRepoPath(api, f.probe, repo, rel), rel).not.toThrow();
      }
    });

    test(`Q3 ${tag} a regular file where a directory belongs is UnsafeNameError`, () => {
      const f = fakeFs(api);
      f.file(native('profile'));
      for (const rel of ['profile/points/x.json', 'profile/master.json', 'profile/resumes/cv.pdf']) {
        expect(() => resolveRepoPath(api, f.probe, repo, rel), rel).toThrow(UnsafeNameError);
      }
      expect(() => resolveRepoPath(api, f.probe, repo, 'profile/points', { allowExistingDirectory: true })).toThrow(UnsafeNameError);
    });
  });

  describe(`P3 ${tag} symbolic links`, () => {
    const cases: { label: string; build: (f: ReturnType<typeof fakeFs>) => void; rel: string; opts?: { allowExistingDirectory?: boolean } }[] = [
      { label: 'record file link', build: (f) => { f.file(`${outside}/real.json`); f.dir(native('profile/points')); f.link(native('profile/points/real.json'), `${outside}/real.json`); }, rel: 'profile/points/real.json' },
      { label: 'dangling record file link', build: (f) => { f.dir(native('profile/points')); f.link(native('profile/points/real.json'), `${outside}/gone.json`); }, rel: 'profile/points/real.json' },
      { label: 'kind dir link', build: (f) => { f.dir(`${outside}/points`); f.dir(native('profile')); f.link(native('profile/points'), `${outside}/points`); }, rel: 'profile/points/real.json' },
      { label: 'dangling kind dir link', build: (f) => { f.dir(native('profile')); f.link(native('profile/points'), `${outside}/gone`); }, rel: 'profile/points/real.json' },
      { label: 'kind dir link, listed as a directory', build: (f) => { f.dir(`${outside}/points`); f.dir(native('profile')); f.link(native('profile/points'), `${outside}/points`); }, rel: 'profile/points', opts: { allowExistingDirectory: true } },
      { label: 'dangling kind dir link, listed as a directory', build: (f) => { f.dir(native('profile')); f.link(native('profile/points'), `${outside}/gone`); }, rel: 'profile/points', opts: { allowExistingDirectory: true } },
      { label: 'link higher up (profile)', build: (f) => { f.dir(`${outside}/p`); f.dir(repo); f.link(native('profile'), `${outside}/p`); }, rel: 'profile/resumes/cv.pdf' },
      { label: 'link to a directory inside the repo', build: (f) => { f.dir(native('elsewhere')); f.dir(native('profile')); f.link(native('profile/points'), native('elsewhere')); }, rel: 'profile/points/real.json' },
      { label: 'link to a file inside the repo', build: (f) => { f.file(native('profile/master.json')); f.dir(native('profile/points')); f.link(native('profile/points/real.json'), native('profile/master.json')); }, rel: 'profile/points/real.json' },
    ];
    for (const c of cases) {
      test(`P3 ${tag} ${c.label} is refused`, () => {
        const f = fakeFs(api);
        f.dir(repo);
        c.build(f);
        expect(() => resolveRepoPath(api, f.probe, repo, c.rel, c.opts)).toThrow(UnsafeNameError);
      });
    }

    test(`P3 ${tag} a real path outside the repo is refused even when nothing on the way reports a link (junction, mount)`, () => {
      const f = fakeFs(api);
      f.dir(native('profile/points'));
      const probe: GuardFs = {
        lstat: f.probe.lstat,
        realpath: (p) => (api.resolve(p).startsWith(native('profile')) ? api.join(outside, 'elsewhere') : f.probe.realpath(p)),
      };
      expect(() => resolveRepoPath(api, probe, repo, 'profile/points/a.json')).toThrow(UnsafeNameError);
    });

    test(`P3 ${tag} a link inside a listed directory is refused entry by entry`, () => {
      const f = fakeFs(api);
      f.dir(native('profile/points'));
      f.file(native('profile/points/ok.json'));
      f.link(native('profile/points/l1.json'), `${outside}/x.json`);
      f.link(native('profile/points/l2.json'), native('profile/points/ok.json'));
      f.dir(native('profile/points/d.json'));
      expect(() => assertEntryIsPlainFile(api, f.probe, native('profile/points/ok.json'), 'profile/points/ok.json')).not.toThrow();
      for (const n of ['l1.json', 'l2.json', 'd.json']) {
        expect(() => assertEntryIsPlainFile(api, f.probe, native('profile/points', n), `profile/points/${n}`), n).toThrow(UnsafeNameError);
      }
    });
  });
}

describe('P2 [path.win32] colon names', () => {
  test('P2 [path.win32] a colon inside a name (an alternate data stream) is refused under Windows rules only', () => {
    expect(() => assertRepoRelPath(path.win32, 'profile/resumes/cv.pdf:stream')).toThrow(UnsafeNameError);
    expect(() => assertRepoRelPath(path.posix, 'profile/resumes/cv.pdf:stream')).not.toThrow();
  });
});

// ---- DataRepo on the real file system (this OS) ----

function linkTo(target: string, at: string, type: 'file' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, at, type === 'dir' ? 'junction' : 'file');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false; // Windows without link rights
    throw e;
  }
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.lstatSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'latin1');
    }
  };
  walk(dir);
  return out;
}

function bases() {
  const base = tmpDir();
  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  return { base, repo, outside, app: new DataRepo(repo, 'app') };
}

const OUTSIDE_POINT = () => `${JSON.stringify(sample.point({ id: 'real', text: 'FROM OUTSIDE' }))}\n`;

test('P2 caller blob paths with a backslash or an escape throw UnsafeNameError from all four blob methods, before ownership, on every OS', () => {
  const { base, app } = bases();
  const agent = new DataRepo(app.dir, 'agent');
  const refused = [
    'profile\\resumes\\cv.pdf',
    'profile\\resumes/cv.pdf',
    '..\\x.pdf',
    '../x.pdf',
    '/etc/passwd',
    '//host/share/x.pdf',
    '\\\\host\\share\\x.pdf',
    'C:x.pdf',
    'C:/x.pdf',
    'C:\\x.pdf',
    path.join('profile', 'resumes', 'cv.pdf').replace(/\//g, '\\'), // what path.join gives on Windows
    path.join(app.dir, 'profile', 'resumes', 'cv.pdf'), // absolute, and inside the repo
  ];
  for (const rel of refused) {
    for (const repo of [app, agent]) {
      expect(() => repo.writeBlob(rel, new Uint8Array([1])), `writeBlob ${rel}`).toThrow(UnsafeNameError);
      expect(() => repo.readBlob(rel), `readBlob ${rel}`).toThrow(UnsafeNameError);
      expect(() => repo.listBlobs(rel), `listBlobs ${rel}`).toThrow(UnsafeNameError);
      expect(() => repo.deleteBlob(rel), `deleteBlob ${rel}`).toThrow(UnsafeNameError);
    }
  }
  expect(fs.readdirSync(app.dir)).toEqual([]);
  expect(fs.readdirSync(base).sort()).toEqual(['outside', 'repo']);
});

test('P2 escapes are refused with UnsafeNameError even when the repo dir does not exist yet', () => {
  const dir = path.join(tmpDir(), 'not-yet');
  const app = new DataRepo(dir, 'app');
  expect(() => app.readBlob('../x')).toThrow(UnsafeNameError);
  expect(() => app.listBlobs('..')).toThrow(UnsafeNameError);
  expect(() => app.readBlob('.git/config')).toThrow(UnsafeNameError);
  expect(app.readBlob('profile/resumes/nope.pdf')).toBeNull();
  expect(app.listBlobs('profile/resumes')).toEqual([]);
  expect(fs.existsSync(dir)).toBe(false);
});

// P3: every method, every link shape, every position.
type LinkCase = {
  label: string;
  /** Builds the links; returns false when this OS cannot make them. */
  build: (repo: string, outside: string) => boolean;
};

const mk = (...p: string[]) => fs.mkdirSync(path.join(...p), { recursive: true });

const POINT_CASES: LinkCase[] = [
  { label: 'record file link to a readable record outside', build: (r, o) => { fs.writeFileSync(path.join(o, 'real.json'), OUTSIDE_POINT()); mk(r, 'profile/points'); return linkTo(path.join(o, 'real.json'), path.join(r, 'profile/points/real.json'), 'file'); } },
  { label: 'dangling record file link', build: (r, o) => { mk(r, 'profile/points'); return linkTo(path.join(o, 'gone.json'), path.join(r, 'profile/points/real.json'), 'file'); } },
  { label: 'kind dir link to a directory outside holding the record', build: (r, o) => { fs.writeFileSync(path.join(o, 'real.json'), OUTSIDE_POINT()); mk(r, 'profile'); return linkTo(o, path.join(r, 'profile/points'), 'dir'); } },
  { label: 'dangling kind dir link', build: (r, o) => { mk(r, 'profile'); return linkTo(path.join(o, 'gone'), path.join(r, 'profile/points'), 'dir'); } },
  { label: 'kind dir link to a directory inside the repo', build: (r) => { mk(r, 'elsewhere'); mk(r, 'profile'); return linkTo(path.join(r, 'elsewhere'), path.join(r, 'profile/points'), 'dir'); } },
  { label: 'link on a parent of the kind dir (profile)', build: (r, o) => { mk(o, 'points'); fs.writeFileSync(path.join(o, 'points/real.json'), OUTSIDE_POINT()); return linkTo(o, path.join(r, 'profile'), 'dir'); } },
];

for (const c of POINT_CASES) {
  test(`P3 ${c.label}: get, put, delete throw UnsafeNameError and list reports one error and returns no item`, (ctx) => {
    const { repo, outside, app } = bases();
    if (!c.build(repo, outside)) return ctx.skip();
    const before = snapshot(outside);
    const kindDirIsLink = fs.lstatSync(path.join(repo, 'profile/points'), { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    expect(() => app.get('point', 'real')).toThrow(UnsafeNameError);
    expect(() => app.put('point', sample.point({ id: 'real' }))).toThrow(UnsafeNameError);
    expect(() => app.delete('point', 'real')).toThrow(UnsafeNameError);
    const listed = app.list('point');
    expect(listed.items).toEqual([]);
    expect(listed.errors).toHaveLength(1);
    expect(listed.errors[0]!.error).not.toMatch(/ENOENT/);
    if (kindDirIsLink) expect(path.basename(listed.errors[0]!.file)).toBe('points');
    expect(snapshot(outside)).toEqual(before);
  });
}

test('P3 list: a link to a readable record outside is refused and the real records still load', (ctx) => {
  const { repo, outside, app } = bases();
  app.put('point', sample.point({ id: 'ok' }));
  fs.writeFileSync(path.join(outside, 'real.json'), OUTSIDE_POINT());
  fs.writeFileSync(path.join(outside, 'twin.json'), `${JSON.stringify(sample.point({ id: 'twin' }))}\n`);
  if (!linkTo(path.join(outside, 'real.json'), path.join(repo, 'profile/points/real.json'), 'file')) return ctx.skip();
  linkTo(path.join(outside, 'gone.json'), path.join(repo, 'profile/points/gone.json'), 'file');
  fs.mkdirSync(path.join(repo, 'profile/points/dir.json'));
  const { items, errors } = app.list('point');
  expect(items.map((p) => p.id)).toEqual(['ok']);
  expect(errors.map((e) => path.basename(e.file)).sort()).toEqual(['dir.json', 'gone.json', 'real.json']);
});

const SINGLETON_CASES: LinkCase[] = [
  { label: 'singleton file link to a readable file outside', build: (r, o) => { fs.writeFileSync(path.join(o, 'lanes.json'), '{"lanes":[]}\n'); mk(r, 'guide'); return linkTo(path.join(o, 'lanes.json'), path.join(r, 'guide/lanes.json'), 'file'); } },
  { label: 'dangling singleton file link', build: (r, o) => { mk(r, 'guide'); return linkTo(path.join(o, 'gone.json'), path.join(r, 'guide/lanes.json'), 'file'); } },
  { label: 'singleton parent dir link', build: (r, o) => { fs.writeFileSync(path.join(o, 'lanes.json'), '{"lanes":[]}\n'); return linkTo(o, path.join(r, 'guide'), 'dir'); } },
  { label: 'dangling singleton parent dir link', build: (r, o) => linkTo(path.join(o, 'gone'), path.join(r, 'guide'), 'dir') },
];

for (const c of SINGLETON_CASES) {
  test(`P3 ${c.label}: getSingleton and putSingleton throw UnsafeNameError, nothing outside changes`, (ctx) => {
    const { repo, outside, app } = bases();
    if (!c.build(repo, outside)) return ctx.skip();
    const before = snapshot(outside);
    expect(() => app.getSingleton('lanes')).toThrow(UnsafeNameError);
    expect(() => app.putSingleton('lanes', { lanes: [{ id: 'l', name: 'L' }] })).toThrow(UnsafeNameError);
    expect(snapshot(outside)).toEqual(before);
  });
}

const BLOB_CASES: LinkCase[] = [
  { label: 'resume file link', build: (r, o) => { fs.writeFileSync(path.join(o, 'cv.pdf'), 'SECRET'); mk(r, 'profile/resumes'); return linkTo(path.join(o, 'cv.pdf'), path.join(r, 'profile/resumes/cv.pdf'), 'file'); } },
  { label: 'dangling resume file link', build: (r, o) => { mk(r, 'profile/resumes'); return linkTo(path.join(o, 'gone.pdf'), path.join(r, 'profile/resumes/cv.pdf'), 'file'); } },
  { label: 'resume dir link', build: (r, o) => { fs.writeFileSync(path.join(o, 'cv.pdf'), 'SECRET'); mk(r, 'profile'); return linkTo(o, path.join(r, 'profile/resumes'), 'dir'); } },
  { label: 'dangling resume dir link', build: (r, o) => { mk(r, 'profile'); return linkTo(path.join(o, 'gone'), path.join(r, 'profile/resumes'), 'dir'); } },
];

for (const c of BLOB_CASES) {
  test(`P3 ${c.label}: writeBlob, readBlob and deleteBlob throw UnsafeNameError, nothing outside changes`, (ctx) => {
    const { repo, outside, app } = bases();
    if (!c.build(repo, outside)) return ctx.skip();
    const before = snapshot(outside);
    expect(() => app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([7]))).toThrow(UnsafeNameError);
    expect(() => app.readBlob('profile/resumes/cv.pdf')).toThrow(UnsafeNameError);
    expect(() => app.deleteBlob('profile/resumes/cv.pdf')).toThrow(UnsafeNameError);
    if (c.label.includes('dir link')) expect(() => app.listBlobs('profile/resumes')).toThrow(UnsafeNameError);
    expect(snapshot(outside)).toEqual(before);
  });
}

test('P3 a repo dir that is itself reached through a link still works', (ctx) => {
  const { base, repo } = bases();
  const alias = path.join(base, 'alias');
  if (!linkTo(repo, alias, 'dir')) return ctx.skip();
  const app = new DataRepo(alias, 'app');
  app.put('point', sample.point({ id: 'viaLink' }));
  app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1]));
  expect(app.get('point', 'viaLink')).not.toBeNull();
  expect(app.list('point').items).toHaveLength(1);
  expect(app.listBlobs('profile/resumes')).toEqual(['cv.pdf']);
  app.deleteBlob('profile/resumes/cv.pdf');
});

// P4: a write that fails after its temp file exists
test('P4 a failed rename removes the temp file and rethrows (a directory at the target name, which also fails for root)', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'target.json');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'child'), 'keeps the directory non-empty');
  expect(() => atomicWrite(target, 'data')).toThrow();
  expect(fs.readdirSync(dir)).toEqual(['target.json']);
  expect(() => atomicWrite(target, new Uint8Array([1, 2]))).toThrow();
  expect(fs.readdirSync(dir)).toEqual(['target.json']);
});

test('P4 a successful write leaves only the target, and the rethrown error is the original one', () => {
  const dir = tmpDir();
  atomicWrite(path.join(dir, 'a.json'), 'x');
  expect(fs.readdirSync(dir)).toEqual(['a.json']);
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('boom'), { code: 'EBOOM' });
  });
  try {
    expect(() => atomicWrite(path.join(dir, 'b.json'), 'y')).toThrow('boom');
  } finally {
    spy.mockRestore();
  }
  expect(fs.readdirSync(dir)).toEqual(['a.json']);
});

test('P4 put, putSingleton and writeBlob onto a directory are refused and leave no temp file', () => {
  const app = tmpRepo('app');
  fs.mkdirSync(path.join(app.dir, 'profile/points/dir.json'), { recursive: true });
  fs.mkdirSync(path.join(app.dir, 'profile/resumes/cv.pdf'), { recursive: true });
  fs.mkdirSync(path.join(app.dir, 'guide/lanes.json'), { recursive: true });
  expect(() => app.put('point', sample.point({ id: 'dir' }))).toThrow(UnsafeNameError);
  expect(() => app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1]))).toThrow(UnsafeNameError);
  expect(() => app.putSingleton('lanes', { lanes: [] })).toThrow(UnsafeNameError);
  for (const d of ['profile/points', 'profile/resumes', 'guide']) {
    expect(fs.readdirSync(path.join(app.dir, d)).filter((n) => /\.tmp-[0-9a-f]{6}$/.test(n))).toEqual([]);
  }
});

// P6: list does one check per entry, not a walk from the repo dir
test('P6 list over many records makes about one lstat per record', () => {
  const app = tmpRepo('app');
  const n = 200;
  for (let i = 0; i < n; i++) app.put('point', sample.point({ id: `p${String(i).padStart(4, '0')}` }));
  const spy = vi.spyOn(fs, 'lstatSync');
  try {
    const { items, errors } = app.list('point');
    expect(items).toHaveLength(n);
    expect(errors).toEqual([]);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(n + 10);
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------------------------
// Fix 1 rows Q1-Q6
// ---------------------------------------------------------------------------------------------

const REPO_URL = pathToFileURL(path.join(import.meta.dirname, '../src/repo.ts')).href;

/** Runs `body` in a child node process with a time limit, because a read of a FIFO cannot be interrupted in-process. */
function inChild(body: string): { out: string; timedOut: boolean } {
  const script = `import { DataRepo } from ${JSON.stringify(REPO_URL)};\nconst show = (f) => { try { const r = f(); return r === undefined ? 'ok' : JSON.stringify(r); } catch (e) { return e.name; } };\n${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 8000, encoding: 'utf8' });
  return { out: `${r.stdout}${r.stderr}`.trim(), timedOut: r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' };
}

function mkfifo(at: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('mkfifo', [at]);
    return true;
  } catch {
    return false;
  }
}

test('Q1 a cob.json that is a link (to a file, to a directory, or dangling) makes new DataRepo throw UnsafeNameError before any read', (ctx) => {
  const { repo, outside } = bases();
  const v7 = path.join(outside, 'meta.json');
  fs.writeFileSync(v7, JSON.stringify({ schemaVersion: 7, createdAt: T0 }));
  fs.mkdirSync(path.join(outside, 'dir'));
  const cases: [string, string, 'file' | 'dir'][] = [
    ['file link to a version 7 file', v7, 'file'],
    ['file link to a valid version 1 file', v7, 'file'],
    ['directory link', path.join(outside, 'dir'), 'dir'],
    ['dangling file link', path.join(outside, 'gone.json'), 'file'],
    ['dangling directory link', path.join(outside, 'gone'), 'dir'],
  ];
  for (const [label, target, type] of cases) {
    if (label.includes('valid version 1')) fs.writeFileSync(v7, JSON.stringify({ schemaVersion: 1, createdAt: T0 }));
    const at = path.join(repo, 'cob.json');
    fs.rmSync(at, { force: true });
    if (!linkTo(target, at, type)) return ctx.skip();
    expect(() => new DataRepo(repo, 'app'), label).toThrow(UnsafeNameError);
  }
});

test('Q1 a cob.json that is a directory makes new DataRepo throw UnsafeNameError', () => {
  const { repo } = bases();
  fs.mkdirSync(path.join(repo, 'cob.json'));
  expect(() => new DataRepo(repo, 'app')).toThrow(UnsafeNameError);
});

test('Q1 a cob.json that is a FIFO makes new DataRepo throw UnsafeNameError and never block', (ctx) => {
  const { repo } = bases();
  if (!mkfifo(path.join(repo, 'cob.json'))) return ctx.skip();
  const r = inChild(`console.log(show(() => new DataRepo(${JSON.stringify(repo)}, 'app')));`);
  expect(r.timedOut).toBe(false);
  expect(r.out).toBe('UnsafeNameError');
});

test('Q1 a FIFO at a record, singleton or blob path is refused by every read and never blocks', (ctx) => {
  const { repo } = bases();
  for (const d of ['profile/points', 'profile', 'profile/resumes']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  if (!mkfifo(path.join(repo, 'profile/points/f.json'))) return ctx.skip();
  mkfifo(path.join(repo, 'profile/master.json'));
  mkfifo(path.join(repo, 'profile/resumes/cv.pdf'));
  const r = inChild(`const app = new DataRepo(${JSON.stringify(repo)}, 'app');
console.log(JSON.stringify([
  show(() => app.get('point', 'f')),
  show(() => app.getSingleton('master')),
  show(() => app.readBlob('profile/resumes/cv.pdf')),
  show(() => { const l = app.list('point'); return [l.items.length, l.errors.length]; }),
]));`);
  expect(r.timedOut).toBe(false);
  expect(JSON.parse(r.out)).toEqual(['UnsafeNameError', 'UnsafeNameError', 'UnsafeNameError', '[0,1]']);
});

test('Q2 caller blob paths with a Windows-normalised segment are refused by all four blob methods, for both writers, on every OS', () => {
  const { base, app } = bases();
  const agent = new DataRepo(app.dir, 'agent');
  const refused = ['profile/resumes/.. ', 'profile/resumes/cv.pdf.', 'profile/resumes/cv.pdf ', '.. /x.pdf', 'profile/.../x.pdf', 'profile/resumes/CON', 'profile/resumes/nul.txt', 'profile/resumes/Com3', 'profile/resumes/LPT9.pdf', 'GIT~1/config', 'git~2'];
  for (const rel of refused) {
    for (const repo of [app, agent]) {
      expect(() => repo.writeBlob(rel, new Uint8Array([1])), `writeBlob ${rel}`).toThrow(UnsafeNameError);
      expect(() => repo.readBlob(rel), `readBlob ${rel}`).toThrow(UnsafeNameError);
      expect(() => repo.listBlobs(rel), `listBlobs ${rel}`).toThrow(UnsafeNameError);
      expect(() => repo.deleteBlob(rel), `deleteBlob ${rel}`).toThrow(UnsafeNameError);
    }
  }
  expect(fs.readdirSync(app.dir)).toEqual([]);
  expect(fs.readdirSync(base).sort()).toEqual(['outside', 'repo']);
});

test('Q2 record ids that are device names are refused by get, put and delete, and a hand-made file with such a name is reported by list', () => {
  const app = tmpRepo('app');
  for (const id of ['con', 'NUL', 'aux', 'com1', 'lpt9']) {
    expect(() => app.get('point', id), id).toThrow(UnsafeNameError);
    expect(() => app.put('point', sample.point({ id })), id).toThrow(UnsafeNameError);
    expect(() => app.delete('point', id), id).toThrow(UnsafeNameError);
  }
  fs.mkdirSync(path.join(app.dir, 'profile/points'), { recursive: true });
  fs.writeFileSync(path.join(app.dir, 'profile/points/con.json'), `${JSON.stringify(sample.point({ id: 'con' }))}\n`);
  app.put('point', sample.point({ id: 'fine' }));
  const { items, errors } = app.list('point');
  expect(items.map((p) => p.id)).toEqual(['fine']);
  expect(errors.map((e) => path.basename(e.file))).toEqual(['con.json']);
});

test('Q3 a regular file where a directory belongs is UnsafeNameError from every method, with no raw ENOTDIR or EEXIST', () => {
  const { repo, app } = bases();
  fs.writeFileSync(path.join(repo, 'profile'), 'a file where a directory belongs');
  expect(() => app.get('point', 'x')).toThrow(UnsafeNameError);
  expect(() => app.put('point', sample.point({ id: 'x' }))).toThrow(UnsafeNameError);
  expect(() => app.delete('point', 'x')).toThrow(UnsafeNameError);
  expect(() => app.getSingleton('master')).toThrow(UnsafeNameError);
  expect(() => app.putSingleton('master', { file: 'cv.pdf' })).toThrow(UnsafeNameError);
  expect(() => app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1]))).toThrow(UnsafeNameError);
  expect(() => app.readBlob('profile/resumes/cv.pdf')).toThrow(UnsafeNameError);
  expect(() => app.listBlobs('profile/resumes')).toThrow(UnsafeNameError);
  expect(() => app.deleteBlob('profile/resumes/cv.pdf')).toThrow(UnsafeNameError);
  const { items, errors } = app.list('point');
  expect(items).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(fs.readFileSync(path.join(repo, 'profile'), 'utf8')).toBe('a file where a directory belongs');
  expect(fs.readdirSync(repo)).toEqual(['profile']);
});

test('Q3 a regular file at a deeper level (the kind dir) is UnsafeNameError from put and writeBlob, and leaves no temp file', () => {
  const { repo, app } = bases();
  fs.mkdirSync(path.join(repo, 'profile'));
  fs.writeFileSync(path.join(repo, 'profile/points'), 'file');
  fs.writeFileSync(path.join(repo, 'profile/resumes'), 'file');
  expect(() => app.put('point', sample.point({ id: 'x' }))).toThrow(UnsafeNameError);
  expect(() => app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1]))).toThrow(UnsafeNameError);
  expect(fs.readdirSync(path.join(repo, 'profile')).sort()).toEqual(['points', 'resumes']);
});

test('Q5 list reports a record whose key is not a safe id in errors and does not return it', () => {
  const app = tmpRepo('app');
  app.put('point', sample.point({ id: 'good' }));
  const d = path.join(app.dir, 'profile/points');
  const bad = ['my point', 'a\\b', '..', 'x:y', 'é', 'a/b'];
  const names: string[] = [];
  for (const id of bad) {
    const name = `${id.replace(/\//g, '_')}.json`;
    if (name.includes('/')) continue;
    names.push(name);
    fs.writeFileSync(path.join(d, name), `${JSON.stringify(sample.point({ id }))}\n`);
  }
  const { items, errors } = app.list('point');
  expect(items.map((p) => p.id)).toEqual(['good']);
  expect(errors.map((e) => path.basename(e.file)).sort()).toEqual([...names].sort());
});

test('Q5 a queued command with an unsafe id is reported and never reaches queuedCommands', () => {
  const { app, agent } = pair();
  const ok = sample.command({ id: '20261111T090000000Z-aaaaaa' });
  app.put('command', ok);
  const dir = path.join(app.dir, 'commands');
  fs.writeFileSync(path.join(dir, 'bad id.json'), `${JSON.stringify(sample.command({ id: 'bad id', createdAt: '2020-01-01T00:00:00.000Z' }))}\n`);
  expect(queuedCommands(agent).map((c) => c.id)).toEqual([ok.id]);
  const { items, errors } = agent.list('command');
  expect(items.map((c) => c.id)).toEqual([ok.id]);
  expect(errors.map((e) => path.basename(e.file))).toEqual(['bad id.json']);
});

test('Q6 a nested blob name is refused, in both resume folders', () => {
  const app = tmpRepo('app');
  expect(() => app.writeBlob('profile/resumes/a/b.pdf', new Uint8Array([1]))).toThrow(OwnershipError);
  expect(() => app.writeBlob('profile/resume-text/a/b.txt', new Uint8Array([1]))).toThrow(OwnershipError);
  expect(() => app.deleteBlob('profile/resumes/a/b.pdf')).toThrow(OwnershipError);
  expect(fs.existsSync(path.join(app.dir, 'profile/resumes'))).toBe(false);
});

test('Q6 the app can write, read, list and delete profile/resume-text/<name>; the agent cannot', () => {
  const app = tmpRepo('app');
  const agent = new DataRepo(app.dir, 'agent');
  app.writeBlob('profile/resume-text/cv.pdf.txt', new TextEncoder().encode('text'));
  expect(app.readBlob('profile/resume-text/cv.pdf.txt')?.toString()).toBe('text');
  expect(agent.listBlobs('profile/resume-text')).toEqual(['cv.pdf.txt']);
  expect(() => agent.writeBlob('profile/resume-text/other.txt', new Uint8Array([1]))).toThrow(OwnershipError);
  expect(() => agent.deleteBlob('profile/resume-text/cv.pdf.txt')).toThrow(OwnershipError);
  app.deleteBlob('profile/resume-text/cv.pdf.txt');
  expect(app.listBlobs('profile/resume-text')).toEqual([]);
});

test('Q6 the id and file-name comparison is exact and case-sensitive', () => {
  const app = tmpRepo('app');
  const d = path.join(app.dir, 'profile/points');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'P1.json'), `${JSON.stringify(sample.point({ id: 'p1' }))}\n`);
  const { items, errors } = app.list('point');
  expect(items).toEqual([]);
  expect(errors.map((e) => path.basename(e.file))).toEqual(['P1.json']);
  expect(errors[0]!.error).toMatch(/does not match/);
  expect(() => app.get('point', 'P1')).toThrow(/does not match/);
});

test('Q6 only names ending in .tmp- plus exactly six hex digits are hidden (5 and 7 digits are listed)', () => {
  const app = tmpRepo('app');
  const d = path.join(app.dir, 'profile/resumes');
  fs.mkdirSync(d, { recursive: true });
  for (const n of ['cv.pdf.tmp-abcde', 'cv.pdf.tmp-abcdef0', 'cv.pdf.tmp-abcdef', 'cv.pdf.tmp-ABCDEF', 'cv.pdf.tmp-abcdeg']) fs.writeFileSync(path.join(d, n), 'x');
  expect(app.listBlobs('profile/resumes').sort()).toEqual(['cv.pdf.tmp-ABCDEF', 'cv.pdf.tmp-abcde', 'cv.pdf.tmp-abcdeg', 'cv.pdf.tmp-abcdef0'].sort());
});

// Q4: DataRepo itself, with node:path replaced by path.win32 and node:fs by a wrapper that maps C:\data\repo onto a temp dir.
describe('Q4 [path.win32] DataRepo itself under Windows path rules', () => {
  async function loadUnderWin32() {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    const tmp = real.realpathSync(tmpDir());
    const WROOT = 'C:\\data\\repo';
    const toReal = (p: unknown): unknown =>
      typeof p === 'string' && p.toLowerCase().startsWith(WROOT.toLowerCase()) ? path.join(tmp, ...p.slice(WROOT.length).split('\\').filter(Boolean)) : p;
    const toWin = (p: string): string => (p === tmp ? WROOT : p.startsWith(`${tmp}/`) ? WROOT + p.slice(tmp.length).replace(/\//g, '\\') : p);
    const one = (name: string) => (p: unknown, ...rest: unknown[]) => (real as any)[name](toReal(p), ...rest);
    const fsShim = {
      lstatSync: one('lstatSync'),
      statSync: one('statSync'),
      existsSync: one('existsSync'),
      readFileSync: one('readFileSync'),
      writeFileSync: one('writeFileSync'),
      mkdirSync: one('mkdirSync'),
      readdirSync: one('readdirSync'),
      unlinkSync: one('unlinkSync'),
      rmSync: one('rmSync'),
      renameSync: (a: unknown, b: unknown) => real.renameSync(toReal(a) as string, toReal(b) as string),
      openSync: one('openSync'),
      fsyncSync: real.fsyncSync,
      closeSync: real.closeSync,
      realpathSync: Object.assign((p: unknown, ...r: unknown[]) => toWin((real as any).realpathSync(toReal(p), ...r)), {
        native: (p: unknown, ...r: unknown[]) => toWin((real as any).realpathSync.native(toReal(p), ...r)),
      }),
    };
    vi.resetModules();
    vi.doMock('node:path', () => ({ default: path.win32, ...path.win32 }));
    vi.doMock('node:fs', () => ({ default: fsShim, ...fsShim }));
    const repoMod = await import('../src/repo.ts');
    const commandsMod = await import('../src/commands.ts');
    return { tmp, WROOT, repoMod, commandsMod };
  }
  const unload = () => {
    vi.doUnmock('node:path');
    vi.doUnmock('node:fs');
    vi.resetModules();
  };

  test('Q4 [path.win32] get, put, list, delete, putSingleton, createCommand and the blob methods work, and files land where expected', async () => {
    const { tmp, WROOT, repoMod, commandsMod } = await loadUnderWin32();
    try {
      const { DataRepo: Repo } = repoMod;
      const app = new Repo(WROOT, 'app');
      const agent = new Repo(WROOT, 'agent');

      app.put('point', sample.point({ id: 'p1' }));
      expect(fs.existsSync(path.join(tmp, 'profile/points/p1.json'))).toBe(true);
      expect(app.get('point', 'p1')).toEqual(sample.point({ id: 'p1' }));
      expect(app.list('point').items.map((p) => p.id)).toEqual(['p1']);
      expect(app.get('point', 'missing')).toBeNull();

      // Proof that repo.ts really ran with Windows rules: its own paths in error entries use backslashes.
      fs.writeFileSync(path.join(tmp, 'profile/points/bad.json'), '{not json');
      expect(app.list('point').errors.map((e) => e.file)).toEqual([`${WROOT}\\profile\\points\\bad.json`]);

      agent.put('role', sample.role({ id: 'r1' }));
      expect(fs.existsSync(path.join(tmp, 'roles/r1.json'))).toBe(true);
      expect(agent.list('role').items).toHaveLength(1);

      app.putSingleton('lanes', { lanes: [{ id: 'l', name: 'L' }] });
      expect(app.getSingleton('lanes')).toEqual({ lanes: [{ id: 'l', name: 'L' }] });
      expect(fs.existsSync(path.join(tmp, 'guide/lanes.json'))).toBe(true);

      const cmd = commandsMod.createCommand(app, { verb: 'run_role', target: null, payload: { role: 'finder' } });
      expect(fs.existsSync(path.join(tmp, 'commands', `${cmd.id}.json`))).toBe(true);
      expect(commandsMod.queuedCommands(agent).map((c) => c.id)).toEqual([cmd.id]);
      commandsMod.finishCommand(agent, cmd.id, 'done', 'ok');
      expect(commandsMod.queuedCommands(agent)).toEqual([]);

      app.writeBlob('profile/resumes/cv.pdf', new Uint8Array([1, 2]));
      expect(app.readBlob('profile/resumes/cv.pdf')?.length).toBe(2);
      expect(app.listBlobs('profile/resumes')).toEqual(['cv.pdf']);
      // A caller that builds its blob path with path.join gets backslashes, and is refused (contract: `/`).
      expect(() => app.writeBlob(path.win32.join('profile', 'resumes', 'x.pdf'), new Uint8Array([1]))).toThrow(/unsafe repo path/);
      app.deleteBlob('profile/resumes/cv.pdf');

      app.delete('point', 'p1');
      expect(fs.existsSync(path.join(tmp, 'profile/points/p1.json'))).toBe(false);
      expect(fs.readdirSync(path.join(tmp, 'profile/points')).filter((n) => /\.tmp-/.test(n))).toEqual([]);
    } finally {
      unload();
    }
  });

  test('Q4 [path.win32] links and escapes are still refused, and the repo dir may be at a drive root of the shim', async () => {
    const { tmp, WROOT, repoMod } = await loadUnderWin32();
    try {
      const app = new repoMod.DataRepo(WROOT, 'app');
      const outside = tmpDir();
      fs.mkdirSync(path.join(tmp, 'profile'), { recursive: true });
      if (linkTo(outside, path.join(tmp, 'profile/points'), 'dir')) {
        expect(() => app.put('point', sample.point({ id: 'x' }))).toThrow(/symbolic link/);
        expect(app.list('point').errors).toHaveLength(1);
        expect(fs.readdirSync(outside)).toEqual([]);
      }
      expect(() => app.readBlob('..\\x')).toThrow(/unsafe repo path/);
      expect(() => app.readBlob('C:/x')).toThrow(/escapes repo/);
    } finally {
      unload();
    }
  });
});
