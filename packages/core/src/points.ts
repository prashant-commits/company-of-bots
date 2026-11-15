import { CONFIRMED, UNSURE } from './confidence.ts';
import type { Evidence, Point, PointKind } from './schema.ts';

export class PointOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PointOpError';
  }
}

export type PointOp =
  | { op: 'add'; kind: PointKind; text: string; label?: string; instruction?: string; unsure?: boolean; evidence: Evidence }
  | { op: 'confirm'; pointId: string; evidence: Evidence }
  | { op: 'correct'; pointId: string; text: string; evidence: Evidence }
  | { op: 'unsure'; pointId: string; evidence: Evidence }
  | { op: 'remove'; pointId: string; evidence: Evidence };

export function applyPointOp(
  existing: Point | null,
  op: PointOp,
  ctx: { interviewId: string; now: string; id: () => string },
): Point | null {
  switch (op.op) {
    case 'add': {
      const rank = op.unsure ? UNSURE : CONFIRMED;
      return {
        id: ctx.id(),
        kind: op.kind,
        text: op.text,
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.instruction !== undefined ? { instruction: op.instruction } : {}),
        rank,
        rev: 1,
        evidence: op.evidence,
        interviewId: ctx.interviewId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
    }
    case 'remove':
    case 'confirm':
    case 'correct':
    case 'unsure':
      // The op changes the point it names, and only that one: `existing` must be that point.
      if (existing === null) throw new PointOpError(`no point ${op.pointId} for op ${op.op}`);
      if (existing.id !== op.pointId) {
        throw new PointOpError(`op ${op.op} names point ${op.pointId} but was given point ${existing.id}; nothing was changed`);
      }
      if (op.op === 'remove') return null;
      break;
  }

  const point = existing!;

  switch (op.op) {
    case 'confirm':
      return {
        ...point,
        rank: point.rank < CONFIRMED ? CONFIRMED : point.rank + 1,
        interviewId: ctx.interviewId,
        updatedAt: ctx.now,
      };
    case 'correct':
      return {
        ...point,
        text: op.text,
        evidence: op.evidence,
        rank: CONFIRMED,
        rev: point.rev + 1,
        interviewId: ctx.interviewId,
        updatedAt: ctx.now,
      };
    case 'unsure':
      return {
        ...point,
        rank: UNSURE,
        interviewId: ctx.interviewId,
        updatedAt: ctx.now,
      };
    default:
      throw new PointOpError(`unknown op`);
  }
}
