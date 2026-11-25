import { circleHitsRect, rectsTooClose, type Circle, type Rect } from './collision';
import type { Config } from './config';
import type { Difficulty } from './difficulty';
import type { Rng } from './rng';
import type { Barrier, Drifter, DrifterKind, GameState, Orb, Trap } from './types';

/**
 * Everything about *where* things appear. Placement is random but controlled:
 * each function rejects unfair spots (on top of the player, inside walls...)
 * and returns nothing if it cannot find a fair one, so callers simply try again later.
 */

/**
 * Picks wall positions. Walls never touch each other or the arena border, so there is
 * always a way around them. New walls start as an outline (warningMs) before turning solid.
 */
export function placeBarriers(
  rng: Rng,
  player: Circle,
  cfg: Config,
  count: number,
  warningMs: number,
): Barrier[] {
  const { arena, barriers } = cfg;
  const placed: Barrier[] = [];

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const size = barriers.sizes[rng.int(0, barriers.sizes.length - 1)];
      const rect: Barrier = {
        x: rng.range(arena.x + barriers.wallMargin, arena.x + arena.width - barriers.wallMargin - size.width),
        y: rng.range(arena.y + barriers.wallMargin, arena.y + arena.height - barriers.wallMargin - size.height),
        width: size.width,
        height: size.height,
        warningMs,
      };
      const nearPlayer = circleHitsRect(
        { x: player.x, y: player.y, radius: barriers.minDistanceFromPlayer },
        rect,
      );
      if (nearPlayer) continue;
      if (placed.some((other) => rectsTooClose(other, rect, barriers.separation))) continue;
      placed.push(rect);
      break;
    }
  }
  return placed;
}

/**
 * Creates one moving obstacle, or a wave of 2-3 flying side by side, at an edge of the
 * playable area. Each starts as a harmless marker (warningMs) so the player always has time
 * to react, and never closer than minEntryDistance to the player. Returns [] if nothing fit.
 */
export function spawnDrifters(
  rng: Rng,
  player: Circle,
  cfg: Config,
  bounds: Rect,
  difficulty: Difficulty,
): Drifter[] {
  const { drifters } = cfg;
  const kinds = Object.keys(drifters.types) as DrifterKind[];
  const kind = kinds[rng.int(0, kinds.length - 1)];
  const spec = drifters.types[kind];
  const r = spec.radius;
  const isWave = rng.next() < difficulty.waveChance;
  const count = isWave ? rng.int(...drifters.waveSize) : 1;

  // Everyone in a wave shares a direction and speed, so they travel in parallel.
  const speed =
    difficulty.speedMin +
    (difficulty.speedMax - difficulty.speedMin) * rng.range(spec.speedFactor[0], spec.speedFactor[1]);

  for (let attempt = 0; attempt < 20; attempt++) {
    const edge = rng.int(0, 3); // 0 top, 1 bottom, 2 left, 3 right
    const horizontalEdge = edge < 2;
    // Position along the edge; the other coordinate is fixed to the edge itself.
    const alongMin = (horizontalEdge ? bounds.x : bounds.y) + r;
    const alongMax = (horizontalEdge ? bounds.x + bounds.width : bounds.y + bounds.height) - r;
    const centre = rng.range(alongMin, alongMax);
    const fixed = horizontalEdge
      ? (edge === 0 ? bounds.y + r : bounds.y + bounds.height - r)
      : (edge === 2 ? bounds.x + r : bounds.x + bounds.width - r);

    const targetX = rng.range(bounds.x + bounds.width * 0.2, bounds.x + bounds.width * 0.8);
    const targetY = rng.range(bounds.y + bounds.height * 0.2, bounds.y + bounds.height * 0.8);
    const startX = horizontalEdge ? centre : fixed;
    const startY = horizontalEdge ? fixed : centre;
    const angle = Math.atan2(targetY - startY, targetX - startX);

    const made: Drifter[] = [];
    for (let i = 0; i < count; i++) {
      const along = Math.min(alongMax, Math.max(alongMin, centre + (i - (count - 1) / 2) * drifters.waveSpacing));
      const x = horizontalEdge ? along : fixed;
      const y = horizontalEdge ? fixed : along;
      if (Math.hypot(x - player.x, y - player.y) < drifters.minEntryDistance) continue;
      made.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: r,
        kind,
        warningMs: drifters.warningMs + i * drifters.waveStaggerMs,
      });
    }
    if (made.length > 0) return made;
  }
  return [];
}

/** Creates a danger zone inside the playable area, away from the player, walls and other traps. */
export function spawnTrap(state: GameState, cfg: Config): Trap | null {
  const { traps } = cfg;
  const { rng, player, bounds } = state;
  const margin = traps.radius + 8;
  if (bounds.width < margin * 2 || bounds.height < margin * 2) return null;

  for (let attempt = 0; attempt < 50; attempt++) {
    const x = rng.range(bounds.x + margin, bounds.x + bounds.width - margin);
    const y = rng.range(bounds.y + margin, bounds.y + bounds.height - margin);
    if (Math.hypot(x - player.x, y - player.y) < traps.minDistanceFromPlayer + traps.radius + player.radius) continue;
    if (state.barriers.some((b) => circleHitsRect({ x, y, radius: margin }, b))) continue;
    if (state.traps.some((t) => Math.hypot(x - t.x, y - t.y) < traps.radius * 2 + 20)) continue;
    return { x, y, radius: traps.radius, warningMs: traps.warningMs, activeMs: traps.activeMs };
  }
  return null;
}

/** Creates an energy orb on open floor: not in walls, not in traps, not on the player. */
export function spawnOrb(state: GameState, cfg: Config): Orb | null {
  const { orbs } = cfg;
  const { rng, player, bounds } = state;
  const margin = orbs.radius + 12;
  if (bounds.width < margin * 2 || bounds.height < margin * 2) return null;

  for (let attempt = 0; attempt < 50; attempt++) {
    const x = rng.range(bounds.x + margin, bounds.x + bounds.width - margin);
    const y = rng.range(bounds.y + margin, bounds.y + bounds.height - margin);
    if (Math.hypot(x - player.x, y - player.y) < orbs.minDistanceFromPlayer) continue;
    if (state.barriers.some((b) => circleHitsRect({ x, y, radius: orbs.radius + 6 }, b))) continue;
    if (state.traps.some((t) => Math.hypot(x - t.x, y - t.y) < t.radius + orbs.radius + 10)) continue;
    return { x, y, radius: orbs.radius, ttlMs: orbs.lifetimeMs };
  }
  return null;
}

/** Is it fair to land the player here? Clear of walls, danger zones and moving obstacles. */
export function isSafeSpot(state: GameState, x: number, y: number, cfg: Config): boolean {
  const { abilities } = cfg;
  const { player, bounds } = state;
  const tp = abilities.teleport;
  const r = player.radius;

  if (x < bounds.x + r || x > bounds.x + bounds.width - r) return false;
  if (y < bounds.y + r || y > bounds.y + bounds.height - r) return false;
  if (state.barriers.some((b) => circleHitsRect({ x, y, radius: r + tp.safeMargin }, b))) return false;
  if (state.traps.some((t) => Math.hypot(x - t.x, y - t.y) < t.radius + r + tp.safeMargin)) return false;
  if (state.drifters.some((d) => Math.hypot(x - d.x, y - d.y) < d.radius + r + tp.obstacleClearance)) return false;
  return true;
}

/** Finds a random safe landing spot at least `minDistance` away, or null if there is none. */
export function findTeleportSpot(state: GameState, cfg: Config): { x: number; y: number } | null {
  const { abilities } = cfg;
  const { player, rng, bounds } = state;

  for (let attempt = 0; attempt < 200; attempt++) {
    const x = rng.range(bounds.x + player.radius, bounds.x + bounds.width - player.radius);
    const y = rng.range(bounds.y + player.radius, bounds.y + bounds.height - player.radius);
    if (Math.hypot(x - player.x, y - player.y) < abilities.teleport.minDistance) continue;
    if (isSafeSpot(state, x, y, cfg)) return { x, y };
  }
  return null;
}
