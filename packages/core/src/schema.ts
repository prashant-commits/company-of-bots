import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const PointKindSchema = z.enum(['work', 'skill', 'place', 'hard_no', 'answer', 'other']);
export const RoleSchema = z.enum(['interviewer', 'finder', 'applier', 'inbox', 'guide']);
export const ParkTypeSchema = z.enum([
  'missing_answer',
  'sign_in',
  'code',
  'captcha',
  'verify',
  'human',
  'error',
]);
export const StatusKindSchema = z.enum(['reply', 'interview', 'rejection', 'offer', 'note']);
export const InterviewKindSchema = z.enum(['first', 'profile', 'missing_answers', 'weak_point']);
export const ApplyPathSchema = z.enum(['form', 'email', 'phone', 'in_person']);

export type PointKind = z.infer<typeof PointKindSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type ParkType = z.infer<typeof ParkTypeSchema>;
export type StatusKind = z.infer<typeof StatusKindSchema>;
export type InterviewKind = z.infer<typeof InterviewKindSchema>;
export type ApplyPath = z.infer<typeof ApplyPathSchema>;

const httpUrl = z
  .string()
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'URL must be http or https' });

export const EvidenceSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('said'), quote: z.string() }),
  z.looseObject({ type: z.literal('resume'), file: z.string(), quote: z.string() }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const PointSchema = z.looseObject({
  id: z.string(),
  kind: PointKindSchema,
  text: z.string().min(1),
  label: z.string().optional(),
  instruction: z.string().optional(),
  rank: z.number().int(),
  rev: z.number().int().min(1),
  evidence: EvidenceSchema,
  interviewId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Point = z.infer<typeof PointSchema>;

export const PointRefSchema = z.looseObject({
  pointId: z.string(),
  rev: z.number().int().min(1),
  field: z.string().optional(),
});
export type PointRef = z.infer<typeof PointRefSchema>;

export const TurnSchema = z.looseObject({
  role: z.enum(['agent', 'user']),
  text: z.string(),
  at: z.string(),
  attachment: z.string().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const TranscriptSchema = z.looseObject({
  interviewId: z.string(),
  turns: z.array(TurnSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const InterviewSchema = z.looseObject({
  id: z.string(),
  kind: InterviewKindSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  pointIds: z.array(z.string()),
  transcriptFile: z.string().nullable(),
  transcriptRemovedAt: z.string().nullable(),
});
export type Interview = z.infer<typeof InterviewSchema>;

export const MasterSchema = z.looseObject({ file: z.string() });
export type Master = z.infer<typeof MasterSchema>;

export const DeclarationsSchema = z.looseObject({
  hardNosNone: z.boolean(),
  sourcesDecideLater: z.boolean(),
});
export type Declarations = z.infer<typeof DeclarationsSchema>;

export const SourceSchema = z.looseObject({
  id: z.string(),
  url: httpUrl,
  label: z.string().optional(),
  enabled: z.boolean(),
  addedAt: z.string(),
  addedBy: z.enum(['interview', 'user']),
});
export type Source = z.infer<typeof SourceSchema>;

export const OpenRoleSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  organization: z.string(),
  location: z.string().optional(),
  sourceId: z.string(),
  link: z.string(),
  applyPath: ApplyPathSchema,
  contact: z.string().optional(),
  foundAt: z.string(),
});
export type OpenRole = z.infer<typeof OpenRoleSchema>;

export const ParkSchema = z.looseObject({
  type: ParkTypeSchema,
  at: z.string(),
  site: z.string().optional(),
  fields: z.array(z.string()).optional(),
  contact: z.string().optional(),
  note: z.string().optional(),
  afterSubmit: z.boolean().optional(),
});
export type Park = z.infer<typeof ParkSchema>;

export const StatusNoteSchema = z.looseObject({
  at: z.string(),
  kind: StatusKindSchema,
  text: z.string().min(1),
  commandId: z.string(),
});
export type StatusNote = z.infer<typeof StatusNoteSchema>;

export const ApplicationSchema = z.looseObject({
  id: z.string(),
  roleId: z.string().optional(),
  organization: z.string(),
  title: z.string(),
  link: z.string(),
  sourceId: z.string().optional(),
  state: z.enum(['submitting', 'parked', 'submitted', 'skipped', 'done', 'dropped']),
  pendingSubmission: z
    .looseObject({
      resumeFile: z.string(),
      points: z.array(PointRefSchema),
      startedAt: z.string(),
    })
    .nullable(),
  park: ParkSchema.nullable(),
  parkHistory: z.array(z.looseObject({ type: ParkTypeSchema, at: z.string() })),
  submission: z
    .looseObject({
      resumeFile: z.string(),
      points: z.array(PointRefSchema),
      submittedAt: z.string(),
    })
    .nullable(),
  skip: z
    .looseObject({
      hardNoPointId: z.string(),
      at: z.string(),
    })
    .nullable(),
  statusNotes: z.array(StatusNoteSchema),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Application = z.infer<typeof ApplicationSchema>;

const CommandBase = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  target: z.string().nullable(),
  state: z.enum(['queued', 'done', 'failed']),
  resultNote: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const CommandVerbSchema = z.discriminatedUnion('verb', [
  z.looseObject({ verb: z.literal('interview_saved'), payload: z.looseObject({ interviewId: z.string() }) }),
  z.looseObject({ verb: z.literal('retry'), payload: z.looseObject({ notSent: z.boolean().optional(), parkAt: z.string().optional() }) }),
  z.looseObject({ verb: z.literal('done'), payload: z.looseObject({}) }),
  z.looseObject({ verb: z.literal('verified'), payload: z.looseObject({}) }),
  z.looseObject({ verb: z.literal('drop'), payload: z.looseObject({ reason: z.string().optional() }) }),
  z.looseObject({
    verb: z.literal('status'),
    payload: z.looseObject({ kind: StatusKindSchema, text: z.string().min(1) }),
  }),
  z.looseObject({
    verb: z.literal('lane_done'),
    payload: z.looseObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  }),
  z.looseObject({
    verb: z.literal('lane_skip'),
    payload: z.looseObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  }),
  z.looseObject({
    verb: z.literal('run_role'),
    payload: z.looseObject({ role: z.enum(['finder', 'applier', 'guide']) }),
  }),
]);

export const CommandSchema = CommandBase.and(CommandVerbSchema);
export type Command = z.infer<typeof CommandSchema>;

export const LaneSchema = z.looseObject({ id: z.string(), name: z.string().min(1) });
export type Lane = z.infer<typeof LaneSchema>;

export const LanesSchema = z.looseObject({ lanes: z.array(LaneSchema) });
export type Lanes = z.infer<typeof LanesSchema>;

export const DayLogSchema = z.looseObject({
  day: z.string(),
  ticks: z.array(
    z.looseObject({
      laneId: z.string(),
      result: z.enum(['done', 'skip']),
      at: z.string(),
      commandId: z.string(),
    }),
  ),
});
export type DayLog = z.infer<typeof DayLogSchema>;

export const AgentStatusSchema = z.looseObject({
  lock: z
    .looseObject({
      holder: z.string(),
      until: z.string(),
    })
    .nullable(),
  nextRun: z.partialRecord(RoleSchema, z.string()),
  updatedAt: z.string(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const RepoMetaSchema = z.looseObject({
  schemaVersion: z.number().int(),
  createdAt: z.string(),
});
export type RepoMeta = z.infer<typeof RepoMetaSchema>;
