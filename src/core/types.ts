import type { Rect } from './collision';
import type { Rng } from './rng';

/** Shared data shapes for the game rules. No behaviour lives here. */

export type GameStatus = 'ready' | 'playing' | 'gameover';

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

/** A solid wall. While warningMs > 0 it is only an outline and does not block anything yet. */
export interface Barrier extends Rect {
  warningMs: number;
}

export type EventKind = 'gravity' | 'blackout' | 'shrink';
export type GravityDirection = 'up' | 'down' | 'left' | 'right';

/** A random arena event. It announces itself (warning) before it takes effect (active). */
export interface ArenaEvent {
  kind: EventKind;
  phase: 'warning' | 'active';
  /** Time left in the current phase. */
  msLeft: number;
  /** Total length of the current phase, so progress = 1 - msLeft / totalMs. */
  totalMs: number;
  /** Only for gravity shifts. */
  direction?: GravityDirection;
}

/** A stationary danger zone: harmless during the warning, harmful while active. */
export interface Trap {
  x: number;
  y: number;
  radius: number;
  warningMs: number;
  activeMs: number;
}

/** An energy orb the player collects by touching it. */
export interface Orb {
  x: number;
  y: number;
  radius: number;
  ttlMs: number;
}

export interface Player {
  x: number;
  y: number;
  radius: number;
  lives: number;
  /** Remaining invulnerability after a hit, in ms. 0 = can be hit. */
  invulnerableMs: number;
}

export interface AbilityState {
  /** Remaining effect time in ms (always 0 for instant abilities like teleport). */
  activeMs: number;
  /** Remaining cooldown in ms. */
  cooldownMs: number;
}

export interface GameState {
  status: GameStatus;
  /** Survival time in ms. Only counts while status is 'playing'. */
  timeMs: number;
  player: Player;
  drifters: Drifter[];
  traps: Trap[];
  orbs: Orb[];
  /** Solid walls the player cannot pass through (once their warning is over). */
  barriers: Barrier[];
  /** The playable area right now. Equals the arena unless a shrinking-arena event is running. */
  bounds: Rect;
  /** The running arena event, or null. Only one event exists at a time. */
  event: ArenaEvent | null;
  /** Countdown until the next event's warning begins (only counts while no event runs). */
  nextEventMs: number;
  lastEventKind: EventKind | null;
  /** Which 60-second stretch of the run we are in. Each new one reshuffles the walls. */
  sector: number;
  energy: number;
  /** Stat only: never part of the leaderboard score. */
  orbsCollected: number;
  abilities: Record<AbilityId, AbilityState>;
  /** Countdowns until the next spawn of each kind, in ms. */
  spawn: { drifterMs: number; trapMs: number; orbMs: number };
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
  /** The player lost a life (also true on the final, fatal hit). */
  hit: boolean;
  /** A hit was absorbed by the shield, so no life was lost. */
  shieldBlocked: boolean;
  /** Positions of the orbs collected during this step. */
  pickups: { x: number; y: number }[];
  gameOver: boolean;
}

export type AbilityFailure =
  | 'not-playing'
  | 'active' // already running
  | 'cooldown'
  | 'no-energy'
  | 'no-safe-spot'; // teleport only

export type AbilityResult =
  | { ok: true; from: { x: number; y: number }; to: { x: number; y: number } }
  | { ok: false; reason: AbilityFailure };
