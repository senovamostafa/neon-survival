import { describe, expect, it } from 'vitest';
import { CONFIG } from './config';
import { circleHitsCircle, circleHitsRect } from './collision';
import { formatTime } from './format';
import { createGame, startRun, stepGame, type GameState, type InputState } from './game';
import { Rng } from './rng';
import { FixedStepper } from './stepper';

const STEP = CONFIG.timestep.stepMs;
const IDLE: InputState = { dx: 0, dy: 0 };
const { arena } = CONFIG;

/** A started game with the hazards parked far away so they cannot interfere. */
function quietGame(seed = 1): GameState {
  const state = createGame(seed);
  state.hazards.forEach((h) => { h.vx = 0; h.vy = 0; h.x = arena.x + 20; h.y = arena.y + 20; });
  startRun(state);
  return state;
}

/** Puts the first hazard exactly on top of the player. */
function overlapHazard(state: GameState): void {
  state.hazards[0].x = state.player.x;
  state.hazards[0].y = state.player.y;
}

describe('Rng', () => {
  it('gives the same sequence for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 20; i++) expect(a.next()).toBe(b.next());
  });

  it('gives different sequences for different seeds', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('keeps values inside the requested ranges', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const f = rng.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = rng.int(3, 5);
      expect([3, 4, 5]).toContain(n);
    }
  });
});

describe('collision', () => {
  it('detects overlapping and separate circles', () => {
    expect(circleHitsCircle({ x: 0, y: 0, radius: 5 }, { x: 8, y: 0, radius: 5 })).toBe(true);
    expect(circleHitsCircle({ x: 0, y: 0, radius: 5 }, { x: 11, y: 0, radius: 5 })).toBe(false);
  });

  it('detects circle versus rectangle, including corners', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    expect(circleHitsRect({ x: 20, y: 20, radius: 2 }, rect)).toBe(true); // inside
    expect(circleHitsRect({ x: 5, y: 20, radius: 6 }, rect)).toBe(true); // touches left edge
    expect(circleHitsRect({ x: 5, y: 20, radius: 4 }, rect)).toBe(false); // too far left
    expect(circleHitsRect({ x: 5, y: 5, radius: 6 }, rect)).toBe(false); // corner: 7.07 away
    expect(circleHitsRect({ x: 5, y: 5, radius: 8 }, rect)).toBe(true);
  });
});

describe('player movement', () => {
  it('moves at the configured speed', () => {
    const s = quietGame();
    const startX = s.player.x;
    for (let i = 0; i < 60; i++) stepGame(s, { dx: 1, dy: 0 }, STEP);
    expect(s.player.x - startX).toBeCloseTo(CONFIG.player.speed, 3);
  });

  it('moves diagonally at the same speed as straight', () => {
    const s = quietGame();
    const { x, y } = s.player;
    for (let i = 0; i < 30; i++) stepGame(s, { dx: 1, dy: 1 }, STEP);
    const distance = Math.hypot(s.player.x - x, s.player.y - y);
    expect(distance).toBeCloseTo(CONFIG.player.speed * 0.5, 3);
  });

  it('stays inside the arena on every side', () => {
    const s = quietGame();
    s.player.invulnerableMs = Number.MAX_SAFE_INTEGER; // the parked hazard sits in a corner we drive into
    const r = s.player.radius;
    for (let i = 0; i < 600; i++) stepGame(s, { dx: -1, dy: -1 }, STEP);
    expect(s.player.x).toBeCloseTo(arena.x + r);
    expect(s.player.y).toBeCloseTo(arena.y + r);
    for (let i = 0; i < 900; i++) stepGame(s, { dx: 1, dy: 1 }, STEP);
    expect(s.player.x).toBeCloseTo(arena.x + arena.width - r);
    expect(s.player.y).toBeCloseTo(arena.y + arena.height - r);
  });

  it('does not move when there is no input', () => {
    const s = quietGame();
    const { x, y } = s.player;
    stepGame(s, IDLE, STEP);
    expect([s.player.x, s.player.y]).toEqual([x, y]);
  });
});

describe('hazards', () => {
  it('never spawn near the player, for many seeds', () => {
    for (let seed = 0; seed < 200; seed++) {
      const s = createGame(seed);
      for (const h of s.hazards) {
        expect(Math.hypot(h.x - s.player.x, h.y - s.player.y)).toBeGreaterThanOrEqual(
          CONFIG.hazard.minSpawnDistance,
        );
      }
    }
  });

  it('are identical for the same seed', () => {
    expect(createGame(99).hazards).toEqual(createGame(99).hazards);
  });

  it('bounce off walls and never leave the arena', () => {
    const s = createGame(5);
    startRun(s);
    s.player.invulnerableMs = Number.MAX_SAFE_INTEGER; // ignore hits, just watch the hazard
    const h = s.hazards[0];
    for (let i = 0; i < 6000; i++) {
      stepGame(s, IDLE, STEP);
      expect(h.x).toBeGreaterThanOrEqual(arena.x + h.radius - 1e-6);
      expect(h.x).toBeLessThanOrEqual(arena.x + arena.width - h.radius + 1e-6);
      expect(h.y).toBeGreaterThanOrEqual(arena.y + h.radius - 1e-6);
      expect(h.y).toBeLessThanOrEqual(arena.y + arena.height - h.radius + 1e-6);
    }
    expect(Math.hypot(h.vx, h.vy)).toBeCloseTo(CONFIG.hazard.speed, 3); // speed unchanged
  });
});

describe('lives and game state', () => {
  it('does not run until the run is started', () => {
    const s = createGame(1);
    expect(s.status).toBe('ready');
    stepGame(s, { dx: 1, dy: 0 }, STEP);
    expect(s.timeMs).toBe(0);
    startRun(s);
    expect(s.status).toBe('playing');
  });

  it('starts with three lives', () => {
    expect(createGame(1).player.lives).toBe(3);
  });

  it('loses one life on a hit and becomes invulnerable', () => {
    const s = quietGame();
    overlapHazard(s);
    const result = stepGame(s, IDLE, STEP);
    expect(result).toEqual({ hit: true, gameOver: false });
    expect(s.player.lives).toBe(2);
    expect(s.player.invulnerableMs).toBe(CONFIG.player.invulnerableMs);
  });

  it('cannot be hit again while invulnerable', () => {
    const s = quietGame();
    overlapHazard(s);
    stepGame(s, IDLE, STEP);
    for (let i = 0; i < 30; i++) stepGame(s, IDLE, STEP); // half a second, still overlapping
    expect(s.player.lives).toBe(2);
  });

  it('can be hit again once invulnerability ends', () => {
    const s = quietGame();
    overlapHazard(s);
    stepGame(s, IDLE, STEP);
    const stepsToWait = Math.ceil(CONFIG.player.invulnerableMs / STEP) + 2;
    for (let i = 0; i < stepsToWait; i++) stepGame(s, IDLE, STEP);
    expect(s.player.lives).toBe(1);
  });

  it('ends the game after the third hit and stops the clock', () => {
    const s = quietGame();
    overlapHazard(s);
    let last = stepGame(s, IDLE, STEP);
    const wait = Math.ceil(CONFIG.player.invulnerableMs / STEP) + 2;
    while (s.status === 'playing') {
      last = stepGame(s, IDLE, STEP);
      if (s.status === 'playing' && s.player.invulnerableMs === CONFIG.player.invulnerableMs) {
        for (let i = 0; i < wait; i++) { last = stepGame(s, IDLE, STEP); if (s.status !== 'playing') break; }
      }
    }
    expect(s.status).toBe('gameover');
    expect(s.player.lives).toBe(0);
    expect(last.gameOver).toBe(true);

    const frozenTime = s.timeMs;
    stepGame(s, IDLE, STEP);
    expect(s.timeMs).toBe(frozenTime);
  });

  it('counts survival time only while playing', () => {
    const s = quietGame();
    for (let i = 0; i < 120; i++) stepGame(s, IDLE, STEP);
    expect(s.timeMs).toBeCloseTo(2000, 3);
  });
});

describe('FixedStepper', () => {
  it('runs one step per 60Hz frame', () => {
    const st = new FixedStepper();
    let total = 0;
    for (let i = 0; i < 60; i++) total += st.advance(1000 / 60);
    expect(total).toBe(60);
  });

  it('runs the same number of steps on a 144Hz display', () => {
    const st = new FixedStepper();
    let total = 0;
    for (let i = 0; i < 144; i++) total += st.advance(1000 / 144);
    expect(total).toBe(60);
  });

  it('caps huge frames so a background tab cannot cause a time jump', () => {
    const st = new FixedStepper();
    expect(st.advance(5000)).toBe(Math.floor(CONFIG.timestep.maxFrameMs / STEP + 1e-9));
  });

  it('ignores negative frame times', () => {
    expect(new FixedStepper().advance(-50)).toBe(0);
  });
});

describe('formatTime', () => {
  it('formats minutes and seconds', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(59_999)).toBe('00:59');
    expect(formatTime(60_000)).toBe('01:00');
    expect(formatTime(754_321)).toBe('12:34');
  });
});
