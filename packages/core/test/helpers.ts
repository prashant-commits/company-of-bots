import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataRepo } from '../src/repo.ts';
import { newId } from '../src/ids.ts';
import type {
  AgentStatus,
  Application,
  Command,
  DayLog,
  Declarations,
  Evidence,
  Interview,
  Lanes,
  Master,
  OpenRole,
  Park,
  ParkType,
  Point,
  Source,
  Transcript,
} from '../src/schema.ts';
import { CONFIRMED } from '../src/confidence.ts';
import { beginSubmit, type ApplicationInput } from '../src/applications.ts';
import { processQueue } from '../src/process.ts';
import type { KindName } from '../src/layout.ts';
import type { Writer } from '../src/layout.ts';

export const T0 = '2026-11-11T09:00:00.000Z';
export const T1 = '2026-11-11T10:00:00.000Z';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cob-test-'));
}

export function tmpRepo(writer: Writer, dir?: string): DataRepo {
  const d = dir ?? tmpDir();
  return new DataRepo(d, writer);
}

export function said(quote: string): Evidence {
  return { type: 'said', quote };
}

export function roleInput(o: Partial<Omit<OpenRole, 'id' | 'foundAt'>> = {}): Omit<OpenRole, 'id' | 'foundAt'> {
  return {
    title: 'Warehouse supervisor',
    organization: 'Example Foods',
    sourceId: 's1',
    link: 'https://careers.example.com/jobs/1',
    applyPath: 'form',
    ...o,
  };
}

export function appInput(o: Partial<ApplicationInput> = {}): ApplicationInput {
  return {
    organization: 'Example Foods',
    title: 'Warehouse supervisor',
    link: 'https://careers.example.com/jobs/1',
    ...o,
  };
}

export function seedLanes(app: DataRepo): void {
  app.putSingleton('lanes', { lanes: [{ id: 'one-outreach', name: 'One outreach' }] });
}

export const sample = {
  point(overrides: Partial<Point> = {}): Point {
    return {
      id: 'x',
      kind: 'skill',
      text: 'Forklift driving',
      rank: 100,
      rev: 1,
      evidence: said('i drive forklifts'),
      interviewId: 'i1',
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    };
  },
  interview(overrides: Partial<Interview> = {}): Interview {
    return {
      id: 'i1',
      kind: 'profile',
      startedAt: T0,
      endedAt: T1,
      pointIds: ['x'],
      transcriptFile: null,
      transcriptRemovedAt: null,
      ...overrides,
    };
  },
  transcript(overrides: Partial<Transcript> = {}): Transcript {
    return {
      interviewId: 'i1',
      turns: [{ role: 'user', text: 'hello', at: T0 }],
      ...overrides,
    };
  },
  source(overrides: Partial<Source> = {}): Source {
    return {
      id: 's1',
      url: 'https://careers.example.com/jobs',
      enabled: true,
      addedAt: T0,
      addedBy: 'user',
      ...overrides,
    };
  },
  role(overrides: Partial<OpenRole> = {}): OpenRole {
    return {
      id: 'r1',
      title: 'Warehouse supervisor',
      organization: 'Example Foods',
      sourceId: 's1',
      link: 'https://careers.example.com/jobs/1',
      applyPath: 'form',
      foundAt: T0,
      ...overrides,
    };
  },
  application(overrides: Partial<Application> = {}): Application {
    return {
      id: 'a1',
      organization: 'Example Foods',
      title: 'Warehouse supervisor',
      link: 'https://careers.example.com/jobs/1',
      state: 'parked',
      pendingSubmission: null,
      park: { type: 'captcha', at: T0 },
      parkHistory: [{ type: 'captcha', at: T0 }],
      submission: null,
      skip: null,
      statusNotes: [],
      closedAt: null,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    };
  },
  command(overrides: Partial<Command> = {}): Command {
    return {
      id: newId(new Date(T0)),
      createdAt: T0,
      verb: 'run_role',
      target: null,
      payload: { role: 'finder' },
      state: 'queued',
      resultNote: null,
      finishedAt: null,
      ...overrides,
    } as Command;
  },
  dayLog(overrides: Partial<DayLog> = {}): DayLog {
    return {
      day: '2026-11-11',
      ticks: [],
      ...overrides,
    };
  },
  meta() {
    return { schemaVersion: 1, createdAt: T0 };
  },
  master(overrides: Partial<Master> = {}): Master {
    return { file: 'cv.pdf', ...overrides };
  },
  declarations(overrides: Partial<Declarations> = {}): Declarations {
    return { hardNosNone: false, sourcesDecideLater: false, ...overrides };
  },
  lanes(overrides: Partial<Lanes> = {}): Lanes {
    return { lanes: [{ id: 'one-outreach', name: 'One outreach' }], ...overrides };
  },
  agentStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
    return { lock: null, nextRun: {}, updatedAt: T0, ...overrides };
  },
};

export function pair(): {
  dir: string;
  app: DataRepo;
  agent: DataRepo;
  seedPark: (id: string, park: Omit<Park, 'at'> | Park, extra?: Partial<Application>) => Application;
  seedInterruptedSubmit: (pointId?: string) => Application;
} {
  const dir = tmpDir();
  const app = new DataRepo(dir, 'app');
  const agent = new DataRepo(dir, 'agent');

  const seedPark = (
    id: string,
    park: Omit<Park, 'at'> | Park,
    extra: Partial<Application> = {},
  ): Application => {
    const parkObj = park as {
      type: ParkType;
      at?: string;
      site?: string;
      fields?: string[];
      contact?: string;
      note?: string;
      afterSubmit?: boolean;
    };
    const at = typeof parkObj.at === 'string' ? parkObj.at : T0;
    const fullPark: Park = { ...parkObj, at };
    const appRecord: Application = sample.application({
      id,
      state: 'parked',
      park: fullPark,
      parkHistory: [{ type: fullPark.type, at }],
      pendingSubmission: fullPark.afterSubmit
        ? {
            resumeFile: 'cv.pdf',
            points: [{ pointId: 'p1', rev: 1, field: 'Notice period' }],
            startedAt: T0,
          }
        : null,
      createdAt: T0,
      updatedAt: T0,
      ...extra,
    });
    agent.put('application', appRecord);
    return appRecord;
  };

  const seedInterruptedSubmit = (pointId: string = 'p1'): Application => {
    app.put('point', sample.point({ id: pointId, rank: CONFIRMED, rev: 1 }));
    const s = beginSubmit(
      agent,
      appInput(),
      { resumeFile: 'cv.pdf', points: [{ pointId, rev: 1, field: 'Notice period' }] },
      new Date(T0),
    );
    processQueue(agent, new Date(T1));
    return agent.get('application', s.id)!;
  };

  return { dir, app, agent, seedPark, seedInterruptedSubmit };
}
