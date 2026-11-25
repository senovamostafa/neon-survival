import { describe, expect, it } from 'vitest';
import { activateAbility } from './abilities';
import { circleHitsRect } from './collision';
import { CONFIG } from './config';
import { getDifficulty } from './difficulty';
import { gravityPush, insetArena } from './events';
import { createGame, startRun, stepGame } from './game';
import { Rng } from './rng';
import { spawnDrifters, spawnOrb, spawnTrap } from './spawn';
import { addDrifter, quietGame } from './testUtils';
import type { GameState, InputState } from './types';

const STEP = CONFIG.timestep.stepMs;
const IDLE: InputState = { dx: 0, dy: 0 };
const { arena, events } = CONFIG;

function run(state: GameState, steps: number, input: InputState = IDLE): void {
  for (let i = 0; i < steps; i++) stepGame(state, input, STEP);
}

/** A quiet game where the next event starts on the very next step. */
function eventGame(seed = 1): GameState {
  const s = quietGame(seed);
  s.nextEventMs = 0;
  return s;
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
      expect(d.maxTraps).toBe(row.maxTraps);
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
    const mid = getDifficulty(15_000, CONFIG); // halfway from Easy to Medium
    expect(mid.drifterIntervalMs).toBeCloseTo(1700);
    expect(mid.speedMax).toBeCloseTo(120);
  });

  it('stays capped after the last stage', () => {
    expect(getDifficulty(10_000_000, CONFIG)).toEqual(getDifficulty(180_000, CONFIG));
  });

  it('makes obstacles faster over time', () => {
    const rng = new Rng(1);
    const p = { x: arena.x + arena.width / 2, y: arena.y + arena.height / 2, radius: 9 };
    const avg = (t: number): number => {
      let sum = 0;
      for (let i = 0; i < 200; i++) {
        const d = spawnDrifters(rng, p, CONFIG, arena, { ...getDifficulty(t, CONFIG), waveChance: 0 })[0];
        sum += Math.hypot(d.vx, d.vy);
      }
      return sum / 200;
    };
    expect(avg(200_000)).toBeGreaterThan(avg(100_000));
    expect(avg(100_000)).toBeGreaterThan(avg(0));
  });
});

describe('obstacle waves', () => {
  const p = { x: arena.x + arena.width / 2, y: arena.y + arena.height / 2, radius: 9 };
  const alwaysWave = { ...getDifficulty(120_000, CONFIG), waveChance: 1 };

  it('spawn 2-3 obstacles on one edge, flying in parallel with staggered starts', () => {
    let sawMultiple = false;
    for (let seed = 0; seed < 100; seed++) {
      const wave = spawnDrifters(new Rng(seed), p, CONFIG, arena, alwaysWave);
      expect(wave.length).toBeGreaterThanOrEqual(1);
      expect(wave.length).toBeLessThanOrEqual(CONFIG.drifters.waveSize[1]);
      if (wave.length > 1) sawMultiple = true;
      for (const d of wave) {
        expect(d.vx).toBeCloseTo(wave[0].vx);
        expect(d.vy).toBeCloseTo(wave[0].vy);
        expect(Math.hypot(d.x - p.x, d.y - p.y)).toBeGreaterThanOrEqual(CONFIG.drifters.minEntryDistance);
        expect(d.warningMs).toBeGreaterThanOrEqual(CONFIG.drifters.warningMs);
      }
    }
    expect(sawMultiple).toBe(true);
  });

  it('never appear in the first stage', () => {
    expect(getDifficulty(0, CONFIG).waveChance).toBe(0);
    expect(getDifficulty(29_999, CONFIG).waveChance).toBe(0);
    expect(getDifficulty(30_000, CONFIG).waveChance).toBeGreaterThan(0);
  });
});

describe('event scheduling', () => {
  it('never starts before 30 seconds', () => {
    for (let seed = 0; seed < 100; seed++) {
      expect(createGame(seed).nextEventMs).toBeGreaterThanOrEqual(30_000);
    }
  });

  it('warns first, then takes effect, then ends', () => {
    const s = eventGame();
    stepGame(s, IDLE, STEP);
    expect(s.event?.phase).toBe('warning');
    expect(s.event?.msLeft).toBeGreaterThan(events.warningMs - 50);

    run(s, Math.ceil(events.warningMs / STEP) + 2);
    expect(s.event?.phase).toBe('active');

    const kind = s.event!.kind;
    run(s, Math.ceil(events[kind].durationMs / STEP) + 2);
    expect(s.event).toBeNull();
    expect(s.lastEventKind).toBe(kind);
  });

  it('leaves a quiet gap of at least 25 seconds between events', () => {
    const s = eventGame();
    // run until the first event is finished
    for (let i = 0; i < 4000 && (s.event || s.lastEventKind === null); i++) stepGame(s, IDLE, STEP);
    expect(s.event).toBeNull();
    expect(s.nextEventMs).toBeGreaterThanOrEqual(events.intervalMs[0]);
    expect(s.nextEventMs).toBeLessThanOrEqual(events.intervalMs[1]);
  });

  it('never runs two events at once and never repeats the same kind twice in a row', () => {
    const s = eventGame(7);
    s.player.invulnerableMs = Number.MAX_SAFE_INTEGER;
    const kinds: string[] = [];
    let current: string | null = null;
    for (let i = 0; i < 60 * 60 * 6; i++) {
      s.nextEventMs = Math.min(s.nextEventMs, 600); // speed up the quiet gaps
      stepGame(s, IDLE, STEP);
      if (s.status !== 'playing') break;
      const key = s.event ? `${s.event.kind}` : null;
      if (key && key !== current) kinds.push(key);
      current = key;
    }
    expect(kinds.length).toBeGreaterThan(6);
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
    expect(new Set(kinds).size).toBe(3); // all three kinds do occur
  });

  it('is repeatable for the same seed', () => {
    const play = (seed: number): string[] => {
      const s = eventGame(seed);
      const seen: string[] = [];
      for (let i = 0; i < 3000; i++) {
        stepGame(s, IDLE, STEP);
        if (s.event && s.event.msLeft === s.event.totalMs) seen.push(`${s.event.kind}:${s.event.direction}`);
      }
      return seen;
    };
    expect(play(5)).toEqual(play(5));
  });
});

describe('gravity shift', () => {
  function gravityGame(direction: 'up' | 'down' | 'left' | 'right'): GameState {
    const s = quietGame();
    s.event = { kind: 'gravity', phase: 'active', msLeft: 8000, totalMs: 8000, direction };
    return s;
  }

  it('pushes the player in the announced direction at the configured force', () => {
    const s = gravityGame('right');
    const x0 = s.player.x;
    run(s, 30);
    expect(s.player.x - x0).toBeCloseTo(events.gravity.force * 0.5, 2);
    expect(s.player.y).toBeCloseTo(arena.y + arena.height / 2);
  });

  it('does nothing during the warning', () => {
    const s = quietGame();
    s.event = { kind: 'gravity', phase: 'warning', msLeft: 3000, totalMs: 3000, direction: 'down' };
    expect(gravityPush(s, CONFIG)).toEqual({ x: 0, y: 0 });
  });

  it('can always be fought: moving against it still makes progress', () => {
    const s = gravityGame('left');
    const x0 = s.player.x;
    run(s, 60, { dx: 1, dy: 0 });
    expect(s.player.x - x0).toBeCloseTo(CONFIG.player.speed - events.gravity.force, 1);
  });

  it('never pushes the player out of the arena', () => {
    const s = gravityGame('down');
    run(s, 60 * 20);
    expect(s.player.y).toBeLessThanOrEqual(arena.y + arena.height - s.player.radius + 1e-9);
  });

  it('stops when the event ends', () => {
    const s = eventGame(3);
    run(s, Math.ceil((events.warningMs + 9000) / STEP));
    const x = s.player.x;
    const y = s.player.y;
    if (!s.event) {
      run(s, 30);
      expect([s.player.x, s.player.y]).toEqual([x, y]);
    }
  });
});

describe('blackout', () => {
  it('spawns obstacles less often while active (fairness)', () => {
    const count = (blackout: boolean): number => {
      let total = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const s = quietGame(seed);
        if (blackout) s.event = { kind: 'blackout', phase: 'active', msLeft: 7000, totalMs: 7000 };
        s.spawn.drifterMs = 0;
        stepGame(s, IDLE, STEP);
        total += s.spawn.drifterMs;
      }
      return total;
    };
    expect(count(true) / count(false)).toBeCloseTo(events.spawnIntervalFactor, 1);
  });
});

describe('shrinking arena', () => {
  function shrinkGame(msLeft: number): GameState {
    const s = quietGame();
    s.event = { kind: 'shrink', phase: 'active', msLeft, totalMs: events.shrink.durationMs };
    return s;
  }

  it('reaches exactly the configured minimum size and no smaller', () => {
    const s = shrinkGame(events.shrink.durationMs - events.shrink.shrinkMs);
    stepGame(s, IDLE, STEP);
    expect(s.bounds.width).toBeCloseTo(arena.width * events.shrink.minFraction, 0);
    expect(s.bounds.height).toBeCloseTo(arena.height * events.shrink.minFraction, 0);

    // Whatever the progress, the arena never drops below the minimum.
    for (let left = events.shrink.durationMs; left > 0; left -= 100) {
      const t = shrinkGame(left);
      stepGame(t, IDLE, STEP);
      expect(t.bounds.width).toBeGreaterThanOrEqual(arena.width * events.shrink.minFraction - 1);
      expect(t.bounds.height).toBeGreaterThanOrEqual(arena.height * events.shrink.minFraction - 1);
    }
  });

  it('stays centred and inside the arena', () => {
    const b = insetArena(CONFIG, 1);
    expect(b.x + b.width / 2).toBeCloseTo(arena.x + arena.width / 2);
    expect(b.y + b.height / 2).toBeCloseTo(arena.y + arena.height / 2);
  });

  it('shrinks gradually and then restores the full arena', () => {
    const s = eventGame(2);
    const widths: number[] = [];
    for (let i = 0; i < 60 * 20; i++) {
      stepGame(s, IDLE, STEP);
      if (s.event?.kind === 'shrink') widths.push(s.bounds.width);
      if (s.event && s.event.kind !== 'shrink') break; // only look at a shrink event
    }
    if (widths.length > 0) {
      expect(Math.min(...widths)).toBeCloseTo(arena.width * events.shrink.minFraction, 0);
      for (let i = 1; i < widths.length; i++) {
        expect(Math.abs(widths[i] - widths[i - 1])).toBeLessThan(2); // never jumps
      }
    }
    // Force a full shrink cycle and check it restores.
    const t = shrinkGame(events.shrink.durationMs);
    run(t, Math.ceil(events.shrink.durationMs / STEP) + 5);
    expect(t.event).toBeNull();
    expect(t.bounds).toEqual({ ...arena });
  });

  it('pushes the player in and keeps them inside the shrunken arena', () => {
    const s = shrinkGame(events.shrink.durationMs);
    s.player.x = arena.x + 12; // hugging the left wall
    s.player.y = arena.y + arena.height / 2;
    for (let i = 0; i < 60 * 4; i++) {
      stepGame(s, IDLE, STEP);
      const r = s.player.radius;
      expect(s.player.x).toBeGreaterThanOrEqual(s.bounds.x + r - 1e-9);
      expect(s.player.x).toBeLessThanOrEqual(s.bounds.x + s.bounds.width - r + 1e-9);
      expect(s.player.y).toBeGreaterThanOrEqual(s.bounds.y + r - 1e-9);
      expect(s.player.y).toBeLessThanOrEqual(s.bounds.y + s.bounds.height - r + 1e-9);
    }
    expect(s.player.x).toBeGreaterThan(arena.x + 100); // it was carried inwards
  });

  it('keeps orbs, traps, obstacles and teleports inside the shrunken arena', () => {
    for (let seed = 0; seed < 50; seed++) {
      const s = shrinkGame(events.shrink.durationMs - events.shrink.shrinkMs);
      s.energy = 100;
      stepGame(s, IDLE, STEP);
      const b = s.bounds;
      const orb = spawnOrb(s, CONFIG);
      const trap = spawnTrap(s, CONFIG);
      if (orb) {
        expect(orb.x).toBeGreaterThanOrEqual(b.x);
        expect(orb.x).toBeLessThanOrEqual(b.x + b.width);
        expect(orb.y).toBeGreaterThanOrEqual(b.y);
        expect(orb.y).toBeLessThanOrEqual(b.y + b.height);
      }
      if (trap) {
        expect(trap.x - trap.radius).toBeGreaterThanOrEqual(b.x);
        expect(trap.x + trap.radius).toBeLessThanOrEqual(b.x + b.width);
      }
      for (const d of spawnDrifters(s.rng, s.player, CONFIG, b, getDifficulty(0, CONFIG))) {
        expect(d.x).toBeGreaterThanOrEqual(b.x);
        expect(d.x).toBeLessThanOrEqual(b.x + b.width);
        expect(d.y).toBeGreaterThanOrEqual(b.y);
        expect(d.y).toBeLessThanOrEqual(b.y + b.height);
      }
      const result = activateAbility(s, 'teleport');
      if (result.ok) {
        expect(result.to.x).toBeGreaterThanOrEqual(b.x);
        expect(result.to.x).toBeLessThanOrEqual(b.x + b.width);
      }
    }
  });
});

describe('arena transformations (sectors)', () => {
  const sectorMs = CONFIG.transform.everyMs;

  it('reshuffle the walls with one more wall each sector, up to the maximum', () => {
    const s = quietGame(4);
    expect(s.sector).toBe(0);
    s.timeMs = sectorMs - STEP;
    run(s, 2);
    expect(s.sector).toBe(1);
    expect(s.barriers).toHaveLength(CONFIG.barriers.count + 1);
    expect(s.barriers.every((b) => b.warningMs > 0)).toBe(true); // outlines first

    s.timeMs = sectorMs * 20 - STEP;
    run(s, 2);
    expect(s.barriers.length).toBeLessThanOrEqual(CONFIG.transform.maxBarriers);
  });

  it('keeps the new walls away from the player', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = quietGame(seed);
      s.timeMs = sectorMs - STEP;
      run(s, 2);
      for (const b of s.barriers) {
        expect(circleHitsRect({ x: s.player.x, y: s.player.y, radius: CONFIG.barriers.minDistanceFromPlayer }, b)).toBe(false);
      }
    }
  });

  it('only block once their warning is over', () => {
    const s = quietGame();
    s.barriers = [{ x: s.player.x + 40, y: s.player.y - 100, width: 16, height: 200, warningMs: 500 }];
    run(s, 30, { dx: 1, dy: 0 }); // 500 ms, wall still an outline: the player walks straight through
    expect(s.player.x).toBeGreaterThan(s.barriers[0].x + s.barriers[0].width);
  });

  it('never turn solid on top of the player', () => {
    const s = quietGame();
    s.barriers = [{ x: s.player.x - 20, y: s.player.y - 20, width: 40, height: 40, warningMs: 100 }];
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
    // Fuzz: several seeds, long runs. The first time we ever see an obstacle or trap it must
    // still be in its harmless warning phase, so the player always gets time to react.
    for (let seed = 0; seed < 8; seed++) {
      const s = createGame(seed);
      startRun(s);
      s.player.invulnerableMs = Number.MAX_SAFE_INTEGER;
      const seen = new Set<object>();
      for (let i = 0; i < 60 * 200; i++) {
        stepGame(s, IDLE, STEP);
        for (const thing of [...s.drifters, ...s.traps]) {
          if (seen.has(thing)) continue;
          seen.add(thing);
          expect(thing.warningMs).toBeGreaterThan(0);
        }
      }
      expect(seen.size).toBeGreaterThan(50);
    }
  });

  it('keeps obstacle counts within the difficulty limit through a long run', () => {
    const s = createGame(11);
    startRun(s);
    s.player.invulnerableMs = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 60 * 240; i++) {
      stepGame(s, IDLE, STEP);
      const d = getDifficulty(s.timeMs, CONFIG);
      expect(s.drifters.length).toBeLessThanOrEqual(d.maxDrifters);
      expect(s.traps.length).toBeLessThanOrEqual(d.maxTraps);
      expect(s.barriers.length).toBeLessThanOrEqual(CONFIG.transform.maxBarriers);
    }
  });

  it('replays identically for the same seed', () => {
    const play = (seed: number): string => {
      const s = createGame(seed);
      startRun(s);
      s.player.invulnerableMs = Number.MAX_SAFE_INTEGER;
      for (let i = 0; i < 60 * 90; i++) stepGame(s, { dx: i % 200 < 100 ? 1 : -1, dy: 0 }, STEP);
      return JSON.stringify(s);
    };
    expect(play(21)).toBe(play(21));
    expect(play(21)).not.toBe(play(22));
  });

  it('adds an obstacle near the player only as a marker, with time to react', () => {
    const s = quietGame();
    s.spawn.drifterMs = 0;
    stepGame(s, IDLE, STEP);
    const d = s.drifters[0];
    expect(d.warningMs).toBeGreaterThanOrEqual(CONFIG.drifters.warningMs - 20);
    addDrifter(s, { warningMs: 0 }); // one that is already live on the player hurts
    stepGame(s, IDLE, STEP);
    expect(s.player.lives).toBe(2);
  });
});
