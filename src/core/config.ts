/**
 * Central game configuration.
 * Every tunable number lives here so balancing never means hunting through code.
 * All distances are in logical pixels (the game is 960x540, scaled to fit the window).
 * All times are in milliseconds unless the name says otherwise.
 */

/** [min, max] - a random value is picked between the two. */
type Range = [number, number];

/** One row of the difficulty table. Values are blended smoothly between rows. */
export interface DifficultyKeyframe {
  /** Survival time at which this row is fully in effect. */
  atMs: number;
  name: string;
  /** Typical gap between moving-obstacle spawns. */
  drifterIntervalMs: number;
  /** Obstacle speed range for this stage; each obstacle type picks within it. */
  speedMin: number;
  speedMax: number;
  maxDrifters: number;
  /** Typical gap between new danger zones. */
  trapIntervalMs: number;
  maxTraps: number;
  /** Chance that a spawn is a wave of 2-3 obstacles instead of a single one. */
  waveChance: number;
}

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

  /**
   * Difficulty by survival time. Between two rows every value moves smoothly from one to the
   * other, so the game gets harder gradually instead of in sudden jumps. After the last row
   * everything stays capped. Initial targets: easy 0-30 s, medium 30-90 s, hard 90-180 s,
   * extreme 180 s+.
   */
  difficulty: {
    /** Random variation applied to spawn gaps (0.25 = plus or minus 25%). */
    jitter: 0.25,
    /** Waves of obstacles never appear before this survival time (the end of the Easy stage). */
    wavesFromMs: 30_000,
    keyframes: [
      { atMs: 0, name: 'Easy', drifterIntervalMs: 2000, speedMin: 60, speedMax: 100, maxDrifters: 6, trapIntervalMs: 11000, maxTraps: 1, waveChance: 0 },
      { atMs: 30_000, name: 'Medium', drifterIntervalMs: 1400, speedMin: 80, speedMax: 140, maxDrifters: 8, trapIntervalMs: 9000, maxTraps: 2, waveChance: 0.12 },
      { atMs: 90_000, name: 'Hard', drifterIntervalMs: 900, speedMin: 110, speedMax: 190, maxDrifters: 11, trapIntervalMs: 7000, maxTraps: 3, waveChance: 0.2 },
      { atMs: 180_000, name: 'Extreme', drifterIntervalMs: 600, speedMin: 140, speedMax: 240, maxDrifters: 14, trapIntervalMs: 5500, maxTraps: 4, waveChance: 0.3 },
    ] as DifficultyKeyframe[],
  },

  /** Moving obstacles. Speed comes from the difficulty table; each type uses a slice of it. */
  drifters: {
    firstSpawnMs: 1200,
    /** A new obstacle appears as a harmless marker this long before it starts moving. */
    warningMs: 700,
    /** Obstacles never appear closer than this to the player. */
    minEntryDistance: 120,
    /** A wave is this many obstacles side by side, flying the same way. */
    waveSize: [2, 3] as Range,
    waveSpacing: 70,
    /** Each extra obstacle in a wave starts moving this much later, which leaves gaps to slip through. */
    waveStaggerMs: 250,
    types: {
      // speedFactor picks a slice of the stage's [speedMin, speedMax] range: 0 = slowest, 1 = fastest.
      crab: { radius: 15, speedFactor: [0.3, 0.7] as Range },
      star: { radius: 10, speedFactor: [0.6, 1] as Range },
      bug: { radius: 13, speedFactor: [0, 0.4] as Range },
    },
  },

  /** Stationary danger zones. How many and how often comes from the difficulty table. */
  traps: {
    firstSpawnMs: 8000,
    radius: 34,
    warningMs: 1500, // harmless blinking outline
    activeMs: 6000, // then dangerous for this long
    /** Edge-to-edge distance kept between a new trap and the player. */
    minDistanceFromPlayer: 120,
  },

  /** Solid walls. They block the player but not the flying obstacles. */
  barriers: {
    /** How many walls a run starts with. */
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

  /** Every sector the walls are rearranged (with one more wall) and the arena changes colour. */
  transform: {
    everyMs: 60_000,
    /** New walls show as an outline for this long before turning solid. */
    barrierWarningMs: 2000,
    maxBarriers: 7,
  },

  orbs: {
    firstSpawnMs: 1500,
    intervalMs: [2500, 5000] as Range,
    max: 3,
    radius: 7,
    lifetimeMs: 12000,
    minDistanceFromPlayer: 60,
  },

  /** Random arena events. One at a time, always announced first. */
  events: {
    /** Delay before the very first event warning (never earlier than 30 s). */
    firstDelayMs: [30_000, 45_000] as Range,
    /** Quiet time between the end of one event and the next warning. */
    intervalMs: [25_000, 45_000] as Range,
    warningMs: 3000,
    /** While blackout or shrinking runs, obstacles spawn this much less often (fairness). */
    spawnIntervalFactor: 1.5,
    gravity: {
      durationMs: 8000,
      /** Constant push in px per second. The player moves at 180, so you can always fight it. */
      force: 70,
    },
    blackout: {
      durationMs: 7000,
      /** You always see this far around yourself. */
      visibleRadius: 100,
      fadeMs: 600,
    },
    shrink: {
      durationMs: 8000,
      /** The walls close in over this long, hold, then open again over restoreMs. */
      shrinkMs: 3000,
      restoreMs: 1500,
      /** The arena never gets smaller than this fraction of its width and height. */
      minFraction: 0.55,
    },
  },
};

export type Config = typeof CONFIG;
