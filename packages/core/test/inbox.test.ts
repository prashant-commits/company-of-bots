import { beforeEach, describe, expect, test } from 'vitest';
import { BUTTONS, inboxRows, type Button, type RowType } from '../src/inbox.ts';
import { createCommand } from '../src/commands.ts';
import { processQueue } from '../src/process.ts';
import { DataRepo } from '../src/repo.ts';
import type { Application, Park } from '../src/schema.ts';
import { pair } from './helpers.ts';

let app: DataRepo;
let agent: DataRepo;
let seedPark: (id: string, park: Omit<Park, 'at'> | Park, extra?: Partial<Application>) => Application;
let seedInterruptedSubmit: (pointId?: string) => Application;

beforeEach(() => {
  ({ app, agent, seedPark, seedInterruptedSubmit } = pair());
});

describe('inbox', () => {
  test.each(Object.entries(BUTTONS))('%s row shows exactly its buttons', (rowType, buttons) => {
    let p: Application;
    if (rowType === 'code_waiting') {
      p = seedPark('c-wait', { type: 'code' });
      const rows = inboxRows(agent, { waitingCodes: new Set([p.id]) });
      expect(rows[0]!.rowType).toBe('code_waiting');
      expect(rows[0]!.buttons).toEqual(buttons);
    } else if (rowType === 'code_closed') {
      p = seedPark('c-close', { type: 'code' });
      const rows = inboxRows(agent);
      expect(rows[0]!.rowType).toBe('code_closed');
      expect(rows[0]!.buttons).toEqual(buttons);
    } else if (rowType === 'error_after_submit') {
      p = seedPark('e-after', { type: 'error', afterSubmit: true });
      const rows = inboxRows(agent);
      expect(rows[0]!.rowType).toBe('error_after_submit');
      expect(rows[0]!.buttons).toEqual(buttons);
    } else {
      p = seedPark(`row-${rowType}`, { type: rowType as any });
      const rows = inboxRows(agent);
      expect(rows[0]!.rowType).toBe(rowType);
      expect(rows[0]!.buttons).toEqual(buttons);
    }
  });

  test('a code row has a paste box only while the agent is waiting', () => {
    seedPark('c1', { type: 'code', site: 'jobs.example.com' });
    expect(inboxRows(agent)[0]!.rowType).toBe('code_closed');
    expect(inboxRows(agent, { waitingCodes: new Set(['c1']) })[0]!.rowType).toBe('code_waiting');
  });

  test('20.9 a captcha row offers Done and Drop and carries no image', () => {
    seedPark('k', { type: 'captcha' });
    const row = inboxRows(agent)[0]!;
    expect(row.buttons).toEqual(expect.arrayContaining(['done', 'drop']));
    expect(Object.keys(row)).not.toContain('image');
  });

  test('20.11 an email-only role is a human row with its contact', () => {
    seedPark('h', { type: 'human', contact: 'jobs@example.com' });
    expect(inboxRows(agent)[0]).toMatchObject({ rowType: 'human', contact: 'jobs@example.com' });
  });

  test('20.20 errors before and after the click are different rows', () => {
    seedPark('e1', { type: 'error', note: 'Upload failed' });
    seedPark('e2', { type: 'error', afterSubmit: true, note: 'Error page after submit' });
    const rows = Object.fromEntries(inboxRows(agent).map((r) => [r.applicationId, r]));
    expect(rows.e1).toMatchObject({ rowType: 'error', note: 'Upload failed' });
    expect(rows.e2).toMatchObject({ rowType: 'error_after_submit', note: 'Error page after submit' });
  });

  test('closed applications leave the inbox; a queued drop shows as pending', () => {
    seedPark('d', { type: 'captcha' });
    seedPark('q', { type: 'captcha' });
    createCommand(app, { verb: 'done', target: 'd', payload: {} });
    processQueue(agent);
    createCommand(app, { verb: 'drop', target: 'q', payload: {} });
    expect(inboxRows(agent).map((r) => [r.applicationId, r.pending])).toEqual([['q', 'drop']]);
  });

  test('20.7 Done on a captcha row creates no transcript', () => {
    seedPark('k', { type: 'captcha' });
    createCommand(app, { verb: 'done', target: 'k', payload: {} });
    processQueue(agent);
    expect(app.list('transcript').items).toEqual([]);
    expect(agent.get('application', 'k')!.state).toBe('done');
  });

  // B16: newest parkedAt first and copying optional fields
  test('B16 inboxRows sorts newest parkedAt first and copies fields/site/note/contact', () => {
    seedPark('old', {
      type: 'missing_answer',
      at: '2026-11-10T10:00:00.000Z',
      fields: ['Salary expectations', 'Notice period'],
      site: 'site.example.com',
    });
    seedPark('new', {
      type: 'sign_in',
      at: '2026-11-12T10:00:00.000Z',
      site: 'signin.example.com',
      note: 'Need login',
    });
    const rows = inboxRows(agent);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.applicationId).toBe('new');
    expect(rows[0]!.site).toBe('signin.example.com');
    expect(rows[0]!.note).toBe('Need login');
    expect(rows[1]!.applicationId).toBe('old');
    expect(rows[1]!.fields).toEqual(['Salary expectations', 'Notice period']);
    expect(rows[1]!.site).toBe('site.example.com');
  });
});
