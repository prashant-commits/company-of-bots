import type { DataRepo } from './repo.ts';
import { finishCommand, queuedCommands, CommandError } from './commands.ts';
import type { Command, StatusNote } from './schema.ts';
import { recoverInterrupted } from './applications.ts';

export const HANDLED_VERBS = [
  'interview_saved',
  'retry',
  'done',
  'drop',
  'verified',
  'status',
  'run_role',
] as const;

export type HandledVerb = (typeof HANDLED_VERBS)[number];

export type Work =
  | { type: 'retry'; applicationId: string; commandId: string }
  | { type: 'run_role'; role: 'finder' | 'applier' | 'guide'; commandId: string };

export type CommandOutcome =
  | { state: 'done' | 'failed'; note: string }
  | { state: 'needs_run'; work: Work };

export function processCommand(repo: DataRepo, cmd: Command, now: Date = new Date()): CommandOutcome {
  if (!HANDLED_VERBS.includes(cmd.verb as HandledVerb)) {
    throw new CommandError(`unhandled verb: ${cmd.verb}`);
  }

  let outcome: CommandOutcome;

  if (cmd.verb === 'interview_saved') {
    outcome = { state: 'done', note: 'points reloaded' };
  } else if (cmd.verb === 'run_role') {
    outcome = {
      state: 'needs_run',
      work: {
        type: 'run_role',
        role: cmd.payload.role,
        commandId: cmd.id,
      },
    };
  } else {
    if (!cmd.target) {
      outcome = { state: 'failed', note: `failed: unknown application ${cmd.target}` };
    } else {
      const app = repo.get('application', cmd.target);
      if (!app) {
        outcome = { state: 'failed', note: `failed: unknown application ${cmd.target}` };
      } else {
        const atIso = now.toISOString();

        if (cmd.verb === 'status') {
          const statusNote: StatusNote = {
            at: atIso,
            kind: cmd.payload.kind,
            text: cmd.payload.text,
            commandId: cmd.id,
          };
          const updated = {
            ...app,
            statusNotes: [...app.statusNotes, statusNote],
            updatedAt: atIso,
          };
          repo.put('application', updated);
          outcome = { state: 'done', note: `status: ${cmd.payload.kind}` };
        } else if (cmd.verb === 'drop') {
          const updated = {
            ...app,
            state: 'dropped' as const,
            park: null,
            pendingSubmission: null,
            closedAt: atIso,
            updatedAt: atIso,
          };
          repo.put('application', updated);
          const reason = cmd.payload?.reason;
          const note = reason ? `closed: dropped — ${reason}` : 'closed: dropped';
          outcome = { state: 'done', note };
        } else if (cmd.verb === 'done') {
          if (app.state !== 'parked') {
            outcome = { state: 'failed', note: `failed: application is ${app.state}` };
          } else if (app.park?.type === 'error' && app.park.afterSubmit && app.pendingSubmission) {
            const updated = {
              ...app,
              state: 'submitted' as const,
              submission: {
                resumeFile: app.pendingSubmission.resumeFile,
                points: app.pendingSubmission.points,
                submittedAt: app.pendingSubmission.startedAt,
              },
              pendingSubmission: null,
              park: null,
              updatedAt: atIso,
            };
            repo.put('application', updated);
            outcome = { state: 'done', note: 'closed: user confirmed it was sent' };
          } else {
            const updated = {
              ...app,
              state: 'done' as const,
              park: null,
              closedAt: atIso,
              updatedAt: atIso,
            };
            repo.put('application', updated);
            outcome = { state: 'done', note: 'closed: finished by user' };
          }
        } else if (cmd.verb === 'retry' || cmd.verb === 'verified') {
          if (app.state !== 'parked') {
            outcome = { state: 'failed', note: `failed: application is ${app.state}` };
          } else if (
            app.park?.type === 'error' &&
            app.park.afterSubmit &&
            !('notSent' in cmd.payload && cmd.payload.notSent === true)
          ) {
            outcome = {
              state: 'failed',
              note: 'failed: confirm the application was not sent before retrying',
            };
          } else {
            outcome = {
              state: 'needs_run',
              work: {
                type: 'retry',
                applicationId: app.id,
                commandId: cmd.id,
              },
            };
          }
        } else {
          outcome = { state: 'failed', note: `unhandled verb: ${cmd.verb}` };
        }
      }
    }
  }

  if (outcome.state === 'done' || outcome.state === 'failed') {
    finishCommand(repo, cmd.id, outcome.state, outcome.note, now);
  }

  return outcome;
}

export function processQueue(repo: DataRepo, now: Date = new Date()): Work[] {
  recoverInterrupted(repo, now);
  const queued = queuedCommands(repo);
  const work: Work[] = [];
  for (const cmd of queued) {
    if (!HANDLED_VERBS.includes(cmd.verb as HandledVerb)) {
      continue;
    }
    const outcome = processCommand(repo, cmd, now);
    if (outcome.state === 'needs_run') {
      work.push(outcome.work);
    }
  }
  return work;
}
