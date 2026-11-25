import { CONFIG, type Config } from '../core/config';
import { moveHero } from '../core/movement';
import type { Barrier, InputState } from '../core/types';

/**
 * Own-hero prediction. Waiting for the server to answer every key press would make your hero
 * feel like it moves through mud (half a round trip to the server and back). So your own hero
 * is moved on your screen straight away, with the same movement code the server uses
 * (src/core/movement.ts). The server still decides: every snapshot we compare where the server
 * says we are with where we were back then, and nudge ourselves by the difference.
 *
 * The messages carry no "input number", so "back then" is estimated from the measured round trip.
 */

/** A difference bigger than this is a bump, respawn or teleport: jump to the server's version. */
export const SNAP_DISTANCE = 80;
/** Differences smaller than this are ignored (rounding in the snapshot). */
const IGNORE_BELOW = 0.4;
/** How much of a small difference is fixed per snapshot. */
const CORRECTION = 0.3;
const HISTORY_MS = 1500;

interface Trail {
  at: number;
  x: number;
  y: number;
}

export class Predictor {
  x = 0;
  y = 0;
  private trail: Trail[] = [];
  /** After a teleport, snapshots that left the server before it happened are ignored until this time. */
  private holdUntil = -Infinity;

  constructor(private readonly cfg: Config = CONFIG) {}

  /** Puts the hero at the server's position and forgets the past. */
  reset(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.trail = [];
  }

  /** Our own teleport: jump now, and ignore snapshots that still show the old place. */
  teleport(x: number, y: number, now: number, roundTripMs: number): void {
    this.reset(x, y);
    this.holdUntil = now + roundTripMs + 80;
  }

  /** Moves the hero one fixed step, exactly as the server would (walls, edges and all). */
  step(input: InputState, dtMs: number, walls: Barrier[], now: number): void {
    const hero = { x: this.x, y: this.y, radius: this.cfg.player.radius, bumpVx: 0, bumpVy: 0, bumpMs: 0 };
    moveHero(hero, input, dtMs, walls, this.cfg);
    this.x = hero.x;
    this.y = hero.y;
    this.trail.push({ at: now, x: this.x, y: this.y });
    while (this.trail.length > 0 && now - this.trail[0].at > HISTORY_MS) this.trail.shift();
  }

  /**
   * A snapshot arrived. `server` is where it says we are, `arrivedAt` is when it came and
   * `roundTripMs` is the measured delay there and back. Returns what was done, for tests.
   */
  reconcile(
    server: { x: number; y: number },
    arrivedAt: number,
    roundTripMs: number,
  ): 'snapped' | 'nudged' | 'ok' {
    if (arrivedAt < this.holdUntil) return 'ok';
    const then = this.positionAt(arrivedAt - roundTripMs);
    if (!then) {
      this.reset(server.x, server.y);
      return 'snapped';
    }

    const errX = server.x - then.x;
    const errY = server.y - then.y;
    const error = Math.hypot(errX, errY);
    if (error > SNAP_DISTANCE) {
      this.reset(server.x, server.y);
      return 'snapped';
    }
    if (error < IGNORE_BELOW) return 'ok';

    // Apply the correction to the present AND to the remembered past, so the next snapshot is
    // compared against a past that already includes this fix (otherwise it would be counted twice).
    const dx = errX * CORRECTION;
    const dy = errY * CORRECTION;
    this.x += dx;
    this.y += dy;
    for (const t of this.trail) {
      t.x += dx;
      t.y += dy;
    }
    return 'nudged';
  }

  /** Where we believed we were at browser time `at` (null if we have no memory that old). */
  private positionAt(at: number): { x: number; y: number } | null {
    if (this.trail.length === 0) return null;
    let best = this.trail[0];
    for (const t of this.trail) {
      if (Math.abs(t.at - at) < Math.abs(best.at - at)) best = t;
    }
    // Too far from anything we remember (e.g. the tab was in the background): do not trust it.
    return Math.abs(best.at - at) > 100 ? null : best;
  }
}
