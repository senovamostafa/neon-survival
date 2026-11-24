import { CONFIG, type Config } from './config';
import { circleHitsCircle, clamp } from './collision';
import { Rng } from './rng';

/**
 * The whole game rules, with no Phaser and no browser code in here.
 * That keeps it fast to test and lets us reuse it anywhere later.
 *
 * Usage: createGame(seed) -> startRun(state) -> call stepGame() on a fixed timestep.
 */

export type GameStatus = 'ready' | 'playing' | 'gameover';

export interface Hazard {
  x: number;
  y: number;
  vx: number; // px per second
  vy: number;
  radius: number;
}

export interface Player {
  x: number;
  y: number;
  radius: number;
  lives: number;
  /** Remaining invulnerability after a hit, in ms. 0 = can be hit. */
  invulnerableMs: number;
}

export interface GameState {
  status: GameStatus;
  /** Survival time in ms. Only counts while status is 'playing'. */
  timeMs: number;
  player: Player;
  hazards: Hazard[];
  readonly seed: number;
  readonly rng: Rng;
}

/** Movement intent for one step: each axis is -1, 0 or 1. */
export interface InputState {
  dx: number;
  dy: number;
}

/** What happened during a step, so the renderer can react (flash, sound, etc.). */
export interface StepResult {
  hit: boolean;
  gameOver: boolean;
}

const NO_EVENTS: StepResult = { hit: false, gameOver: false };

export function createGame(seed: number, cfg: Config = CONFIG): GameState {
  const rng = new Rng(seed);
  const { arena } = cfg;
  const player: Player = {
    x: arena.x + arena.width / 2,
    y: arena.y + arena.height / 2,
    radius: cfg.player.radius,
    lives: cfg.player.lives,
    invulnerableMs: 0,
  };

  const hazards: Hazard[] = [];
  for (let i = 0; i < cfg.hazard.count; i++) {
    hazards.push(spawnHazard(rng, player, cfg));
  }

  return { status: 'ready', timeMs: 0, player, hazards, seed, rng };
}

/** Leaves the 'ready' screen and starts the clock. */
export function startRun(state: GameState): void {
  if (state.status === 'ready') state.status = 'playing';
}

/** Advances the game by one fixed step. Does nothing unless the game is playing. */
export function stepGame(
  state: GameState,
  input: InputState,
  dtMs: number,
  cfg: Config = CONFIG,
): StepResult {
  if (state.status !== 'playing') return NO_EVENTS;

  const dt = dtMs / 1000;
  const { arena } = cfg;
  const p = state.player;

  if (p.invulnerableMs > 0) p.invulnerableMs = Math.max(0, p.invulnerableMs - dtMs);

  // Player movement. Normalising makes diagonals exactly as fast as straight lines.
  const length = Math.hypot(input.dx, input.dy);
  if (length > 0) {
    p.x += (input.dx / length) * cfg.player.speed * dt;
    p.y += (input.dy / length) * cfg.player.speed * dt;
  }
  p.x = clamp(p.x, arena.x + p.radius, arena.x + arena.width - p.radius);
  p.y = clamp(p.y, arena.y + p.radius, arena.y + arena.height - p.radius);

  for (const h of state.hazards) moveAndBounce(h, dt, cfg);

  state.timeMs += dtMs;

  // Collision with hazards. Only one life can be lost per step, and none while invulnerable.
  if (p.invulnerableMs <= 0 && state.hazards.some((h) => circleHitsCircle(p, h))) {
    p.lives--;
    if (p.lives <= 0) {
      p.lives = 0;
      state.status = 'gameover';
      return { hit: true, gameOver: true };
    }
    p.invulnerableMs = cfg.player.invulnerableMs;
    return { hit: true, gameOver: false };
  }

  return NO_EVENTS;
}

function moveAndBounce(h: Hazard, dt: number, cfg: Config): void {
  const { arena } = cfg;
  h.x += h.vx * dt;
  h.y += h.vy * dt;

  const minX = arena.x + h.radius;
  const maxX = arena.x + arena.width - h.radius;
  const minY = arena.y + h.radius;
  const maxY = arena.y + arena.height - h.radius;

  if (h.x < minX) { h.x = minX; h.vx = Math.abs(h.vx); }
  else if (h.x > maxX) { h.x = maxX; h.vx = -Math.abs(h.vx); }
  if (h.y < minY) { h.y = minY; h.vy = Math.abs(h.vy); }
  else if (h.y > maxY) { h.y = maxY; h.vy = -Math.abs(h.vy); }
}

/** Places a hazard at a random spot that is never too close to the player. */
function spawnHazard(rng: Rng, player: Player, cfg: Config): Hazard {
  const { arena, hazard } = cfg;
  const minX = arena.x + hazard.radius;
  const maxX = arena.x + arena.width - hazard.radius;
  const minY = arena.y + hazard.radius;
  const maxY = arena.y + arena.height - hazard.radius;

  let x = minX;
  let y = minY;
  for (let attempt = 0; attempt < 100; attempt++) {
    x = rng.range(minX, maxX);
    y = rng.range(minY, maxY);
    if (Math.hypot(x - player.x, y - player.y) >= hazard.minSpawnDistance) break;
  }

  // Avoid near-horizontal/vertical paths, which look boring and are easy to camp.
  const angle = rng.range(0.3, Math.PI / 2 - 0.3) + rng.int(0, 3) * (Math.PI / 2);
  return {
    x,
    y,
    vx: Math.cos(angle) * hazard.speed,
    vy: Math.sin(angle) * hazard.speed,
    radius: hazard.radius,
  };
}
