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

  /** The match: a fixed-length race for orbs between 3 to 10 players. */
  match: {
    durationMs: 240_000, // 4 minutes
    minPlayers: 3, // needed to start a real match (the core itself works with any number)
    maxPlayers: 10,
    countdownMs: 5000,
    /** Players start spread on an ellipse this fraction of the arena size from the centre. */
    spawnRingFraction: 0.28,
  },

  player: {
    speed: 180, // px per second, same in every direction
    radius: 9, // collision circle (the sprite is slightly bigger than this on purpose)
    lives: 3,
    invulnerableMs: 1500, // blinking invulnerability after being hit
    /** After losing every life: frozen, then back with fewer lives. */
    respawn: {
      freezeMs: 5000,
      lives: 1,
      invulnerableMs: 2000,
    },
    /** A disconnected player's hero disappears after this long (they can still rejoin). */
    awayRemoveMs: 10_000,
  },

  /** Two players who touch are shoved straight apart. Harmless, but walls still stop the shove. */
  bump: {
    distance: 50,
    durationMs: 250,
    /** The same two players cannot bump again for this long. */
    cooldownMs: 500,
  },

  energy: {
    max: 100,
    perOrb: 10,
  },

  /** Bigger rooms get a bit more of everything so large matches stay lively. */
  scaling: {
    /** Rooms of this size or smaller use the base values. */
    referencePlayers: 3,
    /** Each player above the reference adds this fraction to obstacle counts and spawn rate. */
    hazardPerExtraPlayer: 0.05,
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
      /** Moving obstacles near you run at this fraction of normal speed. Players are unaffected. */
      factor: 0.4,
      /** Only obstacles within this distance of you are slowed (it is a zone, not global). */
      radius: 200,
    },
    teleport: {
      cost: 25,
      cooldownMs: 1000,
      /** Destination must be at least this far from where you are. */
      minDistance: 150,
      /** Extra clearance required around walls and obstacles at the destination. */
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
      { atMs: 0, name: 'Easy', drifterIntervalMs: 4200, speedMin: 55, speedMax: 90, maxDrifters: 3, waveChance: 0 },
      { atMs: 30_000, name: 'Medium', drifterIntervalMs: 3400, speedMin: 70, speedMax: 115, maxDrifters: 4, waveChance: 0.05 },
      { atMs: 90_000, name: 'Hard', drifterIntervalMs: 2700, speedMin: 90, speedMax: 150, maxDrifters: 5, waveChance: 0.08 },
      { atMs: 180_000, name: 'Extreme', drifterIntervalMs: 2100, speedMin: 115, speedMax: 185, maxDrifters: 6, waveChance: 0.12 },
    ] as DifficultyKeyframe[],
  },

  /** Moving enemies. They spawn in corridors, fly straight along them and vanish when they hit a wall. */
  drifters: {
    firstSpawnMs: 1200,
    /** A new enemy appears as a harmless marker this long before it starts moving. */
    warningMs: 800,
    /** Enemies never appear closer than this to a player. */
    minEntryDistance: 120,
    /** A wave is a pack of this many enemies of one kind and speed, appearing at once in different corridors. */
    waveSize: [2, 3] as Range,
    /** Each extra enemy in a wave starts moving this much later, which leaves gaps to slip through. */
    waveStaggerMs: 250,
    /** An enemy only spawns where it has at least this much open corridor ahead of it. */
    minTravel: 200,
    types: {
      // speedFactor picks a slice of the stage's [speedMin, speedMax] range: 0 = slowest, 1 = fastest.
      crab: { radius: 15, speedFactor: [0.3, 0.7] as Range },
      star: { radius: 10, speedFactor: [0.6, 1] as Range },
      bug: { radius: 13, speedFactor: [0, 0.4] as Range },
    },
  },

  /**
   * The walls form a maze of corridors. The arena is a grid of cells; walls sit on the lines
   * between cells. Every cell can be reached from every other and there are no dead ends,
   * only loops, so nobody can get cornered. Walls block players and make flying enemies vanish.
   */
  maze: {
    cols: 16,
    rows: 8,
    /** Wall thickness. With 58 px cells that leaves corridors about 42 px wide (a hero is 18 px). */
    thickness: 16,
    /**
     * Chance of knocking out each wall segment of the basic maze, per sector (the last value
     * is used from then on). Lower means more walls, so the maze gets tighter every minute.
     */
    openChanceBySector: [0.45, 0.38, 0.32, 0.26],
  },

  /** Every sector (minute) a brand new maze appears and the arena changes colour. */
  transform: {
    everyMs: 60_000,
    /** New walls show as an outline for this long before turning solid. */
    barrierWarningMs: 2000,
  },

  /** Orbs are the score. Supply scales with the number of players (never below the reference). */
  orbs: {
    firstSpawnMs: 1500,
    /** Total gap between spawns is this divided by the player count, so each player gets ~1 orb per gap. */
    gapPerPlayerMs: 5000,
    /** Random variation on the gap (0.3 = plus or minus 30%). */
    jitter: 0.3,
    /** How many orbs can lie around at once, per player. */
    maxPerPlayer: 4,
    radius: 7,
    lifetimeMs: 12000,
    minDistanceFromPlayer: 60,
  },
};

export type Config = typeof CONFIG;
