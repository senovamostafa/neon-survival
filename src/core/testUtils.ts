import { CONFIG, type Config } from './config';
import { createMatch, startRun, stepGame } from './game';
import type { Drifter, GameState, InputState, Player, StepResult } from './types';

/**
 * Helpers for tests only.
 * A "quiet" game has no walls, obstacles or orbs and nothing spawns on its own
 * (no sector changes within a test), so a test can add exactly the pieces it wants.
 * Players are called p1, p2, ... and p1 is the one most tests care about.
 */

export const STEP_MS = CONFIG.timestep.stepMs;

export function roster(count: number): { id: string; name: string }[] {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
}

/** A real match setup with one player (walls, spawns and timers as in a normal game). */
export function soloMatch(seed = 1, cfg: Config = CONFIG): GameState {
  return createMatch(seed, roster(1), cfg);
}

export function quietGame(seed = 1, cfg: Config = CONFIG, playerCount = 1): GameState {
  const state = createMatch(seed, roster(playerCount), cfg);
  state.barriers = [];
  state.drifters = [];
  state.orbs = [];
  state.spawn = { drifterMs: 1e12, orbMs: 1e12 };
  startRun(state);
  return state;
}

/** The first player. */
export function me(state: GameState): Player {
  return state.players[0];
}

/** One fixed step where only p1 has input. */
export function step(state: GameState, input: InputState = { dx: 0, dy: 0 }, cfg: Config = CONFIG): StepResult {
  return stepGame(state, { p1: input }, STEP_MS, cfg);
}

/** Adds a drifter that is already moving (no warning), by default right on top of p1. */
export function addDrifter(state: GameState, partial: Partial<Drifter> = {}): Drifter {
  const drifter: Drifter = {
    x: me(state).x,
    y: me(state).y,
    vx: 0,
    vy: 0,
    radius: 15,
    kind: 'crab',
    warningMs: 0,
    ...partial,
  };
  state.drifters.push(drifter);
  return drifter;
}
