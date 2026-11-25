import type { Rect } from './collision';
import type { Rng } from './rng';

/** Shared data shapes for the game rules. No behaviour lives here. */

/** ready = waiting to start, playing = the 4-minute match is running, finished = time is up. */
export type GameStatus = 'ready' | 'playing' | 'finished';

export type AbilityId = 'shield' | 'slow' | 'teleport' | 'magnet';

/** The three kinds of moving obstacle. Each has its own size, speed and sprite. */
export type DrifterKind = 'crab' | 'star' | 'bug';

/** A moving obstacle that crosses the arena in a straight line. */
export interface Drifter {
  x: number;
  y: number;
  vx: number; // px per second
  vy: number;
  radius: number;
  kind: DrifterKind;
  /** While above 0 the drifter is a harmless, stationary warning at its entry point. */
  warningMs: number;
}

/** One square of the maze. true means there is a wall on that side. */
export interface MazeCell {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
}

/** The arena divided into a grid of corridors. cells[row][col]. */
export interface Maze {
  cols: number;
  rows: number;
  cells: MazeCell[][];
}

/** A solid wall. While warningMs > 0 it is only an outline and does not block anything yet. */
export interface Barrier extends Rect {
  warningMs: number;
}

/** An energy orb. The first player to touch it takes it. */
export interface Orb {
  x: number;
  y: number;
  radius: number;
  ttlMs: number;
}

export interface AbilityState {
  /** Remaining effect time in ms (always 0 for instant abilities like teleport). */
  activeMs: number;
  /** Remaining cooldown in ms. */
  cooldownMs: number;
}

export interface Player {
  /** Stable identity (the server uses the player's id; local tests use 'p1', 'b1'...). */
  id: string;
  name: string;
  /** Which of the hero colours this player uses. */
  colorIndex: number;

  x: number;
  y: number;
  radius: number;
  lives: number;
  /** Remaining invulnerability after a hit or a respawn, in ms. 0 = can be hit. */
  invulnerableMs: number;

  /** false while frozen after losing every life. */
  alive: boolean;
  /** Time left frozen before respawning (only while alive is false). */
  respawnMs: number;
  deaths: number;

  /** Spendable energy for abilities. Spending it never lowers the score. */
  energy: number;
  /** The score: orbs collected this match. Never goes down. */
  orbs: number;
  /** Match time when the player reached their current orb count (tie-break: earlier wins). */
  lastOrbAtMs: number | null;
  abilities: Record<AbilityId, AbilityState>;

  /** Current shove from a bump with another player (px per second, for bumpMs). */
  bumpVx: number;
  bumpVy: number;
  bumpMs: number;

  /** Network state. A disconnected player's hero is removed after a short while. */
  connected: boolean;
  awayMs: number;
  /** false once a disconnected player has been away too long: the hero is gone. */
  present: boolean;
}

export interface GameState {
  status: GameStatus;
  /** Match time in ms. Only counts while status is 'playing'. */
  timeMs: number;
  players: Player[];
  drifters: Drifter[];
  orbs: Orb[];
  /** The maze layout. The walls below are drawn from it, and bots use it to find their way. */
  maze: Maze;
  /** Solid walls nobody can pass through (once their warning is over). */
  barriers: Barrier[];
  /** Which 60-second stretch of the match we are in. Each new one reshuffles the walls. */
  sector: number;
  /** Countdowns until the next spawn of each kind, in ms. */
  spawn: { drifterMs: number; orbMs: number };
  /** Time left before two players who just bumped can bump again, keyed by pair. */
  bumpCooldowns: Record<string, number>;
  readonly seed: number;
  readonly rng: Rng;
}

/** Movement intent for one step: each axis is -1, 0 or 1. */
export interface InputState {
  dx: number;
  dy: number;
}

/** Inputs for every player this step, keyed by player id. Missing players stand still. */
export type InputMap = Record<string, InputState>;

/** Everything the renderer or server may want to react to after one step. */
export interface StepResult {
  /** Players who lost a life (hit by an obstacle). */
  hits: { playerId: string }[];
  /** Players whose shield absorbed a hit. */
  shieldBlocks: { playerId: string }[];
  /** Orbs collected, with who took them and where they were. */
  pickups: { playerId: string; x: number; y: number }[];
  /** Players who lost their last life and are now frozen. */
  deaths: { playerId: string }[];
  /** Players who came back after being frozen. */
  respawns: { playerId: string }[];
  /** Pairs of players who just bumped. */
  bumps: { a: string; b: string }[];
  /** Where enemies flew into a wall and vanished. */
  wallHits: { x: number; y: number }[];
  /** The match ended during this step. */
  finished: boolean;
}

export type AbilityFailure =
  | 'not-playing'
  | 'unknown-player'
  | 'down' // frozen or gone
  | 'active' // already running
  | 'cooldown'
  | 'no-energy'
  | 'no-safe-spot'; // teleport only

export type AbilityResult =
  | { ok: true; from: { x: number; y: number }; to: { x: number; y: number } }
  | { ok: false; reason: AbilityFailure };

/** One row of the final ranking. */
export interface RankEntry {
  rank: number;
  playerId: string;
  name: string;
  orbs: number;
  deaths: number;
  /** Match time the player reached their final orb count, or null with 0 orbs. */
  reachedAtMs: number | null;
}
