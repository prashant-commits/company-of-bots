import { beforeEach, expect, test } from 'vitest';
import { createCommand, finishCommand, queuedCommands, CommandError } from '../src/commands.ts';
import { pair, sample, seedLanes, tmpRepo } from './helpers.ts';

let app: ReturnType<typeof tmpRepo>;
let agent: ReturnType<typeof tmpRepo>;
const appId = 'a1';

beforeEach(() => {
  ({ app, agent } = pair());
  agent.put('application', sample.application({ id: appId }));
  seedLanes(app);
});

test('queued commands come back oldest first', () => {
  createCommand(app, { verb: 'done', target: appId, payload: {} }, new Date('2026-11-11T10:00:01Z'));
  createCommand(
    app,
    { verb: 'status', target: appId, payload: { kind: 'reply', text: 'Recruiter called' } },
    new Date('2026-11-11T10:00:00Z'),
  );
  expect(queuedCommands(app).map((c) => c.verb)).toEqual(['status', 'done']);
});

test('targets are validated', () => {
  expect(() => createCommand(app, { verb: 'retry', target: 'nope', payload: {} })).toThrow(CommandError);
  expect(() =>
    createCommand(app, { verb: 'lane_done', target: 'nope', payload: { day: '2026-11-11' } }),
  ).toThrow(CommandError);
  expect(() => createCommand(app, { verb: 'run_role', target: appId, payload: { role: 'finder' } })).toThrow(CommandError);
});

test('finish records state, note and time, and keeps the file', () => {
  const c = createCommand(app, { verb: 'drop', target: appId, payload: { reason: 'role closed' } });
  const f = finishCommand(agent, c.id, 'done', 'closed: dropped', new Date('2026-11-11T11:00:00Z'));
  expect(f).toMatchObject({ state: 'done', resultNote: 'closed: dropped', finishedAt: '2026-11-11T11:00:00.000Z' });
  expect(queuedCommands(app)).toHaveLength(0);
  expect(app.get('command', c.id)).not.toBeNull();
  expect(() => finishCommand(agent, c.id, 'done', 'again')).toThrow(CommandError);
});
