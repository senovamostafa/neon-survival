/**
 * Central game configuration.
 * Every tunable number lives here so balancing never means hunting through code.
 * All distances are in logical pixels (the game is 960x540, scaled to fit the window).
 * All times are in milliseconds unless the name says otherwise.
 */
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

  /** Phase 1 test hazard. Real obstacle types arrive in Phase 2. */
  hazard: {
    count: 1,
    radius: 15,
    speed: 150,
    /** Hazards never start closer to the player than this. */
    minSpawnDistance: 200,
  },
} as const;

export type Config = typeof CONFIG;
