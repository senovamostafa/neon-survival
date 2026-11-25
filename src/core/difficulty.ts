import type { Config, DifficultyKeyframe } from './config';

/** The difficulty values in effect at one moment. */
export interface Difficulty {
  /** Name of the stage reached so far, e.g. "Medium". */
  tier: string;
  drifterIntervalMs: number;
  speedMin: number;
  speedMax: number;
  maxDrifters: number;
  trapIntervalMs: number;
  maxTraps: number;
  waveChance: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Difficulty for a given survival time. Rows of the table in config.ts are reached exactly at
 * their start time; in between, values are blended linearly. Past the last row it stays capped.
 */
export function getDifficulty(timeMs: number, cfg: Config): Difficulty {
  const rows = cfg.difficulty.keyframes;
  let i = 0;
  while (i + 1 < rows.length && timeMs >= rows[i + 1].atMs) i++;

  const from = rows[i];
  const to: DifficultyKeyframe | undefined = rows[i + 1];
  const t = to ? (timeMs - from.atMs) / (to.atMs - from.atMs) : 0;
  const mix = (pick: (row: DifficultyKeyframe) => number): number =>
    to ? lerp(pick(from), pick(to), t) : pick(from);

  return {
    tier: from.name,
    drifterIntervalMs: mix((r) => r.drifterIntervalMs),
    speedMin: mix((r) => r.speedMin),
    speedMax: mix((r) => r.speedMax),
    maxDrifters: Math.round(mix((r) => r.maxDrifters)),
    trapIntervalMs: mix((r) => r.trapIntervalMs),
    maxTraps: Math.round(mix((r) => r.maxTraps)),
    waveChance: timeMs < cfg.difficulty.wavesFromMs ? 0 : mix((r) => r.waveChance),
  };
}
