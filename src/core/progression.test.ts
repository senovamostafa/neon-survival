import { describe, expect, it } from 'vitest';
import { circleHitsRect } from './collision';
import { CONFIG } from './config';
import { getDifficulty } from './difficulty';
import { startRun } from './game';
import { spawnDrifters } from './spawn';
import { addDrifter, me, quietGame, soloMatch, step } from './testUtils';
import type { GameState, InputState } from './types';

const STEP = CONFIG.timestep.stepMs;
const IDLE: InputState = { dx: 0, dy: 0 };
const { arena } = CONFIG;

function run(state: GameState, steps: number, input: InputState = IDLE): void {
  for (let i = 0; i < steps; i++) step(state, input);
}

describe('difficulty curve', () => {
  it('matches the table at each stage start', () => {
    for (const row of CONFIG.difficulty.keyframes) {
      const d = getDifficulty(row.atMs, CONFIG);
      expect(d.tier).toBe(row.name);
      expect(d.drifterIntervalMs).toBeCloseTo(row.drifterIntervalMs);
      expect(d.speedMin).toBeCloseTo(row.speedMin);
      expect(d.speedMax).toBeCloseTo(row.speedMax);
      expect(d.maxDrifters).toBe(row.maxDrifters);
    }
  });

  it('uses the stage names Easy, Medium, Hard and Extreme at 0, 30, 90 and 180 seconds', () => {
    expect(getDifficulty(0, CONFIG).tier).toBe('Easy');
    expect(getDifficulty(29_999, CONFIG).tier).toBe('Easy');
    expect(getDifficulty(30_000, CONFIG).tier).toBe('Medium');
    expect(getDifficulty(90_000, CONFIG).tier).toBe('Hard');
    expect(getDifficulty(180_000, CONFIG).tier).toBe('Extreme');
  });

  it('only ever gets harder, with no sudden jumps', () => {
    let prev = getDifficulty(0, CONFIG);
    for (let t = 500; t <= 400_000; t += 500) {
      const d = getDifficulty(t, CONFIG);
      expect(d.drifterIntervalMs).toBeLessThanOrEqual(prev.drifterIntervalMs + 1e-9);
      expect(d.speedMax).toBeGreaterThanOrEqual(prev.speedMax - 1e-9);
      expect(d.maxDrifters).toBeGreaterThanOrEqual(prev.maxDrifters);
      expect(d.waveChance).toBeGreaterThanOrEqual(prev.waveChance - 1e-9);
      expect(Math.abs(d.drifterIntervalMs - prev.drifterIntervalMs)).toBeLessThan(40); // gentle ramp
      prev = d;
    }
  });

  it('blends between stages', () => {
    const [easy, medium] = CONFIG.difficulty.keyframes;
    const mid = getDifficulty((easy.atMs + medium.atMs) / 2, CONFIG); // halfway from Easy to Medium
    expect(mid.drifterIntervalMs).toBeCloseTo((easy.drifterIntervalMs + medium.drifterIntervalMs) / 2);
    expect(mid.speedMax).toBeCloseTo((easy.speedMax + medium.speedMax) / 2);
  });

  it('stays capped after the last stage', () => {
    expect(getDifficulty(10_000_000, CONFIG)).toEqual(getDifficulty(180_000, CONFIG));
  });

  it('makes enemies faster over time', () => {
    const avg = (t: number): number => {
      let sum = 0;
      let n = 0;
      for (let seed = 0; seed < 200; seed++) {
        const s = soloMatch(seed);
        for (const d of spawnDrifters(s, CONFIG, { ...getDifficulty(t, CONFIG), waveChance: 0 })) {
          sum += Math.hypot(d.vx, d.vy);
          n++;
        }
      }
      return sum / n;
    };
    expect(avg(200_000)).toBeGreaterThan(avg(100_000));
    expect(avg(100_000)).toBeGreaterThan(avg(0));
  });
});

describe('enemy waves', () => {
  const alwaysWave = { ...getDifficulty(120_000, CONFIG), waveChance: 1 };

  it('are packs of 2-3 enemies of one kind and speed, in different corridors, starting one after another', () => {
    let sawMultiple = false;
    for (let seed = 0; seed < 100; seed++) {
      const s = soloMatch(seed);
      const wave = spawnDrifters(s, CONFIG, alwaysWave);
      expect(wave.length).toBeLessThanOrEqual(CONFIG.drifters.waveSize[1]);
      if (wave.length > 1) sawMultiple = true;
      wave.forEach((d, i) => {
        expect(d.kind).toBe(wave[0].kind);
        expect(Math.hypot(d.vx, d.vy)).toBeCloseTo(Math.hypot(wave[0].vx, wave[0].vy));
        expect(Math.hypot(d.x - me(s).x, d.y - me(s).y)).toBeGreaterThanOrEqual(CONFIG.drifters.minEntryDistance);
        expect(d.warningMs).toBeCloseTo(CONFIG.drifters.warningMs + i * CONFIG.drifters.waveStaggerMs);
        for (const other of wave.slice(0, i)) expect(Math.hypot(d.x - other.x, d.y - other.y)).toBeGreaterThanOrEqual(50);
      });
    }
    expect(sawMultiple).toBe(true);
  });

  it('never appear in the first stage', () => {
    expect(getDifficulty(0, CONFIG).waveChance).toBe(0);
    expect(getDifficulty(29_999, CONFIG).waveChance).toBe(0);
    expect(getDifficulty(30_000, CONFIG).waveChance).toBeGreaterThan(0);
  });
});

describe('arena transformations (sectors)', () => {
  const sectorMs = CONFIG.transform.everyMs;

  it('bring a brand new maze every minute, shown as outlines first and solid after the warning', () => {
    const s = soloMatch(4);
    startRun(s);
    s.spawn = { drifterMs: 1e12, orbMs: 1e12 };
    const first = JSON.stringify(s.maze);
    expect(s.sector).toBe(0);
    s.timeMs = sectorMs - STEP;
    run(s, 2);
    expect(s.sector).toBe(1);
    expect(JSON.stringify(s.maze)).not.toBe(first);
    expect(s.barriers.length).toBeGreaterThan(10);
    expect(s.barriers.every((b) => b.warningMs > 0)).toBe(true); // outlines first

    run(s, Math.ceil(CONFIG.transform.barrierWarningMs / STEP) + 5);
    expect(s.barriers.every((b) => b.warningMs === 0)).toBe(true); // then solid
  });

  it('never leave anyone inside a wall once the new walls turn solid', () => {
    for (let seed = 0; seed < 40; seed++) {
      const s = soloMatch(seed);
      startRun(s);
      s.spawn = { drifterMs: 1e12, orbMs: 1e12 };
      s.timeMs = sectorMs - STEP;
      run(s, Math.ceil(CONFIG.transform.barrierWarningMs / STEP) + 10, { dx: 1, dy: 0 });
      // A wall that someone is standing on keeps waiting as an outline; every solid wall is clear of them.
      for (const b of s.barriers.filter((w) => w.warningMs <= 0)) {
        expect(circleHitsRect({ x: me(s).x, y: me(s).y, radius: me(s).radius }, b)).toBe(false);
      }
    }
  });

  it('remove orbs that would be stuck inside the new walls', () => {
    const s = soloMatch(2);
    startRun(s);
    s.spawn = { drifterMs: 1e12, orbMs: 1e12 };
    // put an orb right in the middle of where a wall of the next maze will be, by trying many spots
    for (let i = 0; i < 200; i++) s.orbs.push({ x: arena.x + 5 + i * 4.5, y: arena.y + 58.5 * (1 + (i % 6)), radius: 7, ttlMs: 99_999 });
    s.timeMs = sectorMs - STEP;
    run(s, 2);
    for (const o of s.orbs) {
      expect(s.barriers.some((b) => circleHitsRect({ x: o.x, y: o.y, radius: o.radius }, b))).toBe(false);
    }
  });
  it('only block once their warning is over', () => {
    const s = quietGame();
    s.barriers = [{ x: me(s).x + 40, y: me(s).y - 100, width: 16, height: 200, warningMs: 500 }];
    run(s, 30, { dx: 1, dy: 0 }); // 500 ms, wall still an outline: the player walks straight through
    expect(me(s).x).toBeGreaterThan(s.barriers[0].x + s.barriers[0].width);
  });

  it('never turn solid on top of the player', () => {
    const s = quietGame();
    s.barriers = [{ x: me(s).x - 20, y: me(s).y - 20, width: 40, height: 40, warningMs: 100 }];
    run(s, 60); // the player is standing inside: the wall must keep waiting
    expect(s.barriers[0].warningMs).toBeGreaterThan(0);
    // once the player steps out, it becomes solid
    run(s, 60, { dx: 1, dy: 0 });
    run(s, 10);
    expect(s.barriers[0].warningMs).toBe(0);
  });

  it('are deterministic for a seed', () => {
    const make = (seed: number) => {
      const s = quietGame(seed);
      s.timeMs = sectorMs - STEP;
      run(s, 2);
      return JSON.stringify(s.barriers);
    };
    expect(make(8)).toBe(make(8));
  });
});

describe('a whole run stays playable', () => {
  it('always shows a warning before anything harmful appears', () => {
    // Fuzz: several seeds, long runs. The first time we ever see an obstacle it must
    // still be in its harmless warning phase, so the player always gets time to react.
    for (let seed = 0; seed < 8; seed++) {
      const s = soloMatch(seed);
      startRun(s);
      me(s).invulnerableMs = Number.MAX_SAFE_INTEGER;
      const seen = new Set<object>();
      for (let i = 0; i < 60 * 200; i++) {
        step(s, IDLE);
        for (const thing of s.drifters) {
          if (seen.has(thing)) continue;
          seen.add(thing);
          expect(thing.warningMs).toBeGreaterThan(0);
        }
      }
      expect(seen.size).toBeGreaterThan(50);
    }
  });

  it('keeps obstacle counts within the difficulty limit through a long run', () => {
    const s = soloMatch(11);
    startRun(s);
    me(s).invulnerableMs = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 60 * 240; i++) {
      step(s, IDLE);
      const d = getDifficulty(s.timeMs, CONFIG);
      expect(s.drifters.length).toBeLessThanOrEqual(d.maxDrifters);
    }
  });

  it('replays identically for the same seed', () => {
    const play = (seed: number): string => {
      const s = soloMatch(seed);
      startRun(s);
      me(s).invulnerableMs = Number.MAX_SAFE_INTEGER;
      for (let i = 0; i < 60 * 90; i++) step(s, { dx: i % 200 < 100 ? 1 : -1, dy: 0 });
      return JSON.stringify(s);
    };
    expect(play(21)).toBe(play(21));
    expect(play(21)).not.toBe(play(22));
  });

  it('adds an obstacle near the player only as a marker, with time to react', () => {
    const s = quietGame();
    s.spawn.drifterMs = 0;
    step(s, IDLE);
    const d = s.drifters[0];
    expect(d.warningMs).toBeGreaterThanOrEqual(CONFIG.drifters.warningMs - 20);
    addDrifter(s, { warningMs: 0 }); // one that is already live on the player hurts
    step(s, IDLE);
    expect(me(s).lives).toBe(2);
  });
});
