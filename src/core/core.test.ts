import { describe, expect, it } from 'vitest';
import { circleHitsCircle, circleHitsRect, pushCircleOutOfRect, rectsTooClose } from './collision';
import { CONFIG } from './config';
import { formatTime } from './format';
import { startRun } from './game';
import { Rng } from './rng';
import { FixedStepper } from './stepper';
import { addDrifter, me, quietGame, soloMatch, step } from './testUtils';
import type { InputState } from './types';

const STEP = CONFIG.timestep.stepMs;
const IDLE: InputState = { dx: 0, dy: 0 };
const { arena } = CONFIG;

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
      expect([3, 4, 5]).toContain(rng.int(3, 5));
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

  it('pushes a circle out of a rectangle along the nearest direction', () => {
    const rect = { x: 100, y: 100, width: 50, height: 50 };
    const c = { x: 97, y: 120, radius: 9 }; // overlapping the left edge by 6
    expect(pushCircleOutOfRect(c, rect)).toBe(true);
    expect(c.x).toBeCloseTo(91);
    expect(c.y).toBeCloseTo(120); // slides: no sideways movement
  });

  it('pushes a circle whose centre is inside the rectangle out through the closest side', () => {
    const rect = { x: 100, y: 100, width: 50, height: 50 };
    const c = { x: 145, y: 125, radius: 9 }; // 5px from the right edge
    pushCircleOutOfRect(c, rect);
    expect(c.x).toBeCloseTo(159);
  });

  it('leaves a circle alone when it is not touching', () => {
    const c = { x: 0, y: 0, radius: 9 };
    expect(pushCircleOutOfRect(c, { x: 100, y: 100, width: 10, height: 10 })).toBe(false);
    expect([c.x, c.y]).toEqual([0, 0]);
  });

  it('measures the gap between rectangles', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsTooClose(a, { x: 40, y: 0, width: 10, height: 10 }, 20)).toBe(false);
    expect(rectsTooClose(a, { x: 25, y: 0, width: 10, height: 10 }, 20)).toBe(true);
  });
});

describe('player movement', () => {
  it('moves at the configured speed', () => {
    const s = quietGame();
    const startX = me(s).x;
    for (let i = 0; i < 60; i++) step(s, { dx: 1, dy: 0 });
    expect(me(s).x - startX).toBeCloseTo(CONFIG.player.speed, 3);
  });

  it('moves diagonally at the same speed as straight', () => {
    const s = quietGame();
    const { x, y } = me(s);
    for (let i = 0; i < 30; i++) step(s, { dx: 1, dy: 1 });
    expect(Math.hypot(me(s).x - x, me(s).y - y)).toBeCloseTo(CONFIG.player.speed * 0.5, 3);
  });

  it('stays inside the arena on every side', () => {
    const s = quietGame();
    const r = me(s).radius;
    for (let i = 0; i < 600; i++) step(s, { dx: -1, dy: -1 });
    expect(me(s).x).toBeCloseTo(arena.x + r);
    expect(me(s).y).toBeCloseTo(arena.y + r);
    for (let i = 0; i < 900; i++) step(s, { dx: 1, dy: 1 });
    expect(me(s).x).toBeCloseTo(arena.x + arena.width - r);
    expect(me(s).y).toBeCloseTo(arena.y + arena.height - r);
  });

  it('does not move when there is no input', () => {
    const s = quietGame();
    const { x, y } = me(s);
    step(s, IDLE);
    expect([me(s).x, me(s).y]).toEqual([x, y]);
  });

  it('is blocked by a barrier and slides along it', () => {
    const s = quietGame();
    const wall = { x: me(s).x + 60, y: me(s).y - 200, width: 16, height: 400, warningMs: 0 };
    s.barriers = [wall];
    for (let i = 0; i < 120; i++) step(s, { dx: 1, dy: 0 });
    expect(me(s).x + me(s).radius).toBeLessThanOrEqual(wall.x + 1e-6); // never inside the wall

    const yBefore = me(s).y;
    for (let i = 0; i < 30; i++) step(s, { dx: 1, dy: 1 }); // pushing diagonally into it
    expect(me(s).x + me(s).radius).toBeLessThanOrEqual(wall.x + 1e-6);
    expect(me(s).y).toBeGreaterThan(yBefore + 20); // still slid downward along the wall
  });
});

describe('lives and game state', () => {
  it('does not run until the run is started', () => {
    const s = soloMatch(1);
    expect(s.status).toBe('ready');
    step(s, { dx: 1, dy: 0 });
    expect(s.timeMs).toBe(0);
    startRun(s);
    expect(s.status).toBe('playing');
  });

  it('starts with three lives and no energy', () => {
    const s = soloMatch(1);
    expect(me(s).lives).toBe(3);
    expect(me(s).energy).toBe(0);
  });

  it('loses one life on a hit and becomes invulnerable', () => {
    const s = quietGame();
    addDrifter(s);
    const result = step(s, IDLE);
    expect(result.hits).toEqual([{ playerId: 'p1' }]);
    expect(result.deaths).toHaveLength(0);
    expect(me(s).lives).toBe(2);
    expect(me(s).invulnerableMs).toBeCloseTo(CONFIG.player.invulnerableMs - 0, 5);
  });

  it('cannot be hit again while invulnerable', () => {
    const s = quietGame();
    addDrifter(s);
    step(s, IDLE);
    for (let i = 0; i < 30; i++) step(s, IDLE); // half a second, still overlapping
    expect(me(s).lives).toBe(2);
  });

  it('can be hit again once invulnerability ends', () => {
    const s = quietGame();
    addDrifter(s);
    step(s, IDLE);
    const wait = Math.ceil(CONFIG.player.invulnerableMs / STEP) + 2;
    for (let i = 0; i < wait; i++) step(s, IDLE);
    expect(me(s).lives).toBe(1);
  });

  it('freezes the player after the third hit, but the match goes on', () => {
    const s = quietGame();
    me(s).orbs = 7;
    me(s).energy = 50;
    const drifter = addDrifter(s);
    let died = false;
    for (let i = 0; i < 1000 && !died; i++) died = step(s, IDLE).deaths.length > 0;
    expect(died).toBe(true);
    drifter.x = arena.x + 30; // get it out of the way
    drifter.y = arena.y + 30;

    expect(me(s).alive).toBe(false);
    expect(me(s).lives).toBe(0);
    expect(me(s).deaths).toBe(1);
    expect(me(s).respawnMs).toBeCloseTo(CONFIG.player.respawn.freezeMs, 0);
    expect(me(s).orbs).toBe(7); // the score is never lost
    expect(me(s).energy).toBe(0); // energy is
    expect(s.status).toBe('playing');
  });

  it('respawns after the freeze with fewer lives, protection and no energy', () => {
    const s = quietGame();
    const drifter = addDrifter(s);
    for (let i = 0; i < 1000 && me(s).alive; i++) step(s, IDLE);
    drifter.x = arena.x + 30;
    drifter.y = arena.y + 30;
    drifter.vx = 0;

    let respawned = false;
    const freezeSteps = Math.ceil(CONFIG.player.respawn.freezeMs / STEP) + 3;
    for (let i = 0; i < freezeSteps; i++) if (step(s, IDLE).respawns.length > 0) respawned = true;
    expect(respawned).toBe(true);
    expect(me(s).alive).toBe(true);
    expect(me(s).lives).toBe(CONFIG.player.respawn.lives);
    expect(me(s).invulnerableMs).toBeGreaterThan(0);
    expect(me(s).invulnerableMs).toBeLessThanOrEqual(CONFIG.player.respawn.invulnerableMs);
    expect(me(s).energy).toBe(0);
  });

  it('cannot be hurt, collect orbs or use abilities while frozen', () => {
    const s = quietGame();
    me(s).alive = false;
    me(s).respawnMs = 4000;
    me(s).energy = 100;
    addDrifter(s);
    s.orbs = [{ x: me(s).x, y: me(s).y, radius: 7, ttlMs: 9000 }];
    step(s, IDLE);
    expect(me(s).lives).toBe(3);
    expect(s.orbs).toHaveLength(1);
  });

  it('counts match time only while playing and ends the match after 4 minutes', () => {
    const s = quietGame();
    for (let i = 0; i < 120; i++) step(s, IDLE);
    expect(s.timeMs).toBeCloseTo(2000, 3);

    s.timeMs = CONFIG.match.durationMs - STEP * 2;
    let finished = false;
    for (let i = 0; i < 5; i++) if (step(s, IDLE).finished) finished = true;
    expect(finished).toBe(true);
    expect(s.status).toBe('finished');

    const frozen = s.timeMs;
    step(s, { dx: 1, dy: 0 });
    expect(s.timeMs).toBe(frozen);
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
