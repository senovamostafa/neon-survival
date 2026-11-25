import { circleHitsRect } from './collision';
import type { Config } from './config';
import type { Difficulty } from './difficulty';
import { randomCellCenter } from './maze';
import { activePlayers } from './roster';
import type { Drifter, DrifterKind, GameState, Orb, Player } from './types';

/**
 * Everything about *where* things appear. Placement is random but controlled:
 * each function rejects unfair spots (on top of a player, inside walls...)
 * and returns nothing if it cannot find a fair one, so callers simply try again later.
 *
 * Because the arena is a maze, spawns use the centre of a corridor cell (with a tiny offset
 * for orbs) rather than any random pixel, which guarantees they are in the open.
 */

const DIRECTIONS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

/** How far a circle can travel in a straight line from (x, y) before it touches a wall or leaves the arena. */
export function freeRun(
  state: GameState,
  cfg: Config,
  x: number,
  y: number,
  radius: number,
  dx: number,
  dy: number,
): number {
  const { arena } = cfg;
  const step = 6;
  let travelled = 0;
  while (travelled < 1200) {
    const nx = x + dx * (travelled + step);
    const ny = y + dy * (travelled + step);
    if (nx < arena.x || nx > arena.x + arena.width || ny < arena.y || ny > arena.y + arena.height) break;
    if (state.barriers.some((b) => circleHitsRect({ x: nx, y: ny, radius }, b))) break;
    travelled += step;
  }
  return travelled;
}

/**
 * Creates one enemy, or a wave of 2-3 appearing at once in different corridors. An enemy
 * appears at the centre of a corridor cell, aimed straight down a corridor that is open for at
 * least minTravel pixels. It starts as a harmless marker (warningMs) so players always have
 * time to react, and never closer than minEntryDistance to any player. Returns [] if nothing fit.
 */
export function spawnDrifters(state: GameState, cfg: Config, difficulty: Difficulty): Drifter[] {
  const { drifters } = cfg;
  const { rng } = state;
  const kinds = Object.keys(drifters.types) as DrifterKind[];
  const kind = kinds[rng.int(0, kinds.length - 1)];
  const spec = drifters.types[kind];
  const isWave = rng.next() < difficulty.waveChance;
  const count = isWave ? rng.int(...drifters.waveSize) : 1;

  // Everyone in a wave shares a kind and a speed.
  const speed =
    difficulty.speedMin +
    (difficulty.speedMax - difficulty.speedMin) * rng.range(spec.speedFactor[0], spec.speedFactor[1]);
  const players = activePlayers(state);

  const made: Drifter[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const at = randomCellCenter(rng, cfg);
      if (players.some((p) => Math.hypot(at.x - p.x, at.y - p.y) < drifters.minEntryDistance)) continue;
      if ([...state.drifters, ...made].some((d) => Math.hypot(at.x - d.x, at.y - d.y) < 50)) continue;
      if (state.barriers.some((b) => circleHitsRect({ x: at.x, y: at.y, radius: spec.radius }, b))) continue;

      // Try the four corridor directions in a random order and take the first long enough.
      const order = [...DIRECTIONS];
      for (let k = order.length - 1; k > 0; k--) {
        const j = rng.int(0, k);
        [order[k], order[j]] = [order[j], order[k]];
      }
      const dir = order.find((d) => freeRun(state, cfg, at.x, at.y, spec.radius, d.dx, d.dy) >= drifters.minTravel);
      if (!dir) continue;

      made.push({
        x: at.x,
        y: at.y,
        vx: dir.dx * speed,
        vy: dir.dy * speed,
        radius: spec.radius,
        kind,
        warningMs: drifters.warningMs + i * drifters.waveStaggerMs,
      });
      break;
    }
  }
  return made;
}

/** Creates an energy orb in a corridor: not in a wall, not on a player. */
export function spawnOrb(state: GameState, cfg: Config): Orb | null {
  const { orbs } = cfg;
  const { rng } = state;
  const players = activePlayers(state);

  for (let attempt = 0; attempt < 50; attempt++) {
    const c = randomCellCenter(rng, cfg);
    // A small offset so orbs are not all dead centre, small enough to stay clear of the walls.
    const x = c.x + rng.range(-6, 6);
    const y = c.y + rng.range(-6, 6);
    if (players.some((p) => Math.hypot(x - p.x, y - p.y) < orbs.minDistanceFromPlayer)) continue;
    if (state.barriers.some((b) => circleHitsRect({ x, y, radius: orbs.radius + 6 }, b))) continue;
    return { x, y, radius: orbs.radius, ttlMs: orbs.lifetimeMs };
  }
  return null;
}

/** Is it fair to put a hero of this size here? Clear of walls and enemies. */
export function isSafeSpot(state: GameState, x: number, y: number, radius: number, cfg: Config): boolean {
  const { arena, abilities } = cfg;
  const tp = abilities.teleport;

  if (x < arena.x + radius || x > arena.x + arena.width - radius) return false;
  if (y < arena.y + radius || y > arena.y + arena.height - radius) return false;
  if (state.barriers.some((b) => circleHitsRect({ x, y, radius: radius + tp.safeMargin }, b))) return false;
  if (state.drifters.some((d) => Math.hypot(x - d.x, y - d.y) < d.radius + radius + tp.obstacleClearance)) return false;
  return true;
}

/** Finds a random safe landing spot at least `minDistance` from the player, or null if there is none. */
export function findTeleportSpot(state: GameState, player: Player, cfg: Config): { x: number; y: number } | null {
  const { rng } = state;

  for (let attempt = 0; attempt < 200; attempt++) {
    const c = randomCellCenter(rng, cfg);
    if (Math.hypot(c.x - player.x, c.y - player.y) < cfg.abilities.teleport.minDistance) continue;
    if (isSafeSpot(state, c.x, c.y, player.radius, cfg)) return c;
  }
  return null;
}

/** Where a returning player appears: a safe corridor cell, not right next to anyone else. */
export function findRespawnSpot(state: GameState, player: Player, cfg: Config): { x: number; y: number } {
  const { rng } = state;
  const others = activePlayers(state).filter((p) => p.id !== player.id);

  for (let attempt = 0; attempt < 200; attempt++) {
    const c = randomCellCenter(rng, cfg);
    if (others.some((o) => Math.hypot(c.x - o.x, c.y - o.y) < 60)) continue;
    if (isSafeSpot(state, c.x, c.y, player.radius, cfg)) return c;
  }
  return randomCellCenter(rng, cfg);
}
