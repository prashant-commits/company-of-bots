import type { z } from 'zod';
import {
  AgentStatusSchema,
  ApplicationSchema,
  CommandSchema,
  DayLogSchema,
  DeclarationsSchema,
  InterviewSchema,
  LanesSchema,
  MasterSchema,
  OpenRoleSchema,
  PointSchema,
  RepoMetaSchema,
  SourceSchema,
  TranscriptSchema,
} from './schema.ts';

export type Writer = 'app' | 'agent';

type KindEntry = {
  dir: string;
  schema: z.ZodType;
  owner: Writer | 'command';
};

export const KINDS = {
  point: { dir: 'profile/points', schema: PointSchema, owner: 'app' },
  interview: { dir: 'profile/interviews', schema: InterviewSchema, owner: 'app' },
  transcript: { dir: 'profile/transcripts', schema: TranscriptSchema, owner: 'app' },
  source: { dir: 'sources', schema: SourceSchema, owner: 'app' },
  role: { dir: 'roles', schema: OpenRoleSchema, owner: 'agent' },
  application: { dir: 'applications', schema: ApplicationSchema, owner: 'agent' },
  command: { dir: 'commands', schema: CommandSchema, owner: 'command' },
  dayLog: { dir: 'guide/log', schema: DayLogSchema, owner: 'agent' },
} as const satisfies Record<string, KindEntry>;

export type KindName = keyof typeof KINDS;

export type KindType<K extends KindName> = z.infer<(typeof KINDS)[K]['schema']>;

type SingletonEntry = {
  path: string;
  schema: z.ZodType;
  owner: Writer;
};

export const SINGLETONS = {
  meta: { path: 'cob.json', schema: RepoMetaSchema, owner: 'app' },
  master: { path: 'profile/master.json', schema: MasterSchema, owner: 'app' },
  declarations: { path: 'profile/declarations.json', schema: DeclarationsSchema, owner: 'app' },
  lanes: { path: 'guide/lanes.json', schema: LanesSchema, owner: 'app' },
  agentStatus: { path: 'agent/status.json', schema: AgentStatusSchema, owner: 'agent' },
} as const satisfies Record<string, SingletonEntry>;

export type SingletonName = keyof typeof SINGLETONS;

export type SingletonType<S extends SingletonName> = z.infer<(typeof SINGLETONS)[S]['schema']>;

/** Map a repo-relative path to its writer owner, or null when unknown. */
export function ownerOfPath(relPath: string): Writer | null {
  const p = relPath.replace(/\\/g, '/');

  if (p.startsWith('profile/resumes/') || p.startsWith('profile/resume-text/')) {
    return 'app';
  }

  for (const entry of Object.values(SINGLETONS)) {
    if (p === entry.path) {
      return entry.owner;
    }
  }

  for (const entry of Object.values(KINDS)) {
    const prefix = `${entry.dir}/`;
    if (p.startsWith(prefix) && p.endsWith('.json')) {
      return entry.owner === 'command' ? 'agent' : entry.owner;
    }
  }

  return null;
}
