import { expect, test } from 'vitest';
import { assertSafeId, newId, roleIdFor, safeFileName, UnsafeNameError } from '../src/ids.ts';

test('newId sorts by creation time and has a fixed shape', () => {
  const a = newId(new Date('2026-11-11T09:00:00.000Z'));
  const b = newId(new Date('2026-11-11T09:00:00.001Z'));
  expect(a < b).toBe(true);
  expect(a).toMatch(/^20261111T090000000Z-[0-9a-f]{6}$/);
});
test('roleIdFor ignores tracking params, hash, trailing slash and host case', () => {
  const base = roleIdFor('https://careers.example.com/jobs/42');
  expect(roleIdFor('https://Careers.Example.com/jobs/42/?utm_source=x&gclid=1&fbclid=2&ref=feed#apply')).toBe(base);
  expect(roleIdFor('https://careers.example.com/jobs/43')).not.toBe(base);
  expect(roleIdFor('https://x.example/job?id=1')).not.toBe(roleIdFor('https://x.example/job?id=2'));
  expect(roleIdFor('https://x.example/job?b=2&a=1')).toBe(roleIdFor('https://x.example/job?a=1&b=2'));
  expect(base).toMatch(/^r-[0-9a-f]{16}$/);
});
test('safeFileName keeps the base name and strips traversal and leading dots', () => {
  expect(safeFileName('../../x.pdf')).toBe('x.pdf');
  expect(safeFileName('C:\\Users\\me\\My Résumé.pdf')).toBe('My Résumé.pdf');
  expect(safeFileName('.gitignore')).toBe('gitignore');
  expect(() => safeFileName('..')).toThrow(UnsafeNameError);
  expect(() => safeFileName('   ')).toThrow(UnsafeNameError);
});
test('assertSafeId accepts record ids and rejects paths', () => {
  expect(() => assertSafeId('20261111T090000000Z-a1b2c3')).not.toThrow();
  expect(() => assertSafeId('../x')).toThrow(UnsafeNameError);
  expect(() => assertSafeId('a/b')).toThrow(UnsafeNameError);
});

test('safeFileName output is one segment that is safe on Windows, macOS and Linux (B9)', () => {
  expect(safeFileName('C:evil.pdf')).toBe('C_evil.pdf');
  expect(safeFileName('Resume: 2026.pdf')).toBe('Resume_ 2026.pdf');
  expect(safeFileName('a<b>c"d|e?f*g.pdf')).toBe('a_b_c_d_e_f_g.pdf');
  expect(safeFileName('report.pdf.')).toBe('report.pdf');
  expect(safeFileName('report.pdf. . ')).toBe('report.pdf');
  expect(safeFileName('CON.pdf')).toBe('_CON.pdf');
  expect(safeFileName('nul')).toBe('_nul');
  expect(safeFileName('Com1.txt')).toBe('_Com1.txt');
  expect(safeFileName('lpt9')).toBe('_lpt9');
  expect(safeFileName('console.pdf')).toBe('console.pdf');
  expect(safeFileName('a\u0000b.pdf')).toBe('a_b.pdf');
  expect(safeFileName('a\u001fb.pdf')).toBe('a_b.pdf');
  expect(safeFileName('My Résumé.pdf')).toBe('My Résumé.pdf');
  expect(() => safeFileName('...')).toThrow(UnsafeNameError);
  expect(() => safeFileName('. . .')).toThrow(UnsafeNameError);
});
test('roleIdFor ignores tracking parameter names in any letter case', () => {
  const base = roleIdFor('https://careers.example.com/jobs/42');
  for (const q of ['UTM_source=x', 'Gclid=1', 'FBCLID=2', 'Ref=feed', 'utm_medium=email', 'utm_campaign=x']) {
    expect(roleIdFor(`https://careers.example.com/jobs/42?${q}`)).toBe(base);
  }
  expect(roleIdFor('https://careers.example.com/jobs/42?id=1')).not.toBe(base);
});
test('assertSafeId rejects . and ..', () => {
  expect(() => assertSafeId('.')).toThrow(UnsafeNameError);
  expect(() => assertSafeId('..')).toThrow(UnsafeNameError);
});
