import path from 'node:path';
import { z } from 'zod';
import type { DataRepo } from './repo.ts';
import { OwnershipError } from './repo.ts';
import { isSendable } from './confidence.ts';
import { newId, roleIdFor } from './ids.ts';
import { httpUrlProblem, isSafeId } from './names.ts';
import {
  ApplyPathSchema,
  ParkTypeSchema,
  type Application,
  type ApplyPath,
  type OpenRole,
  type ParkType,
  type Point,
  type PointRef,
} from './schema.ts';

export class UnsendablePointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsendablePointError';
  }
}

export class ApplicationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationStateError';
  }
}

export type ApplicationInput = {
  roleId?: string;
  organization: string;
  title: string;
  link: string;
  sourceId?: string;
};

/** What the agent says about a park. Core adds `at`. Any other key is refused (a misspelt `afterSubmit` included). */
export type ParkInput = {
  type: ParkType;
  site?: string;
  fields?: string[];
  contact?: string;
  note?: string;
  /** Only on an `error` park: the page failed after the submit click, so the application may have been sent. */
  afterSubmit?: boolean;
};

/** An open role as the agent found it. Core adds `id` (from the link) and `foundAt`. Any other key is refused. */
export type RoleInput = {
  title: string;
  organization: string;
  location?: string;
  sourceId: string;
  link: string;
  applyPath: ApplyPath;
  contact?: string;
};

export type Outcome =
  | { type: 'park'; park: ParkInput }
  | { type: 'submitted'; resumeFile: string; points: PointRef[] }
  | { type: 'skipped'; hardNoPointId: string };

/** A posting, as the agent knows it before it opens the page: its link, or the id `upsertRole` gave it. */
export type PostingRef = { link: string } | { roleId: string };

const ParkInputSchema = z.strictObject({
  type: ParkTypeSchema,
  site: z.string().optional(),
  fields: z.array(z.string()).optional(),
  contact: z.string().optional(),
  note: z.string().optional(),
  afterSubmit: z.boolean().optional(),
}) satisfies z.ZodType<ParkInput>;

const RoleInputSchema = z.strictObject({
  title: z.string(),
  organization: z.string(),
  location: z.string().optional(),
  sourceId: z.string(),
  link: z.string(),
  applyPath: ApplyPathSchema,
  contact: z.string().optional(),
}) satisfies z.ZodType<RoleInput>;

/** Check an input from an untyped caller (a model's tool call): unknown keys and wrong values are named. */
function checkInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const problems = r.error.issues.map((i) =>
    i.code === 'unrecognized_keys'
      ? `unknown ${what} key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => JSON.stringify(k)).join(', ')}`
      : `${what}${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`,
  );
  throw new Error(`invalid ${what}: ${problems.join('; ')}`);
}

function assertHttpUrl(link: string): void {
  const problem = httpUrlProblem(link);
  if (problem) throw new Error(`link ${problem}: ${link}`);
}

function roleIdOrNull(link: string): string | null {
  try {
    return roleIdFor(link);
  } catch {
    return null;
  }
}

/**
 * The application for a posting, or null. A posting is matched by role id: the `roleId` an application was
 * recorded with, or the id `roleIdFor` gives its link (so tracking parameters, the fragment, a trailing slash
 * and host case do not matter). When an application file cannot be read, a match cannot be ruled out, so
 * this throws `ApplicationStateError` naming the file rather than answer null.
 */
function findForPosting(repo: DataRepo, keys: Set<string>): Application | null {
  const { items, errors } = repo.list('application');
  let found: Application | null = null;
  for (const app of items) {
    const linkId = roleIdOrNull(app.link);
    if ((app.roleId !== undefined && keys.has(app.roleId)) || (linkId !== null && keys.has(linkId))) found = app; // newest id wins
  }
  if (found === null && errors.length > 0) {
    const files = errors.map((e) => path.relative(repo.dir, e.file).split(path.sep).join('/'));
    throw new ApplicationStateError(
      `cannot tell whether this posting already has an application: ${files.join(', ')} could not be read`,
    );
  }
  return found;
}

function postingKeys(ref: { link?: string; roleId?: string }): Set<string> {
  const keys = new Set<string>();
  if (ref.roleId !== undefined) keys.add(ref.roleId);
  if (ref.link !== undefined) {
    assertHttpUrl(ref.link);
    keys.add(roleIdFor(ref.link));
  }
  return keys;
}

/**
 * The application that already exists for a posting, in any state, or null when there is none. The agent
 * checks this before it opens a role: a posting with an application is never started again from the posting;
 * another attempt goes through that application (`{ applicationId }`, after the user's Retry).
 */
export function applicationForPosting(repo: DataRepo, posting: PostingRef): Application | null {
  return findForPosting(repo, postingKeys(posting as { link?: string; roleId?: string }));
}

/** One application per posting (R52): refuse a new one when the posting has any. */
function assertNoApplicationFor(repo: DataRepo, input: ApplicationInput): void {
  const existing = findForPosting(repo, postingKeys(input));
  if (existing) {
    throw new ApplicationStateError(
      `posting ${input.link} already has application ${existing.id} (state ${existing.state}); ` +
        `nothing was written. Another attempt goes through { applicationId: '${existing.id}' }.`,
    );
  }
}

export function sendablePoints(repo: DataRepo): Point[] {
  return repo.list('point').items.filter((p) => isSendable(p));
}

export function assertSendable(repo: DataRepo, refs: readonly PointRef[]): void {
  const badRefs: string[] = [];
  for (const ref of refs) {
    if (!isSafeId(ref.pointId) || typeof ref.rev !== 'number' || !Number.isInteger(ref.rev) || ref.rev < 1) {
      badRefs.push(String(ref.pointId));
      continue;
    }
    const pt = repo.get('point', ref.pointId);
    if (!pt || !isSendable(pt) || pt.rev !== ref.rev) {
      badRefs.push(ref.pointId);
    }
  }
  if (badRefs.length > 0) {
    throw new UnsendablePointError(`unsendable point refs: ${badRefs.join(', ')}`);
  }
}

export function upsertRole(repo: DataRepo, input: RoleInput, now: Date = new Date()): { role: OpenRole; isNew: boolean } {
  if (repo.writer !== 'agent') {
    throw new OwnershipError('only the agent may write roles');
  }
  const fields = checkInput(RoleInputSchema, input, 'role');
  assertHttpUrl(fields.link);
  const id = roleIdFor(fields.link);
  const existing = repo.get('role', id);
  const role: OpenRole = { ...(existing ?? {}), ...fields, id, foundAt: existing?.foundAt ?? now.toISOString() };
  repo.put('role', role);
  return { role, isNew: existing === null };
}

export function beginSubmit(
  repo: DataRepo,
  target: { applicationId: string } | ApplicationInput,
  intent: { resumeFile: string; points: PointRef[] },
  now: Date = new Date(),
): Application {
  if (repo.writer !== 'agent') {
    throw new OwnershipError('only the agent may write applications');
  }

  let existing: Application | null = null;
  if ('applicationId' in target) {
    existing = repo.get('application', target.applicationId);
    if (!existing) {
      throw new Error(`unknown application: ${target.applicationId}`);
    }
    if (existing.state !== 'parked') {
      throw new ApplicationStateError(
        `application ${target.applicationId} is in state ${existing.state}, expected parked`,
      );
    }
    if (existing.park?.type === 'error' && existing.park.afterSubmit) {
      throw new ApplicationStateError(
        `application ${target.applicationId} is in state ${existing.state} (may have been sent), cannot submit without confirmation`,
      );
    }
  } else {
    assertHttpUrl(target.link);
    assertNoApplicationFor(repo, target);
  }

  assertSendable(repo, intent.points);

  const atIso = now.toISOString();

  if (existing) {
    const updated: Application = {
      ...existing,
      state: 'submitting',
      pendingSubmission: {
        resumeFile: intent.resumeFile,
        points: intent.points,
        startedAt: atIso,
      },
      park: null,
      updatedAt: atIso,
    };
    repo.put('application', updated);
    return updated;
  } else {
    const input = target as ApplicationInput;
    const id = newId(now);
    const app: Application = {
      id,
      roleId: input.roleId,
      organization: input.organization,
      title: input.title,
      link: input.link,
      sourceId: input.sourceId,
      state: 'submitting',
      pendingSubmission: {
        resumeFile: intent.resumeFile,
        points: intent.points,
        startedAt: atIso,
      },
      park: null,
      parkHistory: [],
      submission: null,
      skip: null,
      statusNotes: [],
      closedAt: null,
      createdAt: atIso,
      updatedAt: atIso,
    };
    repo.put('application', app);
    return app;
  }
}

function nextParkAt(previousParkAt: string | undefined, candidateIso: string): string {
  if (!previousParkAt) {
    return candidateIso;
  }
  const prevMs = new Date(previousParkAt).getTime();
  const candMs = new Date(candidateIso).getTime();
  if (candMs <= prevMs) {
    return new Date(prevMs + 1).toISOString();
  }
  return candidateIso;
}

export function recordOutcome(
  repo: DataRepo,
  target: { applicationId: string } | ApplicationInput,
  outcome: Outcome,
  now: Date = new Date(),
): Application {
  if (repo.writer !== 'agent') {
    throw new OwnershipError('only the agent may write applications');
  }

  // Validate outcome type (B25)
  if (outcome.type !== 'park' && outcome.type !== 'submitted' && outcome.type !== 'skipped') {
    throw new Error(`unknown outcome type: ${(outcome as any).type}`);
  }

  // Validate the park: known keys only (F3), and afterSubmit only on error parks (B24)
  const parkInput = outcome.type === 'park' ? checkInput(ParkInputSchema, outcome.park, 'park') : null;
  if (parkInput?.afterSubmit && parkInput.type !== 'error') {
    throw new Error(`afterSubmit is only valid on error parks, got ${parkInput.type}`);
  }

  // Validate skip hardNoPointId (B6 / L2)
  if (outcome.type === 'skipped') {
    if (!isSafeId(outcome.hardNoPointId)) {
      throw new UnsendablePointError(`invalid hardNoPointId: ${outcome.hardNoPointId}`);
    }
    const pt = repo.get('point', outcome.hardNoPointId);
    if (!pt || !isSendable(pt) || pt.kind !== 'hard_no') {
      throw new UnsendablePointError(`hard no point ${outcome.hardNoPointId} is not a sendable hard_no`);
    }
  }

  const atIso = now.toISOString();
  let base: Application;

  if ('applicationId' in target) {
    const existing = repo.get('application', target.applicationId);
    if (!existing) {
      throw new Error(`unknown application: ${target.applicationId}`);
    }

    // State check for existing application (B23, amended in N5)
    if (outcome.type === 'park' || outcome.type === 'skipped') {
      if (existing.state !== 'submitting' && existing.state !== 'parked') {
        throw new ApplicationStateError(
          `application ${target.applicationId} is in state ${existing.state}, cannot record ${outcome.type}`,
        );
      }
      if (existing.park?.type === 'error' && existing.park.afterSubmit) {
        const isAllowedErrorAfterSubmit = parkInput?.type === 'error' && parkInput.afterSubmit === true;
        if (!isAllowedErrorAfterSubmit) {
          throw new ApplicationStateError(
            `application ${target.applicationId} is in state ${existing.state} (may have been sent), cannot record ${outcome.type}`,
          );
        }
      }
    }

    if (outcome.type === 'submitted' && existing.state === 'submitted') {
      // The one exception: if already submitted, return unchanged
      return existing;
    }

    base = { ...existing };
  } else {
    assertHttpUrl(target.link);
    assertNoApplicationFor(repo, target);
    base = {
      id: newId(now),
      roleId: target.roleId,
      organization: target.organization,
      title: target.title,
      link: target.link,
      sourceId: target.sourceId,
      state: 'submitting',
      pendingSubmission: null,
      park: null,
      parkHistory: [],
      submission: null,
      skip: null,
      statusNotes: [],
      closedAt: null,
      createdAt: atIso,
      updatedAt: atIso,
    };
  }

  if (outcome.type === 'submitted') {
    base.state = 'submitted';
    base.submission = {
      resumeFile: outcome.resumeFile,
      points: outcome.points,
      submittedAt: atIso,
    };
    base.pendingSubmission = null;
    base.park = null;
    base.closedAt = null;
    base.updatedAt = atIso;
  } else if (outcome.type === 'park' && parkInput) {
    const previousParkAt =
      base.parkHistory.length > 0
        ? base.parkHistory[base.parkHistory.length - 1]!.at
        : base.park?.at;
    const parkAt = nextParkAt(previousParkAt, atIso);
    base.state = 'parked';
    base.park = {
      ...parkInput,
      at: parkAt,
    };
    base.parkHistory = [...base.parkHistory, { type: parkInput.type, at: parkAt }];
    if (!parkInput.afterSubmit) {
      base.pendingSubmission = null;
    }
    base.updatedAt = atIso;
  } else if (outcome.type === 'skipped') {
    base.state = 'skipped';
    base.skip = {
      hardNoPointId: outcome.hardNoPointId,
      at: atIso,
    };
    base.pendingSubmission = null;
    base.park = null;
    base.closedAt = null;
    base.updatedAt = atIso;
  }

  repo.put('application', base);
  return base;
}

export function recoverInterrupted(repo: DataRepo, now: Date = new Date()): Application[] {
  if (repo.writer !== 'agent') {
    throw new OwnershipError('only the agent may recover interrupted applications');
  }
  const atIso = now.toISOString();
  const { items } = repo.list('application');
  const changed: Application[] = [];
  for (const app of items) {
    if (app.state === 'submitting') {
      const previousParkAt =
        app.parkHistory.length > 0
          ? app.parkHistory[app.parkHistory.length - 1]!.at
          : app.park?.at;
      const parkAt = nextParkAt(previousParkAt, atIso);
      const updated: Application = {
        ...app,
        state: 'parked',
        park: {
          type: 'error',
          afterSubmit: true,
          note: 'The run stopped after the submit click. The application may have been sent.',
          at: parkAt,
        },
        parkHistory: [...app.parkHistory, { type: 'error', at: parkAt }],
        updatedAt: atIso,
      };
      repo.put('application', updated);
      changed.push(updated);
    }
  }
  return changed;
}
