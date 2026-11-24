import { circleHitsRect, rectsTooClose, type Circle, type Rect } from './collision';
import type { Config } from './config';
import type { Rng } from './rng';
import type { Drifter, DrifterKind, GameState, Orb, Trap } from './types';

/**
 * Everything about *where* things appear. Placement is random but controlled:
 * each function rejects unfair spots (on top of the player, inside walls...)
 * and returns null if it cannot find a fair one, so callers simply try again later.
 */

/** Picks wall positions once at the start of a run. Walls never touch each other or the border. */
export function placeBarriers(rng: Rng, player: Circle, cfg: Config): Rect[] {
  const { arena, barriers } = cfg;
  const placed: Rect[] = [];

  for (let i = 0; i < barriers.count; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const size = barriers.sizes[rng.int(0, barriers.sizes.length - 1)];
      const rect: Rect = {
        x: rng.range(arena.x + barriers.wallMargin, arena.x + arena.width - barriers.wallMargin - size.width),
        y: rng.range(arena.y + barriers.wallMargin, arena.y + arena.height - barriers.wallMargin - size.height),
        width: size.width,
        height: size.height,
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
 * Creates a moving obstacle at a random edge of the arena, aimed at the middle area.
 * It starts as a harmless marker (warningMs) so the player always has time to react.
 */
export function spawnDrifter(rng: Rng, player: Circle, cfg: Config): Drifter | null {
  const { arena, drifters } = cfg;
  const kinds = Object.keys(drifters.types) as DrifterKind[];
  const kind = kinds[rng.int(0, kinds.length - 1)];
  const spec = drifters.types[kind];
  const r = spec.radius;

  for (let attempt = 0; attempt < 20; attempt++) {
    const edge = rng.int(0, 3); // 0 top, 1 bottom, 2 left, 3 right
    let x: number;
    let y: number;
    if (edge < 2) {
      x = rng.range(arena.x + r, arena.x + arena.width - r);
      y = edge === 0 ? arena.y + r : arena.y + arena.height - r;
    } else {
      y = rng.range(arena.y + r, arena.y + arena.height - r);
      x = edge === 2 ? arena.x + r : arena.x + arena.width - r;
    }
    if (Math.hypot(x - player.x, y - player.y) < drifters.minEntryDistance) continue;

    const targetX = rng.range(arena.x + arena.width * 0.2, arena.x + arena.width * 0.8);
    const targetY = rng.range(arena.y + arena.height * 0.2, arena.y + arena.height * 0.8);
    const angle = Math.atan2(targetY - y, targetX - x);
    const speed = rng.range(spec.speed[0], spec.speed[1]);
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: r,
      kind,
      warningMs: drifters.warningMs,
    };
  }
  return null;
}

/** Creates a danger zone away from the player, the walls and other traps. */
export function spawnTrap(state: GameState, cfg: Config): Trap | null {
  const { arena, traps } = cfg;
  const { rng, player } = state;
  const margin = traps.radius + 8;

  for (let attempt = 0; attempt < 50; attempt++) {
    const x = rng.range(arena.x + margin, arena.x + arena.width - margin);
    const y = rng.range(arena.y + margin, arena.y + arena.height - margin);
    if (Math.hypot(x - player.x, y - player.y) < traps.minDistanceFromPlayer + traps.radius + player.radius) continue;
    if (state.barriers.some((b) => circleHitsRect({ x, y, radius: margin }, b))) continue;
    if (state.traps.some((t) => Math.hypot(x - t.x, y - t.y) < traps.radius * 2 + 20)) continue;
    return { x, y, radius: traps.radius, warningMs: traps.warningMs, activeMs: traps.activeMs };
  }
  return null;
}

/** Creates an energy orb on open floor: not in walls, not in traps, not on the player. */
export function spawnOrb(state: GameState, cfg: Config): Orb | null {
  const { arena, orbs } = cfg;
  const { rng, player } = state;
  const margin = orbs.radius + 12;

  for (let attempt = 0; attempt < 50; attempt++) {
    const x = rng.range(arena.x + margin, arena.x + arena.width - margin);
    const y = rng.range(arena.y + margin, arena.y + arena.height - margin);
    if (Math.hypot(x - player.x, y - player.y) < orbs.minDistanceFromPlayer) continue;
    if (state.barriers.some((b) => circleHitsRect({ x, y, radius: orbs.radius + 6 }, b))) continue;
    if (state.traps.some((t) => Math.hypot(x - t.x, y - t.y) < t.radius + orbs.radius + 10)) continue;
    return { x, y, radius: orbs.radius, ttlMs: orbs.lifetimeMs };
  }
  return null;
}

/** Is it fair to land the player here? Clear of walls, danger zones and moving obstacles. */
export function isSafeSpot(state: GameState, x: number, y: number, cfg: Config): boolean {
  const { arena, abilities } = cfg;
  const { player } = state;
  const tp = abilities.teleport;
  const r = player.radius;

  if (x < arena.x + r || x > arena.x + arena.width - r) return false;
  if (y < arena.y + r || y > arena.y + arena.height - r) return false;
  if (state.barriers.some((b) => circleHitsRect({ x, y, radius: r + tp.safeMargin }, b))) return false;
  if (state.traps.some((t) => Math.hypot(x - t.x, y - t.y) < t.radius + r + tp.safeMargin)) return false;
  if (state.drifters.some((d) => Math.hypot(x - d.x, y - d.y) < d.radius + r + tp.obstacleClearance)) return false;
  return true;
}

/** Finds a random safe landing spot at least `minDistance` away, or null if there is none. */
export function findTeleportSpot(state: GameState, cfg: Config): { x: number; y: number } | null {
  const { arena, abilities } = cfg;
  const { player, rng } = state;

  for (let attempt = 0; attempt < 200; attempt++) {
    const x = rng.range(arena.x + player.radius, arena.x + arena.width - player.radius);
    const y = rng.range(arena.y + player.radius, arena.y + arena.height - player.radius);
    if (Math.hypot(x - player.x, y - player.y) < abilities.teleport.minDistance) continue;
    if (isSafeSpot(state, x, y, cfg)) return { x, y };
  }
  return null;
}
