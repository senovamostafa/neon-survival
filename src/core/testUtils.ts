import { CONFIG, type Config } from './config';
import { createGame, startRun } from './game';
import type { Drifter, GameState } from './types';

/**
 * Helpers for tests only.
 * A "quiet" game has no walls, obstacles, traps or orbs and nothing spawns on its own,
 * so a test can add exactly the pieces it wants to check.
 */
export function quietGame(seed = 1, cfg: Config = CONFIG): GameState {
  const state = createGame(seed, cfg);
  state.barriers = [];
  state.drifters = [];
  state.traps = [];
  state.orbs = [];
  state.spawn = { drifterMs: 1e12, trapMs: 1e12, orbMs: 1e12 };
  startRun(state);
  return state;
}

/** Adds a drifter that is already moving (no warning). */
export function addDrifter(state: GameState, partial: Partial<Drifter> = {}): Drifter {
  const drifter: Drifter = {
    x: state.player.x,
    y: state.player.y,
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
