import type { DataRepo } from './repo.ts';
import { OwnershipError } from './repo.ts';
import { isSendable, CONFIRMED, UNSURE } from './confidence.ts';
export { CONFIRMED, UNSURE };
import { newId, roleIdFor } from './ids.ts';
import type { Application, OpenRole, Park, ParkType, Point, PointRef } from './schema.ts';

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

export type Outcome =
  | { type: 'park'; park: Omit<Park, 'at'> }
  | { type: 'submitted'; resumeFile: string; points: PointRef[] }
  | { type: 'skipped'; hardNoPointId: string };

function assertHttpUrl(link: string): void {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new Error(`link is not a valid URL: ${link}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`link must be http or https: ${link}`);
  }
}

function isValidPointId(id: unknown): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

export function sendablePoints(repo: DataRepo): Point[] {
  return repo.list('point').items.filter((p) => isSendable(p));
}

export function assertSendable(repo: DataRepo, refs: readonly PointRef[]): void {
  const badRefs: string[] = [];
  for (const ref of refs) {
    if (!isValidPointId(ref.pointId) || typeof ref.rev !== 'number' || !Number.isInteger(ref.rev) || ref.rev < 1) {
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

export function upsertRole(
  repo: DataRepo,
  input: Omit<OpenRole, 'id' | 'foundAt'>,
  now: Date = new Date(),
): { role: OpenRole; isNew: boolean } {
  if (repo.writer !== 'agent') {
    throw new OwnershipError('only the agent may write roles');
  }
  const roleInput = input as { link: string; [k: string]: unknown };
  assertHttpUrl(roleInput.link);
  const id = roleIdFor(roleInput.link);
  const existing = repo.get('role', id);
  if (existing !== null) {
    const role: OpenRole = {
      ...existing,
      ...input,
      id,
      foundAt: existing.foundAt,
    } as OpenRole;
    repo.put('role', role);
    return { role, isNew: false };
  } else {
    const role: OpenRole = {
      ...input,
      id,
      foundAt: now.toISOString(),
    } as OpenRole;
    repo.put('role', role);
    return { role, isNew: true };
  }
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
  } else {
    assertHttpUrl(target.link);
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

  // Validate park afterSubmit (B24)
  if (outcome.type === 'park' && outcome.park.afterSubmit && outcome.park.type !== 'error') {
    throw new Error(`afterSubmit is only valid on error parks, got ${outcome.park.type}`);
  }

  // Validate skip hardNoPointId (B6 / L2)
  if (outcome.type === 'skipped') {
    if (!isValidPointId(outcome.hardNoPointId)) {
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

    // State check for existing application (B23)
    if (outcome.type === 'park' || outcome.type === 'skipped') {
      if (existing.state !== 'submitting' && existing.state !== 'parked') {
        throw new ApplicationStateError(
          `application ${target.applicationId} is in state ${existing.state}, cannot record ${outcome.type}`,
        );
      }
    }

    if (outcome.type === 'submitted' && existing.state === 'submitted') {
      // The one exception: if already submitted, return unchanged
      return existing;
    }

    base = { ...existing };
  } else {
    assertHttpUrl(target.link);
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
    base.updatedAt = atIso;
  } else if (outcome.type === 'park') {
    const parkInput = outcome.park as {
      type: ParkType;
      site?: string;
      fields?: string[];
      contact?: string;
      note?: string;
      afterSubmit?: boolean;
    };
    base.state = 'parked';
    base.park = {
      ...parkInput,
      at: atIso,
    };
    base.parkHistory = [...base.parkHistory, { type: parkInput.type, at: atIso }];
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
      const updated: Application = {
        ...app,
        state: 'parked',
        park: {
          type: 'error',
          afterSubmit: true,
          note: 'The run stopped after the submit click. The application may have been sent.',
          at: atIso,
        },
        parkHistory: [...app.parkHistory, { type: 'error', at: atIso }],
        updatedAt: atIso,
      };
      repo.put('application', updated);
      changed.push(updated);
    }
  }
  return changed;
}
