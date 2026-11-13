import type { Point } from './schema.ts';

export const CONFIRMED = 100;
export const UNSURE = 0;

/** A point is sendable when its rank is at or above confirmed. */
export function isSendable(p: { rank: number }): boolean {
  return p.rank >= CONFIRMED;
}

/** Human-readable confidence label for a rank value. */
export function rankText(rank: number): string {
  if (rank < CONFIRMED) return 'Unsure';
  if (rank === CONFIRMED) return 'Confirmed';
  return `Confirmed ×${rank - CONFIRMED + 1}`;
}

/** Order points for profile display: lowest rank first, then updatedAt, then id. */
export function sortForProfile(points: Point[]): Point[] {
  return [...points].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
