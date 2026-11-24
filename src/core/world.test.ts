import { describe, expect, it } from 'vitest';
import { activateAbility } from './abilities';
import { circleHitsRect, rectsTooClose } from './collision';
import { CONFIG, type Config } from './config';
import { createGame, startRun, stepGame } from './game';
import { addDrifter, quietGame } from './testUtils';
import type { InputState } from './types';

const STEP = CONFIG.timestep.stepMs;
const IDLE: InputState = { dx: 0, dy: 0 };
const { arena, abilities } = CONFIG;

function run(state: ReturnType<typeof quietGame>, steps: number, input: InputState = IDLE): void {
  for (let i = 0; i < steps; i++) stepGame(state, input, STEP);
}

describe('barriers', () => {
  it('are placed fairly for many seeds', () => {
    for (let seed = 0; seed < 200; seed++) {
      const s = createGame(seed);
      expect(s.barriers).toHaveLength(CONFIG.barriers.count);
      for (const [i, b] of s.barriers.entries()) {
        const m = CONFIG.barriers.wallMargin;
        expect(b.x).toBeGreaterThanOrEqual(arena.x + m - 1e-9);
        expect(b.y).toBeGreaterThanOrEqual(arena.y + m - 1e-9);
        expect(b.x + b.width).toBeLessThanOrEqual(arena.x + arena.width - m + 1e-9);
        expect(b.y + b.height).toBeLessThanOrEqual(arena.y + arena.height - m + 1e-9);
        // never on or right next to the player's starting spot
        expect(circleHitsRect({ x: s.player.x, y: s.player.y, radius: CONFIG.barriers.minDistanceFromPlayer }, b)).toBe(false);
        for (const other of s.barriers.slice(i + 1)) {
          expect(rectsTooClose(b, other, CONFIG.barriers.separation - 1e-6)).toBe(false);
        }
      }
    }
  });

  it('are identical for the same seed', () => {
    expect(createGame(99).barriers).toEqual(createGame(99).barriers);
  });
});

describe('moving obstacles (drifters)', () => {
  function spawnOne(seed: number) {
    const s = quietGame(seed);
    s.spawn.drifterMs = 0;
    stepGame(s, IDLE, STEP);
    return s;
  }

  it('spawn on the arena edge as a harmless marker, never near the player', () => {
    for (let seed = 0; seed < 200; seed++) {
      const s = spawnOne(seed);
      expect(s.drifters).toHaveLength(1);
      const d = s.drifters[0];
      expect(d.warningMs).toBeGreaterThan(0);
      expect(Math.hypot(d.x - s.player.x, d.y - s.player.y)).toBeGreaterThanOrEqual(CONFIG.drifters.minEntryDistance);
      const onEdge =
        Math.abs(d.x - (arena.x + d.radius)) < 1e-6 ||
        Math.abs(d.x - (arena.x + arena.width - d.radius)) < 1e-6 ||
        Math.abs(d.y - (arena.y + d.radius)) < 1e-6 ||
        Math.abs(d.y - (arena.y + arena.height - d.radius)) < 1e-6;
      expect(onEdge).toBe(true);
    }
  });

  it('have speeds inside their configured range', () => {
    for (let seed = 0; seed < 100; seed++) {
      const d = spawnOne(seed).drifters[0];
      const [min, max] = CONFIG.drifters.types[d.kind].speed;
      const speed = Math.hypot(d.vx, d.vy);
      expect(speed).toBeGreaterThanOrEqual(min - 1e-6);
      expect(speed).toBeLessThanOrEqual(max + 1e-6);
    }
  });

  it('do not move and cannot hurt during the warning, then start moving', () => {
    const s = quietGame();
    const d = addDrifter(s, { vx: 100, vy: 0, warningMs: 500 }); // sitting on the player
    const startX = d.x;
    run(s, 20); // ~333 ms
    expect(d.x).toBe(startX);
    expect(s.player.lives).toBe(3);
    run(s, 20); // warning over
    expect(d.x).toBeGreaterThan(startX);
  });

  it('hurt on contact once active', () => {
    const s = quietGame();
    addDrifter(s, { x: s.player.x + 100, vx: -300 }); // flying at the player
    run(s, 60);
    expect(s.player.lives).toBe(2);
  });

  it('are removed after leaving the arena', () => {
    const s = quietGame();
    addDrifter(s, { x: arena.x + 40, y: arena.y + 40, vx: -400, vy: 0 });
    run(s, 60);
    expect(s.drifters).toHaveLength(0);
  });

  it('never exceed the configured maximum', () => {
    const s = quietGame(3);
    s.player.invulnerableMs = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 6000; i++) {
      s.spawn.drifterMs = 0; // force a spawn attempt every step
      stepGame(s, IDLE, STEP);
      expect(s.drifters.length).toBeLessThanOrEqual(CONFIG.drifters.max);
    }
  });
});

describe('traps', () => {
  it('spawn away from the player and walls', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = createGame(seed);
      startRun(s);
      s.spawn.trapMs = 0;
      stepGame(s, IDLE, STEP);
      expect(s.traps).toHaveLength(1);
      const t = s.traps[0];
      expect(Math.hypot(t.x - s.player.x, t.y - s.player.y)).toBeGreaterThanOrEqual(CONFIG.traps.minDistanceFromPlayer);
      expect(s.barriers.some((b) => circleHitsRect(t, b))).toBe(false);
    }
  });

  it('are harmless during the warning and dangerous once active', () => {
    const s = quietGame();
    s.traps = [{ x: s.player.x, y: s.player.y, radius: 34, warningMs: 1000, activeMs: 3000 }];
    run(s, 45); // 750 ms: still warning
    expect(s.player.lives).toBe(3);
    run(s, 30); // warning over
    expect(s.player.lives).toBe(2);
  });

  it('disappear after their active time', () => {
    const s = quietGame();
    s.traps = [{ x: arena.x + 50, y: arena.y + 50, radius: 34, warningMs: 100, activeMs: 200 }];
    run(s, 30);
    expect(s.traps).toHaveLength(0);
  });
});

describe('energy orbs', () => {
  it('spawn on open floor, never on the player', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = createGame(seed);
      startRun(s);
      s.spawn.orbMs = 0;
      stepGame(s, IDLE, STEP);
      expect(s.orbs).toHaveLength(1);
      const o = s.orbs[0];
      expect(Math.hypot(o.x - s.player.x, o.y - s.player.y)).toBeGreaterThanOrEqual(CONFIG.orbs.minDistanceFromPlayer - 1);
      expect(s.barriers.some((b) => circleHitsRect(o, b))).toBe(false);
    }
  });

  it('give energy when touched, count as collected, and are removed', () => {
    const s = quietGame();
    s.orbs = [{ x: s.player.x, y: s.player.y, radius: 7, ttlMs: 10000 }];
    const result = stepGame(s, IDLE, STEP);
    expect(s.energy).toBe(CONFIG.energy.perOrb);
    expect(s.orbsCollected).toBe(1);
    expect(s.orbs).toHaveLength(0);
    expect(result.pickups).toHaveLength(1);
  });

  it('never push energy above the maximum', () => {
    const s = quietGame();
    s.energy = CONFIG.energy.max - 3;
    s.orbs = [{ x: s.player.x, y: s.player.y, radius: 7, ttlMs: 10000 }];
    stepGame(s, IDLE, STEP);
    expect(s.energy).toBe(CONFIG.energy.max);
  });

  it('expire after their lifetime', () => {
    const s = quietGame();
    s.orbs = [{ x: arena.x + 30, y: arena.y + 30, radius: 7, ttlMs: 500 }];
    run(s, 40);
    expect(s.orbs).toHaveLength(0);
    expect(s.energy).toBe(0);
  });

  it('do not add to the survival score: time is only the clock', () => {
    const s = quietGame();
    s.orbs = [{ x: s.player.x, y: s.player.y, radius: 7, ttlMs: 10000 }];
    run(s, 60);
    expect(s.timeMs).toBeCloseTo(1000, 3);
  });
});

describe('abilities: general rules', () => {
  it('cannot be used without enough energy, and cost nothing when refused', () => {
    const s = quietGame();
    s.energy = abilities.shield.cost - 1;
    expect(activateAbility(s, 'shield')).toEqual({ ok: false, reason: 'no-energy' });
    expect(s.energy).toBe(abilities.shield.cost - 1);
    expect(s.abilities.shield.activeMs).toBe(0);
  });

  it('spend exactly their energy cost', () => {
    for (const id of ['shield', 'slow', 'teleport', 'magnet'] as const) {
      const s = quietGame();
      s.energy = 100;
      expect(activateAbility(s, id).ok).toBe(true);
      expect(s.energy).toBe(100 - abilities[id].cost);
    }
  });

  it('cannot be used before the game starts', () => {
    const s = createGame(1);
    s.energy = 100;
    expect(activateAbility(s, 'shield')).toEqual({ ok: false, reason: 'not-playing' });
  });

  it('cannot be reactivated while running or on cooldown', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'magnet');
    expect(activateAbility(s, 'magnet')).toEqual({ ok: false, reason: 'active' });

    activateAbility(s, 'teleport');
    expect(activateAbility(s, 'teleport')).toEqual({ ok: false, reason: 'cooldown' });
    run(s, Math.ceil(abilities.teleport.cooldownMs / STEP) + 2);
    expect(activateAbility(s, 'teleport').ok).toBe(true);
  });
});

describe('shield', () => {
  it('absorbs one hit without losing a life, then pops', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'shield');
    addDrifter(s);
    const result = stepGame(s, IDLE, STEP);
    expect(result.shieldBlocked).toBe(true);
    expect(result.hit).toBe(false);
    expect(s.player.lives).toBe(3);
    expect(s.abilities.shield.activeMs).toBe(0);
    expect(s.player.invulnerableMs).toBeGreaterThan(0);
  });

  it('leaves you hit-able after the short grace period', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'shield');
    addDrifter(s); // keeps overlapping
    run(s, Math.ceil(abilities.shield.blockInvulnerableMs / STEP) + 3);
    expect(s.player.lives).toBe(2);
  });

  it('also blocks active traps', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'shield');
    s.traps = [{ x: s.player.x, y: s.player.y, radius: 34, warningMs: 0, activeMs: 3000 }];
    stepGame(s, IDLE, STEP);
    expect(s.player.lives).toBe(3);
  });

  it('expires after its duration', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'shield');
    run(s, Math.ceil(abilities.shield.durationMs / STEP) + 2);
    expect(s.abilities.shield.activeMs).toBe(0);
  });
});

describe('slow motion', () => {
  it('slows obstacles to the configured fraction but not the player', () => {
    const slowed = quietGame();
    slowed.energy = 100;
    activateAbility(slowed, 'slow');
    const a = addDrifter(slowed, { x: arena.x + 100, y: arena.y + 100, vx: 100 });
    const px = slowed.player.x;
    run(slowed, 30, { dx: 1, dy: 0 });

    const normal = quietGame();
    const b = addDrifter(normal, { x: arena.x + 100, y: arena.y + 100, vx: 100 });
    run(normal, 30, { dx: 1, dy: 0 });

    expect(a.x - (arena.x + 100)).toBeCloseTo((b.x - (arena.x + 100)) * abilities.slow.factor, 3);
    expect(slowed.player.x - px).toBeCloseTo(normal.player.x - px, 3); // player speed unchanged
  });
});

describe('magnet', () => {
  it('pulls nearby orbs toward the player', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'magnet');
    s.orbs = [{ x: s.player.x + 100, y: s.player.y, radius: 7, ttlMs: 10000 }];
    run(s, 10);
    expect(s.orbs[0].x).toBeLessThan(s.player.x + 100 - 10);
  });

  it('eventually delivers the orb', () => {
    const s = quietGame();
    s.energy = 0;
    s.abilities.magnet.activeMs = 6000; // already running
    s.orbs = [{ x: s.player.x + 120, y: s.player.y, radius: 7, ttlMs: 10000 }];
    run(s, 60);
    expect(s.orbsCollected).toBe(1);
  });

  it('ignores orbs outside its radius', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'magnet');
    const far = abilities.magnet.radius + 50;
    s.orbs = [{ x: s.player.x + far, y: s.player.y, radius: 7, ttlMs: 10000 }];
    run(s, 20);
    expect(s.orbs[0].x).toBeCloseTo(s.player.x + far);
  });

  it('does nothing once it has run out', () => {
    const s = quietGame();
    s.energy = 100;
    activateAbility(s, 'magnet');
    run(s, Math.ceil(abilities.magnet.durationMs / STEP) + 2);
    s.orbs = [{ x: s.player.x + 100, y: s.player.y, radius: 7, ttlMs: 10000 }];
    run(s, 10);
    expect(s.orbs[0].x).toBeCloseTo(s.player.x + 100);
  });
});

describe('teleport', () => {
  it('lands somewhere safe and far enough away, for many seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = createGame(seed);
      startRun(s);
      s.energy = 100;
      s.spawn = { drifterMs: 1e12, trapMs: 1e12, orbMs: 1e12 };
      addDrifter(s, { x: arena.x + 300, y: arena.y + 200, vx: 50 });
      s.traps = [{ x: arena.x + 600, y: arena.y + 300, radius: 34, warningMs: 0, activeMs: 5000 }];
      const result = activateAbility(s, 'teleport');
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const { to, from } = result;
      expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThanOrEqual(abilities.teleport.minDistance);
      expect([s.player.x, s.player.y]).toEqual([to.x, to.y]);
      const r = s.player.radius;
      expect(to.x).toBeGreaterThanOrEqual(arena.x + r);
      expect(to.x).toBeLessThanOrEqual(arena.x + arena.width - r);
      expect(to.y).toBeGreaterThanOrEqual(arena.y + r);
      expect(to.y).toBeLessThanOrEqual(arena.y + arena.height - r);
      expect(s.barriers.some((b) => circleHitsRect({ x: to.x, y: to.y, radius: r }, b))).toBe(false);
      expect(s.traps.some((t) => Math.hypot(to.x - t.x, to.y - t.y) < t.radius + r)).toBe(false);
      expect(s.drifters.some((d) => Math.hypot(to.x - d.x, to.y - d.y) < d.radius + r)).toBe(false);
    }
  });

  it('fails without spending energy when no safe spot exists', () => {
    const impossible: Config = {
      ...CONFIG,
      abilities: { ...CONFIG.abilities, teleport: { ...CONFIG.abilities.teleport, minDistance: 5000 } },
    };
    const s = quietGame(1, impossible);
    s.energy = 100;
    const before = { x: s.player.x, y: s.player.y };
    expect(activateAbility(s, 'teleport', impossible)).toEqual({ ok: false, reason: 'no-safe-spot' });
    expect(s.energy).toBe(100);
    expect([s.player.x, s.player.y]).toEqual([before.x, before.y]);
    expect(s.abilities.teleport.cooldownMs).toBe(0);
  });
});

describe('determinism', () => {
  it('replays identically for the same seed and inputs', () => {
    function play(seed: number): string {
      const s = createGame(seed);
      startRun(s);
      const inputs: InputState[] = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: -1 }, IDLE];
      for (let i = 0; i < 1800; i++) {
        stepGame(s, inputs[Math.floor(i / 45) % inputs.length], STEP);
        if (i === 300) { s.energy = 100; activateAbility(s, 'teleport'); }
      }
      return JSON.stringify(s);
    }
    expect(play(12345)).toBe(play(12345));
    expect(play(12345)).not.toBe(play(54321));
  });
});
