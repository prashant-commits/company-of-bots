import type { DataRepo } from './repo.ts';
import { OwnershipError } from './repo.ts';
import { CommandSchema, type Command, type StatusKind } from './schema.ts';
import { newId } from './ids.ts';
import { isSafeId } from './names.ts';

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

type RunRole = 'finder' | 'applier' | 'guide';

export type CommandInput =
  | { verb: 'interview_saved'; target: string | null; payload: { interviewId: string } }
  | { verb: 'retry'; target: string; payload: { notSent?: boolean; parkAt?: string } }
  | { verb: 'done'; target: string; payload: Record<string, never> }
  | { verb: 'verified'; target: string; payload: Record<string, never> }
  | { verb: 'drop'; target: string; payload: { reason?: string } }
  | { verb: 'status'; target: string; payload: { kind: StatusKind; text: string } }
  | { verb: 'lane_done'; target: string; payload: { day: string } }
  | { verb: 'lane_skip'; target: string; payload: { day: string } }
  | { verb: 'run_role'; target: string | null; payload: { role: RunRole } };

function applicationExists(repo: DataRepo, target: string): boolean {
  if (!isSafeId(target)) return false;
  return repo.get('application', target) !== null;
}

function validateTarget(repo: DataRepo, input: CommandInput): void {
  const verbsNeedApp = new Set(['retry', 'done', 'drop', 'verified', 'status'] as const);
  const verbsNeedLane = new Set(['lane_done', 'lane_skip'] as const);
  const verbsNeedNull = new Set(['interview_saved', 'run_role'] as const);

  if (verbsNeedNull.has(input.verb as 'interview_saved' | 'run_role')) {
    if (input.target !== null) throw new CommandError(`verb ${input.verb} requires null target`);
    return;
  }

  if (verbsNeedLane.has(input.verb as 'lane_done' | 'lane_skip')) {
    if (input.target === null) throw new CommandError(`verb ${input.verb} requires a lane target`);
    const lanes = repo.getSingleton('lanes');
    if (!lanes?.lanes.some((l) => l.id === input.target)) {
      throw new CommandError(`unknown lane: ${input.target}`);
    }
    return;
  }

  if (verbsNeedApp.has(input.verb as 'retry' | 'done' | 'drop' | 'verified' | 'status')) {
    if (input.target === null) throw new CommandError(`verb ${input.verb} requires a target`);
    if (!applicationExists(repo, input.target)) {
      throw new CommandError(`unknown application: ${input.target}`);
    }
  }
}

export function createCommand(repo: DataRepo, input: CommandInput, now: Date = new Date()): Command {
  if (repo.writer !== 'app') throw new OwnershipError('only the app may create commands');
  validateTarget(repo, input);
  const createdAt = now.toISOString();
  const record = {
    id: newId(now),
    createdAt,
    target: input.target,
    state: 'queued' as const,
    resultNote: null,
    finishedAt: null,
    verb: input.verb,
    payload: input.payload,
  };
  const parsed = CommandSchema.safeParse(record);
  if (!parsed.success) throw parsed.error;
  repo.put('command', parsed.data);
  return parsed.data;
}

export function queuedCommands(repo: DataRepo): Command[] {
  const { items } = repo.list('command');
  return items
    .filter((c) => c.state === 'queued')
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

export function finishCommand(
  repo: DataRepo,
  id: string,
  state: 'done' | 'failed',
  note: string,
  now: Date = new Date(),
): Command {
  if (repo.writer !== 'agent') throw new OwnershipError('only the agent may finish commands');
  const existing = repo.get('command', id);
  if (existing === null) throw new CommandError(`unknown command: ${id}`);
  if (existing.state !== 'queued') throw new CommandError(`command ${id} is not queued`);
  const updated: Command = {
    ...existing,
    state,
    resultNote: note,
    finishedAt: now.toISOString(),
  };
  repo.put('command', updated);
  return updated;
}
