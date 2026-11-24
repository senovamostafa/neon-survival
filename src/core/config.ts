import type { DrifterKind } from './types';

/**
 * Central game configuration.
 * Every tunable number lives here so balancing never means hunting through code.
 * All distances are in logical pixels (the game is 960x540, scaled to fit the window).
 * All times are in milliseconds unless the name says otherwise.
 */

/** [min, max] - a random value is picked between the two. */
type Range = [number, number];

export const CONFIG = {
  /** Logical screen size. */
  screen: { width: 960, height: 540 },

  /** Playable area (the HUD sits above it). */
  arena: { x: 16, y: 56, width: 928, height: 468 },

  /** Simulation runs in fixed steps so gameplay is identical on 60Hz and 144Hz monitors. */
  timestep: {
    stepMs: 1000 / 60,
    /** If the tab was in the background, never simulate more than this at once. */
    maxFrameMs: 100,
  },

  player: {
    speed: 180, // px per second, same in every direction
    radius: 9, // collision circle (the sprite is slightly bigger than this on purpose)
    lives: 3,
    invulnerableMs: 1500, // blinking invulnerability after being hit
  },

  energy: {
    max: 100,
    perOrb: 10,
  },

  /**
   * The four abilities. Cost is paid in energy. cooldownMs starts on activation
   * and stops you from chaining the same ability back to back.
   */
  abilities: {
    shield: {
      cost: 40,
      durationMs: 6000,
      cooldownMs: 2000,
      /** Short grace period after the shield absorbs a hit, so one touch cannot pop it and hurt you. */
      blockInvulnerableMs: 600,
    },
    slow: {
      cost: 30,
      durationMs: 5000,
      cooldownMs: 2000,
      /** Moving obstacles run at this fraction of normal speed. The player is unaffected. */
      factor: 0.4,
    },
    teleport: {
      cost: 25,
      cooldownMs: 1000,
      /** Destination must be at least this far from where you are. */
      minDistance: 150,
      /** Extra clearance required around barriers, traps and obstacles at the destination. */
      safeMargin: 10,
      obstacleClearance: 70,
    },
    magnet: {
      cost: 20,
      durationMs: 6000,
      cooldownMs: 2000,
      radius: 140,
      pullSpeed: 240,
    },
  },

  /** Moving obstacles. Phase 3 will scale these numbers with survival time. */
  drifters: {
    firstSpawnMs: 1200,
    intervalMs: [1600, 2600] as Range,
    max: 8,
    /** A new obstacle appears as a harmless marker this long before it starts moving. */
    warningMs: 700,
    /** Obstacles never appear closer than this to the player. */
    minEntryDistance: 120,
    types: {
      crab: { radius: 15, speed: [90, 130] as Range },
      star: { radius: 10, speed: [130, 190] as Range },
      bug: { radius: 13, speed: [60, 90] as Range },
    } satisfies Record<DrifterKind, { radius: number; speed: Range }>,
  },

  /** Stationary danger zones. */
  traps: {
    firstSpawnMs: 8000,
    intervalMs: [7000, 12000] as Range,
    max: 2,
    radius: 34,
    warningMs: 1500, // harmless blinking outline
    activeMs: 6000, // then dangerous for this long
    /** Edge-to-edge distance kept between a new trap and the player. */
    minDistanceFromPlayer: 120,
  },

  /** Solid walls. They block the player but not the flying obstacles. */
  barriers: {
    count: 3,
    sizes: [
      { width: 16, height: 96 },
      { width: 96, height: 16 },
      { width: 16, height: 64 },
      { width: 64, height: 16 },
    ],
    /** Keeps walls away from the arena border so there is always a way around them. */
    wallMargin: 56,
    /** Minimum gap between two walls (a player is 18px wide, so 64 is generous). */
    separation: 64,
    minDistanceFromPlayer: 110,
  },

  orbs: {
    firstSpawnMs: 1500,
    intervalMs: [2500, 5000] as Range,
    max: 3,
    radius: 7,
    lifetimeMs: 12000,
    minDistanceFromPlayer: 60,
  },
};

export type Config = typeof CONFIG;
