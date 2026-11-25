import type { Config } from './config';
import { CONFIG } from './config';
import { clamp, pushCircleOutOfRect } from './collision';
import type { Barrier, InputState, Player } from './types';

/** The parts of a hero that movement reads and changes. */
export type Mover = Pick<Player, 'x' | 'y' | 'radius' | 'bumpVx' | 'bumpVy' | 'bumpMs'>;

/**
 * Moves one hero by one fixed step: walking, the shove from a bump, then solid walls and the
 * arena edge pushing the hero back. It is the ONE place that decides how a hero moves, used by
 * the match rules (game.ts, on the server) and by the browser to predict your own hero, so the
 * two can never disagree about walls or speed.
 */
export function moveHero(
  p: Mover,
  input: InputState,
  dtMs: number,
  barriers: readonly Barrier[],
  cfg: Config = CONFIG,
): void {
  const { arena } = cfg;
  const dt = dtMs / 1000;

  // Normalising makes diagonals exactly as fast as straight lines.
  const length = Math.hypot(input.dx, input.dy);
  if (length > 0) {
    p.x += (input.dx / length) * cfg.player.speed * dt;
    p.y += (input.dy / length) * cfg.player.speed * dt;
  }

  // A shove from bumping another player.
  if (p.bumpMs > 0) {
    const t = Math.min(dtMs, p.bumpMs) / 1000;
    p.x += p.bumpVx * t;
    p.y += p.bumpVy * t;
    p.bumpMs = Math.max(0, p.bumpMs - dtMs);
  }

  // Solid walls push the player out; the arena edge keeps them inside.
  // Two passes so corners between two walls settle cleanly.
  for (let pass = 0; pass < 2; pass++) {
    for (const barrier of barriers) {
      if (barrier.warningMs <= 0) pushCircleOutOfRect(p, barrier);
    }
    p.x = clamp(p.x, arena.x + p.radius, arena.x + arena.width - p.radius);
    p.y = clamp(p.y, arena.y + p.radius, arena.y + arena.height - p.radius);
  }
}
