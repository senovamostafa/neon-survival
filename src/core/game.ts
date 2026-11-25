import { CONFIG, type Config } from './config';
import { circleHitsCircle, circleHitsRect, clamp, pushCircleOutOfRect } from './collision';
import { getDifficulty } from './difficulty';
import { computeBounds, firstEventDelay, gravityPush, isEventActive, updateEvent } from './events';
import { Rng } from './rng';
import { placeBarriers, spawnDrifters, spawnOrb, spawnTrap } from './spawn';
import type { AbilityId, GameState, InputState, StepResult } from './types';

/**
 * The whole game rules, with no Phaser and no browser code in here.
 * That keeps it fast to test and lets us reuse it anywhere later.
 *
 * Usage: createGame(seed) -> startRun(state) -> call stepGame() on a fixed timestep,
 * and activateAbility() (abilities.ts) whenever the player presses an ability key.
 */

export function createGame(seed: number, cfg: Config = CONFIG): GameState {
  const rng = new Rng(seed);
  const { arena } = cfg;
  const player = {
    x: arena.x + arena.width / 2,
    y: arena.y + arena.height / 2,
    radius: cfg.player.radius,
    lives: cfg.player.lives,
    invulnerableMs: 0,
  };
  const idle = () => ({ activeMs: 0, cooldownMs: 0 });
  const abilities: Record<AbilityId, { activeMs: number; cooldownMs: number }> = {
    shield: idle(),
    slow: idle(),
    teleport: idle(),
    magnet: idle(),
  };

  return {
    status: 'ready',
    timeMs: 0,
    player,
    drifters: [],
    traps: [],
    orbs: [],
    barriers: placeBarriers(rng, player, cfg, cfg.barriers.count, 0),
    bounds: { ...arena },
    event: null,
    nextEventMs: firstEventDelay(rng, cfg),
    lastEventKind: null,
    sector: 0,
    energy: 0,
    orbsCollected: 0,
    abilities,
    spawn: {
      drifterMs: cfg.drifters.firstSpawnMs,
      trapMs: cfg.traps.firstSpawnMs,
      orbMs: cfg.orbs.firstSpawnMs,
    },
    seed,
    rng,
  };
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
  const result: StepResult = { hit: false, shieldBlocked: false, pickups: [], gameOver: false };
  if (state.status !== 'playing') return result;

  const dt = dtMs / 1000;

  tickTimers(state, dtMs);
  updateEvent(state, dtMs, cfg);
  state.bounds = computeBounds(state, cfg);
  updateBarriers(state, dtMs, cfg);
  movePlayer(state, input, dt, cfg);
  spawnThings(state, dtMs, cfg);
  updateDrifters(state, dt, dtMs, cfg);
  updateTraps(state, dtMs);
  updateOrbs(state, dt, dtMs, cfg, result);
  state.timeMs += dtMs;
  updateSector(state, cfg);
  checkDamage(state, cfg, result);

  return result;
}

function tickTimers(state: GameState, dtMs: number): void {
  const p = state.player;
  p.invulnerableMs = Math.max(0, p.invulnerableMs - dtMs);
  for (const ability of Object.values(state.abilities)) {
    ability.activeMs = Math.max(0, ability.activeMs - dtMs);
    ability.cooldownMs = Math.max(0, ability.cooldownMs - dtMs);
  }
}

/**
 * Walls that are still showing their warning turn solid when it ends, unless the player is
 * standing there. In that case they wait, so a wall can never appear on top of you.
 */
function updateBarriers(state: GameState, dtMs: number, cfg: Config): void {
  const p = state.player;
  for (const b of state.barriers) {
    if (b.warningMs <= 0) continue;
    b.warningMs = Math.max(0, b.warningMs - dtMs);
    const blocked = circleHitsRect({ x: p.x, y: p.y, radius: p.radius + 6 }, b);
    if (b.warningMs === 0 && blocked) b.warningMs = cfg.timestep.stepMs; // wait one more step
  }
}

function movePlayer(state: GameState, input: InputState, dt: number, cfg: Config): void {
  const p = state.player;
  const { bounds } = state;

  // Normalising makes diagonals exactly as fast as straight lines.
  const length = Math.hypot(input.dx, input.dy);
  if (length > 0) {
    p.x += (input.dx / length) * cfg.player.speed * dt;
    p.y += (input.dy / length) * cfg.player.speed * dt;
  }

  // Gravity shift: a steady push on top of whatever the player does.
  const push = gravityPush(state, cfg);
  p.x += push.x * dt;
  p.y += push.y * dt;

  // Solid walls push the player out; the arena edge (which can shrink) keeps them inside.
  // Two passes so corners and squeezes settle cleanly.
  for (let pass = 0; pass < 2; pass++) {
    for (const barrier of state.barriers) {
      if (barrier.warningMs <= 0) pushCircleOutOfRect(p, barrier);
    }
    p.x = clamp(p.x, bounds.x + p.radius, bounds.x + bounds.width - p.radius);
    p.y = clamp(p.y, bounds.y + p.radius, bounds.y + bounds.height - p.radius);
  }
}

/** Counts down the spawn timers and creates new obstacles, traps and orbs. */
function spawnThings(state: GameState, dtMs: number, cfg: Config): void {
  const { rng } = state;
  const s = state.spawn;
  const difficulty = getDifficulty(state.timeMs, cfg);
  const jitter = cfg.difficulty.jitter;
  // During a blackout or a shrinking arena, things spawn less often to keep it fair.
  const calm =
    isEventActive(state, 'blackout') || isEventActive(state, 'shrink')
      ? cfg.events.spawnIntervalFactor
      : 1;
  const nextGap = (typicalMs: number): number => typicalMs * rng.range(1 - jitter, 1 + jitter) * calm;

  s.drifterMs -= dtMs;
  s.trapMs -= dtMs;
  s.orbMs -= dtMs;

  if (s.drifterMs <= 0) {
    const made = state.drifters.length < difficulty.maxDrifters
      ? spawnDrifters(rng, state.player, cfg, state.bounds, difficulty)
      : [];
    for (const drifter of made) {
      if (state.drifters.length < difficulty.maxDrifters) state.drifters.push(drifter);
    }
    s.drifterMs = made.length > 0 ? nextGap(difficulty.drifterIntervalMs) : 300; // retry soon if nothing fit
  }
  if (s.trapMs <= 0) {
    const trap = state.traps.length < difficulty.maxTraps ? spawnTrap(state, cfg) : null;
    if (trap) state.traps.push(trap);
    s.trapMs = trap ? nextGap(difficulty.trapIntervalMs) : 1000;
  }
  if (s.orbMs <= 0) {
    const orb = state.orbs.length < cfg.orbs.max ? spawnOrb(state, cfg) : null;
    if (orb) state.orbs.push(orb);
    s.orbMs = orb ? rng.range(...cfg.orbs.intervalMs) : 1000;
  }
}

function updateDrifters(state: GameState, dt: number, dtMs: number, cfg: Config): void {
  const { arena } = cfg;
  const speedFactor = state.abilities.slow.activeMs > 0 ? cfg.abilities.slow.factor : 1;

  for (const d of state.drifters) {
    if (d.warningMs > 0) {
      d.warningMs = Math.max(0, d.warningMs - dtMs); // the warning is never slowed
    } else {
      d.x += d.vx * dt * speedFactor;
      d.y += d.vy * dt * speedFactor;
    }
  }

  // Remove obstacles that have left the full arena.
  const leeway = 8;
  state.drifters = state.drifters.filter(
    (d) =>
      d.x > arena.x - d.radius - leeway &&
      d.x < arena.x + arena.width + d.radius + leeway &&
      d.y > arena.y - d.radius - leeway &&
      d.y < arena.y + arena.height + d.radius + leeway,
  );
}

function updateTraps(state: GameState, dtMs: number): void {
  for (const trap of state.traps) {
    if (trap.warningMs > 0) trap.warningMs = Math.max(0, trap.warningMs - dtMs);
    else trap.activeMs = Math.max(0, trap.activeMs - dtMs);
  }
  state.traps = state.traps.filter((t) => t.warningMs > 0 || t.activeMs > 0);
}

function updateOrbs(state: GameState, dt: number, dtMs: number, cfg: Config, result: StepResult): void {
  const p = state.player;
  const magnet = cfg.abilities.magnet;
  const magnetOn = state.abilities.magnet.activeMs > 0;

  for (const orb of state.orbs) {
    orb.ttlMs -= dtMs;
    if (!magnetOn) continue;
    const dx = p.x - orb.x;
    const dy = p.y - orb.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0 && dist < magnet.radius) {
      const move = Math.min(dist, magnet.pullSpeed * dt);
      orb.x += (dx / dist) * move;
      orb.y += (dy / dist) * move;
    }
  }

  const remaining: GameState['orbs'] = [];
  for (const orb of state.orbs) {
    if (circleHitsCircle(p, { x: orb.x, y: orb.y, radius: orb.radius + 2 })) {
      state.energy = Math.min(cfg.energy.max, state.energy + cfg.energy.perOrb);
      state.orbsCollected++;
      result.pickups.push({ x: orb.x, y: orb.y });
    } else if (orb.ttlMs > 0) {
      remaining.push(orb);
    }
  }
  state.orbs = remaining;
}

/**
 * Every sector (60 s) the arena transforms: the old walls vanish and a new set, one wall
 * larger, appears as outlines that turn solid after a short warning. That also changes
 * which parts of the arena are safe to stand in. The renderer swaps the colour theme.
 */
function updateSector(state: GameState, cfg: Config): void {
  const sector = Math.floor(state.timeMs / cfg.transform.everyMs);
  if (sector <= state.sector) return;
  state.sector = sector;
  const count = Math.min(cfg.transform.maxBarriers, cfg.barriers.count + sector);
  state.barriers = placeBarriers(state.rng, state.player, cfg, count, cfg.transform.barrierWarningMs);
}

/** Applies damage from moving obstacles and active traps, honouring the shield and invulnerability. */
function checkDamage(state: GameState, cfg: Config, result: StepResult): void {
  const p = state.player;
  if (p.invulnerableMs > 0) return;

  const touchingDrifter = state.drifters.some((d) => d.warningMs <= 0 && circleHitsCircle(p, d));
  const touchingTrap = state.traps.some((t) => t.warningMs <= 0 && t.activeMs > 0 && circleHitsCircle(p, t));
  if (!touchingDrifter && !touchingTrap) return;

  const shield = state.abilities.shield;
  if (shield.activeMs > 0) {
    shield.activeMs = 0; // one hit pops the shield
    p.invulnerableMs = cfg.abilities.shield.blockInvulnerableMs;
    result.shieldBlocked = true;
    return;
  }

  p.lives--;
  result.hit = true;
  if (p.lives <= 0) {
    p.lives = 0;
    state.status = 'gameover';
    result.gameOver = true;
  } else {
    p.invulnerableMs = cfg.player.invulnerableMs;
  }
}
