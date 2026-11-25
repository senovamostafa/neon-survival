import { CONFIG, type Config } from './config';
import { circleHitsCircle, circleHitsRect, clamp, pushCircleOutOfRect } from './collision';
import { getDifficulty } from './difficulty';
import {
  applyBumps,
  createPlayer,
  killPlayer,
  respawnPlayer,
  spawnPositions,
  type RosterEntry,
} from './players';
import { mazeForSector, mazeToBarriers, snapToDistinctCells } from './maze';
import { Rng } from './rng';
import { activePlayers, isActive, presentPlayers } from './roster';
import { spawnDrifters, spawnOrb } from './spawn';
import type { GameState, InputMap, InputState, StepResult } from './types';

/**
 * The whole game rules, with no Phaser and no browser code in here, so the same code can run
 * in the browser and later on the game server.
 *
 * Usage: createMatch(seed, roster) -> startRun(state) -> call stepGame() on a fixed timestep
 * with every player's input, and activateAbility() (abilities.ts) when someone presses an
 * ability key. The match ends by itself after cfg.match.durationMs.
 */

const IDLE: InputState = { dx: 0, dy: 0 };

export function createMatch(seed: number, roster: RosterEntry[], cfg: Config = CONFIG): GameState {
  const rng = new Rng(seed);
  const maze = mazeForSector(rng, cfg, 0);
  // Everyone starts in the middle of a different corridor cell, never inside a wall.
  const positions = snapToDistinctCells(spawnPositions(roster.length, rng, cfg), cfg);
  const players = roster.map((entry, i) => createPlayer(entry, i, positions[i], cfg));

  return {
    status: 'ready',
    timeMs: 0,
    players,
    drifters: [],
    orbs: [],
    maze,
    barriers: mazeToBarriers(maze, cfg, 0),
    sector: 0,
    spawn: {
      drifterMs: cfg.drifters.firstSpawnMs,
      orbMs: cfg.orbs.firstSpawnMs,
    },
    bumpCooldowns: {},
    seed,
    rng,
  };
}

/** Leaves the 'ready' state and starts the clock. */
export function startRun(state: GameState): void {
  if (state.status === 'ready') state.status = 'playing';
}

/** Advances the match by one fixed step. Does nothing unless the match is playing. */
export function stepGame(
  state: GameState,
  inputs: InputMap,
  dtMs: number,
  cfg: Config = CONFIG,
): StepResult {
  const result: StepResult = {
    hits: [],
    shieldBlocks: [],
    pickups: [],
    deaths: [],
    respawns: [],
    bumps: [],
    wallHits: [],
    finished: false,
  };
  if (state.status !== 'playing') return result;

  const dt = dtMs / 1000;

  tickTimers(state, dtMs, cfg, result);
  updateBarriers(state, dtMs, cfg);
  movePlayers(state, inputs, dt, dtMs, cfg);
  applyBumps(state, cfg, result);
  spawnThings(state, dtMs, cfg);
  updateDrifters(state, dt, dtMs, cfg, result);
  updateOrbs(state, dt, dtMs, cfg, result);
  state.timeMs += dtMs;
  updateSector(state, cfg);
  checkDamage(state, cfg, result);

  if (state.timeMs >= cfg.match.durationMs) {
    state.status = 'finished';
    result.finished = true;
  }
  return result;
}

/** Counts down invulnerability, abilities, respawns, away timers and bump cooldowns. */
function tickTimers(state: GameState, dtMs: number, cfg: Config, result: StepResult): void {
  for (const p of state.players) {
    if (!p.present) continue;

    if (!p.connected) {
      p.awayMs += dtMs;
      if (p.awayMs >= cfg.player.awayRemoveMs) {
        p.present = false;
        continue;
      }
    }

    p.invulnerableMs = Math.max(0, p.invulnerableMs - dtMs);
    for (const ability of Object.values(p.abilities)) {
      ability.activeMs = Math.max(0, ability.activeMs - dtMs);
      ability.cooldownMs = Math.max(0, ability.cooldownMs - dtMs);
    }

    if (!p.alive) {
      p.respawnMs -= dtMs;
      if (p.respawnMs <= 0) {
        respawnPlayer(state, p, cfg);
        result.respawns.push({ playerId: p.id });
      }
    }
  }

  for (const key of Object.keys(state.bumpCooldowns)) {
    state.bumpCooldowns[key] -= dtMs;
    if (state.bumpCooldowns[key] <= 0) delete state.bumpCooldowns[key];
  }
}

/**
 * Walls that are still showing their warning turn solid when it ends, unless a player is
 * standing there. In that case they wait, so a wall can never appear on top of anyone.
 */
function updateBarriers(state: GameState, dtMs: number, cfg: Config): void {
  const players = activePlayers(state);
  for (const b of state.barriers) {
    if (b.warningMs <= 0) continue;
    b.warningMs = Math.max(0, b.warningMs - dtMs);
    const blocked = players.some((p) => circleHitsRect({ x: p.x, y: p.y, radius: p.radius + 6 }, b));
    if (b.warningMs === 0 && blocked) b.warningMs = cfg.timestep.stepMs; // wait one more step
  }
}

function movePlayers(state: GameState, inputs: InputMap, dt: number, dtMs: number, cfg: Config): void {
  const { arena } = cfg;

  for (const p of activePlayers(state)) {
    const input = inputs[p.id] ?? IDLE;

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
      for (const barrier of state.barriers) {
        if (barrier.warningMs <= 0) pushCircleOutOfRect(p, barrier);
      }
      p.x = clamp(p.x, arena.x + p.radius, arena.x + arena.width - p.radius);
      p.y = clamp(p.y, arena.y + p.radius, arena.y + arena.height - p.radius);
    }
  }
}

/** Larger rooms get more obstacles, and spawn them a little faster. */
function hazardScale(playerCount: number, cfg: Config): number {
  const extra = Math.max(0, playerCount - cfg.scaling.referencePlayers);
  return 1 + cfg.scaling.hazardPerExtraPlayer * extra;
}

/** Counts down the spawn timers and creates new obstacles and orbs. */
function spawnThings(state: GameState, dtMs: number, cfg: Config): void {
  const { rng } = state;
  const s = state.spawn;
  const here = presentPlayers(state).length;
  const scale = hazardScale(here, cfg);
  const orbPlayers = Math.max(here, cfg.scaling.referencePlayers);
  const difficulty = getDifficulty(state.timeMs, cfg);
  const maxDrifters = Math.round(difficulty.maxDrifters * scale);
  const jitter = cfg.difficulty.jitter;

  s.drifterMs -= dtMs;
  s.orbMs -= dtMs;

  if (s.drifterMs <= 0) {
    const made = state.drifters.length < maxDrifters
      ? spawnDrifters(state, cfg, difficulty)
      : [];
    for (const drifter of made) {
      if (state.drifters.length < maxDrifters) state.drifters.push(drifter);
    }
    // retry soon if nothing fit
    s.drifterMs = made.length > 0
      ? (difficulty.drifterIntervalMs / scale) * rng.range(1 - jitter, 1 + jitter)
      : 300;
  }
  if (s.orbMs <= 0) {
    const cap = cfg.orbs.maxPerPlayer * orbPlayers;
    const orb = state.orbs.length < cap ? spawnOrb(state, cfg) : null;
    if (orb) state.orbs.push(orb);
    s.orbMs = orb
      ? (cfg.orbs.gapPerPlayerMs / orbPlayers) * rng.range(1 - cfg.orbs.jitter, 1 + cfg.orbs.jitter)
      : 1000;
  }
}

function updateDrifters(state: GameState, dt: number, dtMs: number, cfg: Config, result: StepResult): void {
  const { arena } = cfg;
  const slowers = activePlayers(state).filter((p) => p.abilities.slow.activeMs > 0);
  const slow = cfg.abilities.slow;

  for (const d of state.drifters) {
    if (d.warningMs > 0) {
      d.warningMs = Math.max(0, d.warningMs - dtMs); // the warning is never slowed
      continue;
    }
    // Obstacles inside any slow-motion zone move slower; everyone else is unaffected.
    const slowed = slowers.some((p) => Math.hypot(d.x - p.x, d.y - p.y) <= slow.radius);
    const factor = slowed ? slow.factor : 1;
    d.x += d.vx * dt * factor;
    d.y += d.vy * dt * factor;
  }

  // An enemy that flies into a solid wall vanishes, so walls work as cover.
  const walls = state.barriers.filter((b) => b.warningMs <= 0);
  const survivors: GameState['drifters'] = [];
  for (const d of state.drifters) {
    if (d.warningMs <= 0 && walls.some((w) => circleHitsRect(d, w))) {
      result.wallHits.push({ x: d.x, y: d.y });
      continue;
    }
    survivors.push(d);
  }

  // Enemies that have left the arena are removed too.
  const leeway = 8;
  state.drifters = survivors.filter(
    (d) =>
      d.x > arena.x - d.radius - leeway &&
      d.x < arena.x + arena.width + d.radius + leeway &&
      d.y > arena.y - d.radius - leeway &&
      d.y < arena.y + arena.height + d.radius + leeway,
  );
}

/**
 * Magnets pull orbs toward their owner (a way to steal from rivals). When an orb touches
 * several players in the same step, the nearest one gets it.
 */
function updateOrbs(state: GameState, dt: number, dtMs: number, cfg: Config, result: StepResult): void {
  const players = activePlayers(state);
  const magnet = cfg.abilities.magnet;
  const magnets = players.filter((p) => p.abilities.magnet.activeMs > 0);

  for (const orb of state.orbs) {
    orb.ttlMs -= dtMs;
    if (magnets.length === 0) continue;

    let puller: (typeof players)[number] | null = null;
    let nearest = Infinity;
    for (const p of magnets) {
      const d = Math.hypot(p.x - orb.x, p.y - orb.y);
      if (d < magnet.radius && d < nearest) {
        puller = p;
        nearest = d;
      }
    }
    if (puller && nearest > 0) {
      const move = Math.min(nearest, magnet.pullSpeed * dt);
      orb.x += ((puller.x - orb.x) / nearest) * move;
      orb.y += ((puller.y - orb.y) / nearest) * move;
    }
  }

  const remaining: GameState['orbs'] = [];
  for (const orb of state.orbs) {
    let taker: (typeof players)[number] | null = null;
    let nearest = Infinity;
    for (const p of players) {
      const d = Math.hypot(p.x - orb.x, p.y - orb.y);
      if (d < p.radius + orb.radius + 2 && d < nearest) {
        taker = p;
        nearest = d;
      }
    }

    if (taker) {
      taker.energy = Math.min(cfg.energy.max, taker.energy + cfg.energy.perOrb);
      taker.orbs++;
      taker.lastOrbAtMs = state.timeMs + dtMs; // the time at the end of this step
      result.pickups.push({ playerId: taker.id, x: orb.x, y: orb.y });
    } else if (orb.ttlMs > 0) {
      remaining.push(orb);
    }
  }
  state.orbs = remaining;
}

/**
 * Every sector (60 s) the arena transforms: the old maze vanishes and a brand new one, with
 * more walls than the last, appears as outlines that turn solid after a short warning. A
 * wall waits if someone is standing where it would appear. The renderer swaps the colour theme.
 */
function updateSector(state: GameState, cfg: Config): void {
  const sector = Math.floor(state.timeMs / cfg.transform.everyMs);
  if (sector <= state.sector) return;
  state.sector = sector;
  state.maze = mazeForSector(state.rng, cfg, sector);
  state.barriers = mazeToBarriers(state.maze, cfg, cfg.transform.barrierWarningMs);
  // Orbs that ended up inside the new walls would be unreachable.
  state.orbs = state.orbs.filter((o) => !state.barriers.some((b) => circleHitsRect({ x: o.x, y: o.y, radius: o.radius + 2 }, b)));
}

/** Applies damage from moving obstacles to each player, honouring shield and invulnerability. */
function checkDamage(state: GameState, cfg: Config, result: StepResult): void {
  for (const p of state.players) {
    if (!isActive(p) || p.invulnerableMs > 0) continue;
    if (!state.drifters.some((d) => d.warningMs <= 0 && circleHitsCircle(p, d))) continue;

    const shield = p.abilities.shield;
    if (shield.activeMs > 0) {
      shield.activeMs = 0; // one hit pops the shield
      p.invulnerableMs = cfg.abilities.shield.blockInvulnerableMs;
      result.shieldBlocks.push({ playerId: p.id });
      continue;
    }

    p.lives--;
    result.hits.push({ playerId: p.id });
    if (p.lives <= 0) {
      killPlayer(p, cfg);
      result.deaths.push({ playerId: p.id });
    } else {
      p.invulnerableMs = cfg.player.invulnerableMs;
    }
  }
}
