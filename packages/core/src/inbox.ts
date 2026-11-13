import type { DataRepo } from './repo.ts';
import { queuedCommands } from './commands.ts';
import type { Command } from './schema.ts';

export type RowType =
  | 'missing_answer'
  | 'sign_in'
  | 'code_waiting'
  | 'code_closed'
  | 'verify'
  | 'captcha'
  | 'human'
  | 'error'
  | 'error_after_submit';

export type Button =
  | 'connect'
  | 'paste_code'
  | 'run_now'
  | 'verified'
  | 'done'
  | 'status'
  | 'retry'
  | 'drop';

export const BUTTONS: Record<RowType, Button[]> = {
  missing_answer: ['status', 'retry', 'drop'],
  sign_in: ['connect', 'status', 'retry', 'drop'],
  code_waiting: ['paste_code', 'status', 'retry', 'drop'],
  code_closed: ['run_now', 'status', 'retry', 'drop'],
  verify: ['verified', 'status', 'retry', 'drop'],
  captcha: ['done', 'status', 'retry', 'drop'],
  human: ['done', 'status', 'retry', 'drop'],
  error: ['done', 'status', 'retry', 'drop'],
  error_after_submit: ['done', 'status', 'retry', 'drop'],
};

export type InboxRow = {
  applicationId: string;
  rowType: RowType;
  organization: string;
  title: string;
  link: string;
  parkedAt: string;
  site?: string;
  fields?: string[];
  contact?: string;
  note?: string;
  buttons: Button[];
  pending: Command['verb'] | null;
};

export function inboxRows(
  repo: DataRepo,
  live?: { waitingCodes: ReadonlySet<string> },
): InboxRow[] {
  const { items } = repo.list('application');
  const queued = queuedCommands(repo);

  const parked = items.filter((app) => app.state === 'parked' && app.park !== null);

  parked.sort((a, b) => {
    const aAt = a.park!.at;
    const bAt = b.park!.at;
    if (aAt !== bAt) return bAt < aAt ? -1 : 1;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });

  const rows: InboxRow[] = [];

  for (const app of parked) {
    const park = app.park!;
    let rowType: RowType;

    if (park.type === 'code') {
      rowType = live?.waitingCodes?.has(app.id) ? 'code_waiting' : 'code_closed';
    } else if (park.type === 'error' && park.afterSubmit) {
      rowType = 'error_after_submit';
    } else {
      rowType = park.type as RowType;
    }

    const targeting = queued.filter((c) => c.target === app.id);
    let pending: Command['verb'] | null = null;
    if (targeting.length > 0) {
      pending = targeting[targeting.length - 1]!.verb;
    }

    const row: InboxRow = {
      applicationId: app.id,
      rowType,
      organization: app.organization,
      title: app.title,
      link: app.link,
      parkedAt: park.at,
      buttons: [...BUTTONS[rowType]],
      pending,
    };

    if (park.site !== undefined) row.site = park.site;
    if (park.fields !== undefined) row.fields = park.fields;
    if (park.contact !== undefined) row.contact = park.contact;
    if (park.note !== undefined) row.note = park.note;

    rows.push(row);
  }

  return rows;
}
