import type { DrifterSnap, PlayerSnap, Snapshot } from '../net/protocol';

/**
 * Smoothing for other players. The server sends a picture of the match about 20 times a
 * second, but the screen draws 60 times a second. If we drew each picture as it arrived,
 * everybody would move in little jumps. Instead we draw the match a short moment in the past
 * (INTERP_DELAY_MS) and slide each hero between the two pictures on either side of that moment.
 *
 * Plain TypeScript with no browser code, so it is tested on its own.
 */

/** How far behind "now" other players are drawn. A bit more than two snapshot gaps (50 ms each). */
export const INTERP_DELAY_MS = 110;
/** A hero that moved further than this between two snapshots teleported or respawned: do not slide. */
export const JUMP_DISTANCE = 60;
/** How many snapshots to keep. 40 is two seconds' worth. */
const MAX_BUFFER = 40;
/** Obstacles are moved along their direction of travel, but never more than this far from the picture. */
const MAX_EXTRAPOLATE_MS = 120;
const MAX_BACKWARD_MS = 80;

export interface StampedSnapshot {
  /** When the snapshot arrived, in the browser's clock (ms). */
  at: number;
  snap: Snapshot;
}

export interface Sample {
  /** Every hero, with x and y smoothed. All other numbers come from the newest snapshot. */
  players: PlayerSnap[];
  /** Every obstacle, moved along its direction to the drawn moment. */
  drifters: DrifterSnap[];
  newest: StampedSnapshot;
}

export class SnapshotBuffer {
  private items: StampedSnapshot[] = [];

  /** Adds a snapshot. Old or repeated ones (by tick number) are ignored. Returns whether it was kept. */
  push(snap: Snapshot, at: number): boolean {
    const last = this.items[this.items.length - 1];
    if (last && snap.tick <= last.snap.tick) return false;
    this.items.push({ at: last ? Math.max(at, last.at) : at, snap });
    if (this.items.length > MAX_BUFFER) this.items.shift();
    return true;
  }

  clear(): void {
    this.items = [];
  }

  get latest(): StampedSnapshot | undefined {
    return this.items[this.items.length - 1];
  }

  get size(): number {
    return this.items.length;
  }

  /** The match as it should look at browser time `renderAt` (normally "now" minus INTERP_DELAY_MS). */
  sample(renderAt: number): Sample | null {
    const newest = this.latest;
    if (!newest) return null;

    // `before` = the last snapshot that arrived at or before the drawn moment.
    let beforeIndex = -1;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].at <= renderAt) beforeIndex = i;
      else break;
    }

    let positions: (p: PlayerSnap) => { x: number; y: number };
    if (beforeIndex === -1) {
      // Nothing old enough yet (just started): show the oldest picture as it is.
      const first = this.items[0].snap;
      positions = (p) => first.players.find((q) => q.id === p.id) ?? p;
    } else if (beforeIndex === this.items.length - 1) {
      // The drawn moment is newer than anything we have (a gap in the messages): hold still.
      positions = (p) => p;
    } else {
      const a = this.items[beforeIndex];
      const b = this.items[beforeIndex + 1];
      const f = Math.min(1, Math.max(0, (renderAt - a.at) / Math.max(1, b.at - a.at)));
      positions = (p) => {
        const from = a.snap.players.find((q) => q.id === p.id);
        const to = b.snap.players.find((q) => q.id === p.id);
        if (!from || !to) return to ?? p;
        if (Math.hypot(to.x - from.x, to.y - from.y) > JUMP_DISTANCE) return f < 0.5 ? from : to;
        return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f };
      };
    }

    const players = newest.snap.players.map((p) => {
      const { x, y } = positions(p);
      return { ...p, x, y };
    });

    const elapsed = Math.min(MAX_EXTRAPOLATE_MS, Math.max(-MAX_BACKWARD_MS, renderAt - newest.at)) / 1000;
    const drifters = newest.snap.drifters.map((d) =>
      d.w > 0 ? d : { ...d, x: d.x + d.vx * elapsed, y: d.y + d.vy * elapsed },
    );

    return { players, drifters, newest };
  }
}
