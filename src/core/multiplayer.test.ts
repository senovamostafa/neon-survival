import { describe, expect, it } from 'vitest';
import { activateAbility } from './abilities';
import { botAbility, botInput } from './bots';
import { circleHitsRect } from './collision';
import { CONFIG } from './config';
import { getDifficulty } from './difficulty';
import { createMatch, startRun, stepGame } from './game';
import { setConnected, spawnPositions } from './players';
import { rankPlayers } from './ranking';
import { Rng } from './rng';
import { addDrifter, me, quietGame, roster, STEP_MS } from './testUtils';
import type { GameState, InputMap, StepResult } from './types';

const { arena, bump } = CONFIG;

function run(state: GameState, steps: number, inputs: InputMap = {}): StepResult[] {
  const results: StepResult[] = [];
  for (let i = 0; i < steps; i++) results.push(stepGame(state, inputs, STEP_MS));
  return results;
}

/** Puts two players in the middle of an empty arena, `gap` pixels apart on the x axis. */
function twoPlayers(gap: number): GameState {
  const s = quietGame(1, CONFIG, 2);
  s.players[0].x = 400;
  s.players[0].y = 300;
  s.players[1].x = 400 + gap;
  s.players[1].y = 300;
  return s;
}

describe('starting positions', () => {
  it('spread everyone out inside the arena and clear of the walls, for 3 to 10 players', () => {
    for (let n = 3; n <= 10; n++) {
      for (let seed = 0; seed < 30; seed++) {
        const s = createMatch(seed, roster(n));
        expect(s.players).toHaveLength(n);
        for (const [i, a] of s.players.entries()) {
          expect(a.x).toBeGreaterThan(arena.x);
          expect(a.x).toBeLessThan(arena.x + arena.width);
          expect(a.y).toBeGreaterThan(arena.y);
          expect(a.y).toBeLessThan(arena.y + arena.height);
          for (const b of s.players.slice(i + 1)) {
            // at least a full corridor cell apart
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(58 - 1e-6);
          }
          for (const wall of s.barriers) {
            expect(circleHitsRect({ x: a.x, y: a.y, radius: a.radius }, wall)).toBe(false);
          }
        }
      }
    }
  });

  it('give every player a different hero colour', () => {
    const s = createMatch(1, roster(10));
    expect(new Set(s.players.map((p) => p.colorIndex)).size).toBe(10);
  });

  it('are the same for the same seed and differ between seeds', () => {
    const a = spawnPositions(5, new Rng(3), CONFIG);
    const b = spawnPositions(5, new Rng(3), CONFIG);
    const c = spawnPositions(5, new Rng(4), CONFIG);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('bumping', () => {
  it('shoves two touching players straight apart, about 50 px each', () => {
    const s = twoPlayers(10); // radii are 9 each, so 10 px apart overlaps
    const results = run(s, 1);
    expect(results[0].bumps).toEqual([{ a: 'p1', b: 'p2' }]);
    // opposite directions along the line between them
    expect(s.players[0].bumpVx).toBeLessThan(0);
    expect(s.players[1].bumpVx).toBeGreaterThan(0);
    expect(s.players[0].bumpVx).toBeCloseTo(-s.players[1].bumpVx);
    expect(Math.abs(s.players[0].bumpVy)).toBeLessThan(1e-6);

    run(s, Math.ceil(bump.durationMs / STEP_MS) + 2);
    expect(400 - s.players[0].x).toBeCloseTo(bump.distance, 0);
    expect(s.players[1].x - 410).toBeCloseTo(bump.distance, 0);
  });

  it('pushes along the line between the two players, whatever the angle', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].x = 400;
    s.players[0].y = 300;
    s.players[1].x = 407;
    s.players[1].y = 307; // diagonal, about 9.9 apart
    run(s, 1);
    const a = s.players[0];
    const b = s.players[1];
    expect(a.bumpVx).toBeCloseTo(-b.bumpVx);
    expect(a.bumpVy).toBeCloseTo(-b.bumpVy);
    expect(a.bumpVx).toBeLessThan(0);
    expect(a.bumpVy).toBeLessThan(0); // p1 is up-left of p2, so it flies up-left
    expect(Math.hypot(a.bumpVx, a.bumpVy)).toBeCloseTo(bump.distance / (bump.durationMs / 1000));
  });

  it('picks a direction (still opposite) when two players are exactly on top of each other', () => {
    const s = twoPlayers(0);
    run(s, 1);
    const a = s.players[0];
    const b = s.players[1];
    expect(Math.hypot(a.bumpVx, a.bumpVy)).toBeGreaterThan(100);
    expect(a.bumpVx).toBeCloseTo(-b.bumpVx);
    expect(a.bumpVy).toBeCloseTo(-b.bumpVy);
  });

  it('does no damage and costs nothing', () => {
    const s = twoPlayers(10);
    s.players[0].energy = 40;
    s.players[0].orbs = 3;
    run(s, 40);
    for (const p of s.players) expect(p.lives).toBe(CONFIG.player.lives);
    expect(s.players[0].energy).toBe(40);
    expect(s.players[0].orbs).toBe(3);
  });

  it('cannot repeat for the same pair until the cooldown ends', () => {
    const s = twoPlayers(10);
    expect(run(s, 1)[0].bumps).toHaveLength(1);
    // pull them back together straight away: still cooling down
    s.players[0].x = 400; s.players[1].x = 410; s.players[0].bumpMs = 0; s.players[1].bumpMs = 0;
    expect(run(s, 5).flatMap((r) => r.bumps)).toHaveLength(0);
    // keep them apart while the cooldown runs out, then bring them together again
    s.players[1].x = 700;
    run(s, Math.ceil(bump.cooldownMs / STEP_MS) + 2);
    s.players[0].x = 400; s.players[1].x = 410; s.players[0].bumpMs = 0; s.players[1].bumpMs = 0;
    expect(run(s, 2).flatMap((r) => r.bumps)).toHaveLength(1);
  });

  it('is stopped by walls: a shove into a wall cannot pass through it', () => {
    const s = twoPlayers(10);
    const wall = { x: 330, y: 200, width: 16, height: 200, warningMs: 0 };
    s.barriers = [wall];
    run(s, 40);
    expect(s.players[0].x - s.players[0].radius).toBeGreaterThanOrEqual(wall.x + wall.width - 1e-6);
  });

  it('is stopped by the arena edge', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].x = arena.x + s.players[0].radius + 2;
    s.players[0].y = 300;
    s.players[1].x = s.players[0].x + 10;
    s.players[1].y = 300;
    run(s, 40);
    expect(s.players[0].x).toBeGreaterThanOrEqual(arena.x + s.players[0].radius - 1e-9);
  });

  it('still shoves shielded or invulnerable players', () => {
    const s = twoPlayers(10);
    s.players[0].invulnerableMs = 99_999;
    expect(run(s, 1)[0].bumps).toHaveLength(1);
  });

  it('ignores frozen players', () => {
    const s = twoPlayers(10);
    s.players[1].alive = false;
    s.players[1].respawnMs = 4000;
    expect(run(s, 5).flatMap((r) => r.bumps)).toHaveLength(0);
  });

  it('still lets the player steer during a bump', () => {
    const s = twoPlayers(10);
    run(s, 1);
    const y0 = s.players[0].y;
    run(s, 10, { p1: { dx: 0, dy: 1 } });
    expect(s.players[0].y - y0).toBeCloseTo((CONFIG.player.speed * 10 * STEP_MS) / 1000, 1);
  });
});

describe('contested orbs', () => {
  it('go to the nearest player when several touch the same orb', () => {
    const s = twoPlayers(6);
    s.orbs = [{ x: 402, y: 300, radius: 7, ttlMs: 9000 }]; // 2 px from p1, 4 px from p2
    const result = run(s, 1)[0];
    expect(s.players[0].orbs).toBe(1);
    expect(s.players[1].orbs).toBe(0);
    expect(result.pickups).toEqual([{ playerId: 'p1', x: 402, y: 300 }]);
    expect(s.orbs).toHaveLength(0); // a collected orb is gone for everyone
  });

  it('give the taker both a point and 10 energy, and never lower the score', () => {
    const s = quietGame();
    s.orbs = [{ x: me(s).x, y: me(s).y, radius: 7, ttlMs: 9000 }];
    run(s, 1);
    expect(me(s).orbs).toBe(1);
    expect(me(s).energy).toBe(CONFIG.energy.perOrb);
    me(s).energy = 100;
    activateAbility(s, 'p1', 'shield');
    expect(me(s).energy).toBe(60);
    expect(me(s).orbs).toBe(1); // spending energy leaves the score alone
  });

  it('record when each player reached their count', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].x = 300; s.players[0].y = 300;
    s.players[1].x = 700; s.players[1].y = 300;
    s.timeMs = 5000;
    s.orbs = [{ x: 300, y: 300, radius: 7, ttlMs: 9000 }];
    run(s, 1);
    expect(s.players[0].lastOrbAtMs).toBeCloseTo(5000 + STEP_MS, 3);
    expect(s.players[1].lastOrbAtMs).toBeNull();
  });

  it('can be stolen with a magnet', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].x = 300; s.players[0].y = 300; // would walk to the orb
    s.players[1].x = 500; s.players[1].y = 300;
    s.players[1].energy = 100;
    activateAbility(s, 'p2', 'magnet');
    s.orbs = [{ x: 380, y: 300, radius: 7, ttlMs: 9000 }]; // 80 from p1, 120 from p2
    run(s, 60);
    expect(s.players[1].orbs).toBe(1);
    expect(s.players[0].orbs).toBe(0);
  });

  it('are ignored by frozen players', () => {
    const s = quietGame();
    me(s).alive = false;
    me(s).respawnMs = 4000;
    s.orbs = [{ x: me(s).x, y: me(s).y, radius: 7, ttlMs: 9000 }];
    run(s, 1);
    expect(me(s).orbs).toBe(0);
    expect(s.orbs).toHaveLength(1);
  });
});

describe('personal abilities in a shared arena', () => {
  it('shield protects only its owner', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].x = 300; s.players[0].y = 300;
    s.players[1].x = 700; s.players[1].y = 300;
    s.players[0].energy = 100;
    activateAbility(s, 'p1', 'shield');
    addDrifter(s, { x: 300, y: 300 });
    addDrifter(s, { x: 700, y: 300 });
    const result = run(s, 1)[0];
    expect(result.shieldBlocks).toEqual([{ playerId: 'p1' }]);
    expect(result.hits).toEqual([{ playerId: 'p2' }]);
    expect(s.players[0].lives).toBe(3);
    expect(s.players[1].lives).toBe(2);
  });

  it('energy and cooldowns are per player', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].energy = 100;
    expect(activateAbility(s, 'p2', 'magnet')).toEqual({ ok: false, reason: 'no-energy' });
    expect(activateAbility(s, 'p1', 'magnet').ok).toBe(true);
    expect(s.players[1].abilities.magnet.activeMs).toBe(0);
  });

  it('teleport moves only the caster', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].energy = 100;
    const other = { x: s.players[1].x, y: s.players[1].y };
    const before = { x: s.players[0].x, y: s.players[0].y };
    const result = activateAbility(s, 'p1', 'teleport');
    expect(result.ok).toBe(true);
    expect([s.players[1].x, s.players[1].y]).toEqual([other.x, other.y]);
    expect([s.players[0].x, s.players[0].y]).not.toEqual([before.x, before.y]);
  });

  it('are refused for unknown or frozen players', () => {
    const s = quietGame(1, CONFIG, 2);
    expect(activateAbility(s, 'nobody', 'shield')).toEqual({ ok: false, reason: 'unknown-player' });
    s.players[0].energy = 100;
    s.players[0].alive = false;
    expect(activateAbility(s, 'p1', 'shield')).toEqual({ ok: false, reason: 'down' });
  });
});

describe('final ranking', () => {
  function ranked(setup: (p: GameState['players']) => void) {
    const s = quietGame(1, CONFIG, 4);
    setup(s.players);
    return rankPlayers(s).map((r) => r.playerId);
  }

  it('puts the most orbs first', () => {
    expect(ranked((p) => { p[0].orbs = 3; p[1].orbs = 9; p[2].orbs = 5; p[3].orbs = 1; })).toEqual(['p2', 'p3', 'p1', 'p4']);
  });

  it('breaks ties by who reached the count first', () => {
    const order = ranked((p) => {
      p[0].orbs = 5; p[0].lastOrbAtMs = 90_000;
      p[1].orbs = 5; p[1].lastOrbAtMs = 40_000;
      p[2].orbs = 5; p[2].lastOrbAtMs = 70_000;
      p[3].orbs = 2; p[3].lastOrbAtMs = 10_000;
    });
    expect(order).toEqual(['p2', 'p3', 'p1', 'p4']);
  });

  it('falls back to join order when everything is equal, with every rank different', () => {
    const s = quietGame(1, CONFIG, 3);
    const table = rankPlayers(s);
    expect(table.map((r) => r.playerId)).toEqual(['p1', 'p2', 'p3']);
    expect(table.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('keeps disconnected players in the table', () => {
    const s = quietGame(1, CONFIG, 3);
    s.players[1].orbs = 8;
    s.players[1].present = false;
    s.players[1].connected = false;
    expect(rankPlayers(s)[0].playerId).toBe('p2');
  });
});

describe('scaling with the number of players', () => {
  /** Total of the orb spawn gaps over many seeds, for a given room size. */
  function orbGapTotal(players: number): number {
    let total = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = quietGame(seed, CONFIG, players);
      s.spawn.orbMs = 0;
      run(s, 1);
      total += s.spawn.orbMs;
    }
    return total;
  }

  it('spawns orbs in proportion to the number of players', () => {
    expect(orbGapTotal(3) / orbGapTotal(9)).toBeGreaterThan(2.6);
    expect(orbGapTotal(3) / orbGapTotal(9)).toBeLessThan(3.4);
  });

  it('never goes below the 3-player supply for smaller rooms', () => {
    expect(orbGapTotal(1) / orbGapTotal(3)).toBeCloseTo(1, 0);
    expect(orbGapTotal(2) / orbGapTotal(3)).toBeCloseTo(1, 0);
  });

  it('allows more orbs on the field in bigger rooms', () => {
    const fill = (players: number): number => {
      const s = quietGame(2, CONFIG, players);
      for (let i = 0; i < 80; i++) s.orbs.push({ x: arena.x + 20, y: arena.y + 20 + i, radius: 7, ttlMs: 99_999 });
      s.spawn.orbMs = 0;
      run(s, 1);
      return s.orbs.length;
    };
    expect(fill(3)).toBeLessThanOrEqual(80); // nothing new is added over the cap
    const s5 = quietGame(2, CONFIG, 5);
    s5.spawn.orbMs = 0;
    for (let i = 0; i < CONFIG.orbs.maxPerPlayer * 5 - 1; i++) {
      s5.orbs.push({ x: arena.x + 20, y: arena.y + 20 + i, radius: 7, ttlMs: 99_999 });
    }
    run(s5, 1);
    expect(s5.orbs.length).toBe(CONFIG.orbs.maxPerPlayer * 5); // room for exactly one more
    s5.spawn.orbMs = 0;
    run(s5, 1);
    expect(s5.orbs.length).toBe(CONFIG.orbs.maxPerPlayer * 5); // now at the cap
  });

  it('allows more obstacles in bigger rooms', () => {
    // Late in the match the cap is large enough for the extra players to make a difference.
    const timeMs = 200_000;
    const baseCap = getDifficulty(timeMs, CONFIG).maxDrifters;
    const count = (players: number): number => {
      const s = quietGame(5, CONFIG, players);
      s.timeMs = timeMs;
      for (let i = 0; i < baseCap; i++) {
        addDrifter(s, { x: arena.x + 20, y: arena.y + 20, vx: 0, vy: 0 });
      }
      s.spawn.drifterMs = 0;
      run(s, 1);
      return s.drifters.length;
    };
    expect(count(3)).toBe(baseCap); // a 3-player room is already at its cap
    expect(count(10)).toBeGreaterThan(baseCap); // a 10-player room has room for more
  });
});

describe('disconnecting and reconnecting', () => {
  const awaySteps = Math.ceil(CONFIG.player.awayRemoveMs / STEP_MS) + 3;

  it('keeps the hero for a few seconds, then removes it but keeps the orbs', () => {
    const s = quietGame(1, CONFIG, 3);
    s.players[1].orbs = 6;
    setConnected(s, 'p2', false, CONFIG);
    run(s, 30);
    expect(s.players[1].present).toBe(true); // still standing there
    run(s, awaySteps);
    expect(s.players[1].present).toBe(false);
    expect(s.players[1].orbs).toBe(6);
  });

  it('lets a quick reconnect carry on as if nothing happened', () => {
    const s = quietGame(1, CONFIG, 3);
    setConnected(s, 'p2', false, CONFIG);
    run(s, 60);
    setConnected(s, 'p2', true, CONFIG);
    run(s, awaySteps);
    expect(s.players[1].present).toBe(true);
  });

  it('brings a removed hero back at a safe spot with the respawn lives', () => {
    const s = quietGame(1, CONFIG, 3);
    s.players[1].orbs = 6;
    setConnected(s, 'p2', false, CONFIG);
    run(s, awaySteps);
    setConnected(s, 'p2', true, CONFIG);
    const p = s.players[1];
    expect(p.present).toBe(true);
    expect(p.alive).toBe(true);
    expect(p.lives).toBe(CONFIG.player.respawn.lives);
    expect(p.invulnerableMs).toBeGreaterThan(0);
    expect(p.orbs).toBe(6);
  });

  it('takes a removed hero out of collisions, bumps and orb collection', () => {
    const s = twoPlayers(10);
    setConnected(s, 'p2', false, CONFIG);
    run(s, awaySteps);
    s.players[1].x = s.players[0].x;
    s.players[1].y = s.players[0].y;
    s.orbs = [{ x: s.players[1].x, y: s.players[1].y, radius: 7, ttlMs: 9000 }];
    addDrifter(s, { x: 500, y: 500 });
    s.players[1].x = 500;
    s.players[1].y = 500;
    const results = run(s, 5);
    expect(results.flatMap((r) => r.bumps)).toHaveLength(0);
    expect(s.players[1].lives).toBe(3);
  });
});

describe('full matches with bots', () => {
  interface Outcome {
    state: GameState;
    pickups: number;
    ranking: ReturnType<typeof rankPlayers>;
  }

  function playMatch(seed: number, players: number): Outcome {
    const state = createMatch(seed, roster(players));
    startRun(state);
    const ids = state.players.map((p) => p.id);
    let pickups = 0;
    let safety = 0;

    while (state.status === 'playing' && safety++ < 60 * 300) {
      const inputs: InputMap = {};
      for (const id of ids) {
        inputs[id] = botInput(state, id);
        const ability = botAbility(state, id);
        if (ability) activateAbility(state, id, ability);
      }
      const result = stepGame(state, inputs, STEP_MS);
      pickups += result.pickups.length;

      for (const p of state.players) {
        // basic sanity at every step
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('player position is not a number');
        if (p.lives < 0 || p.lives > CONFIG.player.lives) throw new Error('lives out of range');
        if (p.energy < 0 || p.energy > CONFIG.energy.max) throw new Error('energy out of range');
      }
    }
    return { state, pickups, ranking: rankPlayers(state) };
  }

  it('runs a 3-player match to the 4-minute end', () => {
    const { state, ranking, pickups } = playMatch(1, 3);
    expect(state.status).toBe('finished');
    expect(state.timeMs).toBeGreaterThanOrEqual(CONFIG.match.durationMs);
    expect(state.timeMs).toBeLessThan(CONFIG.match.durationMs + 100);
    expect(ranking.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(state.players.reduce((sum, p) => sum + p.orbs, 0)).toBe(pickups); // every orb counted once
    expect(pickups).toBeGreaterThan(30);
  });

  it('runs a 10-player match, ranks everyone and spreads the orbs around', () => {
    const { state, ranking, pickups } = playMatch(2, 10);
    expect(state.status).toBe('finished');
    expect(new Set(ranking.map((r) => r.playerId)).size).toBe(10);
    expect(ranking.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(state.players.reduce((sum, p) => sum + p.orbs, 0)).toBe(pickups);
    expect(state.players.filter((p) => p.orbs > 0).length).toBeGreaterThanOrEqual(8);
    expect(ranking[0].orbs).toBeGreaterThanOrEqual(ranking[9].orbs);
  });

  it('plays the same match twice from the same seed', () => {
    const a = playMatch(7, 4).state;
    const b = playMatch(7, 4).state;
    expect(JSON.stringify(a.players)).toBe(JSON.stringify(b.players));
  });

  it('keeps every player inside the playable area all match long', () => {
    const state = createMatch(3, roster(5));
    startRun(state);
    for (let i = 0; i < 60 * 240; i++) {
      const inputs: InputMap = {};
      for (const p of state.players) inputs[p.id] = botInput(state, p.id);
      stepGame(state, inputs, STEP_MS);
      for (const p of state.players) {
        if (!p.alive) continue;
        const b = CONFIG.arena;
        expect(p.x).toBeGreaterThanOrEqual(b.x + p.radius - 1e-6);
        expect(p.x).toBeLessThanOrEqual(b.x + b.width - p.radius + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(b.y + p.radius - 1e-6);
        expect(p.y).toBeLessThanOrEqual(b.y + b.height - p.radius + 1e-6);
      }
    }
  });
});
