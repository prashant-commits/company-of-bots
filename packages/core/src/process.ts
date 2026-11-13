import type { DataRepo } from './repo.ts';
import { finishCommand, queuedCommands, CommandError } from './commands.ts';
import type { Command, StatusNote, Park } from './schema.ts';
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
      let app;
      try {
        app = repo.get('application', cmd.target);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcome = { state: 'failed', note: `failed: ${msg}` };
        const currentCmd = repo.get('command', cmd.id);
        if (currentCmd?.state === 'queued') {
          finishCommand(repo, cmd.id, outcome.state, outcome.note, now);
        }
        return outcome;
      }

      if (!app) {
        outcome = { state: 'failed', note: `failed: unknown application ${cmd.target}` };
      } else {
        const atIso = now.toISOString();

        if (cmd.verb === 'status') {
          // Row B10, amended (L1): idempotent by commandId
          if (app.statusNotes.some((n) => n.commandId === cmd.id)) {
            outcome = { state: 'done', note: `status: ${cmd.payload.kind}` };
          } else {
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
          }
        } else if (cmd.verb === 'drop') {
          // Row B9, amended (M3): done and drop apply only to parked applications
          if (app.state !== 'parked') {
            outcome = { state: 'failed', note: `failed: application is ${app.state}` };
          } else {
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
          }
        } else if (cmd.verb === 'done') {
          // Row B9, amended (M3) & Row B8, amended (m37)
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
              closedAt: null, // Clarification for m37
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
          // Row B22 (N1)
          if (app.state !== 'parked') {
            outcome = { state: 'failed', note: `failed: application is ${app.state}` };
          } else if (app.park?.type === 'error' && app.park.afterSubmit) {
            if (cmd.verb === 'verified') {
              outcome = {
                state: 'failed',
                note: 'failed: confirm the application was not sent before retrying',
              };
            } else {
              const notSent = 'notSent' in cmd.payload && cmd.payload.notSent === true;
              const matchingParkAt =
                'parkAt' in cmd.payload &&
                typeof cmd.payload.parkAt === 'string' &&
                cmd.payload.parkAt === app.park.at;
              if (!notSent || !matchingParkAt) {
                outcome = {
                  state: 'failed',
                  note: 'failed: confirm the application was not sent before retrying',
                };
              } else {
                // Row B27 (N2)
                const { afterSubmit: _afterSubmit, ...restPark } = app.park;
                const baseNote = app.park.note ?? '';
                const newNote = baseNote
                  ? `${baseNote} — user confirmed not sent`
                  : 'user confirmed not sent';
                const updatedPark: Park = {
                  ...restPark,
                  type: 'error',
                  at: app.park.at,
                  note: newNote,
                };
                const updatedApp = {
                  ...app,
                  park: updatedPark,
                  updatedAt: atIso,
                };
                repo.put('application', updatedApp);
                outcome = {
                  state: 'needs_run',
                  work: {
                    type: 'retry',
                    applicationId: app.id,
                    commandId: cmd.id,
                  },
                };
              }
            }
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
    const currentCmd = repo.get('command', cmd.id);
    if (currentCmd?.state === 'queued') {
      finishCommand(repo, cmd.id, outcome.state, outcome.note, now);
    }
  }

  return outcome;
}

export function processQueue(repo: DataRepo, now: Date = new Date()): Work[] {
  recoverInterrupted(repo, now);
  const queued = queuedCommands(repo);
  const work: Work[] = [];
  const seenRetryApps = new Set<string>();

  for (const cmd of queued) {
    if (!HANDLED_VERBS.includes(cmd.verb as HandledVerb)) {
      continue;
    }

    // Row B21: at most one Work per application per pass
    if (
      (cmd.verb === 'retry' || cmd.verb === 'verified') &&
      cmd.target &&
      seenRetryApps.has(cmd.target)
    ) {
      finishCommand(
        repo,
        cmd.id,
        'failed',
        'failed: a retry for this application is already pending',
        now,
      );
      continue;
    }

    // Rows B14 and B15 amended (M2): error processing command fails command and continues
    try {
      const outcome = processCommand(repo, cmd, now);
      if (outcome.state === 'needs_run') {
        work.push(outcome.work);
        if (outcome.work.type === 'retry') {
          seenRetryApps.add(outcome.work.applicationId);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finishCommand(repo, cmd.id, 'failed', `failed: ${msg}`, now);
    }
  }

  // Ensure no Work is returned for an application dropped or closed in the same batch
  const validWork: Work[] = [];
  for (const w of work) {
    if (w.type === 'retry') {
      const targetApp = repo.get('application', w.applicationId);
      if (!targetApp || targetApp.state !== 'parked') {
        finishCommand(
          repo,
          w.commandId,
          'failed',
          `failed: application is ${targetApp?.state ?? 'unknown'}`,
          now,
        );
        continue;
      }
    }
    validWork.push(w);
  }

  return validWork;
}
