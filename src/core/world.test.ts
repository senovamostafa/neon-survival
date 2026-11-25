import { describe, expect, it } from 'vitest';
import { activateAbility } from './abilities';
import { circleHitsRect } from './collision';
import { CONFIG, type Config } from './config';
import { getDifficulty } from './difficulty';
import { createMatch, startRun } from './game';
import { cellCenter, cellOf, cellSize, mazeForSector, openNeighbors, pathToNearest } from './maze';
import { Rng } from './rng';
import { freeRun } from './spawn';
import { addDrifter, me, quietGame, roster, soloMatch, step } from './testUtils';
import type { InputState, Maze } from './types';

const STEP = CONFIG.timestep.stepMs;
const IDLE: InputState = { dx: 0, dy: 0 };
const { arena, abilities } = CONFIG;

function run(state: ReturnType<typeof quietGame>, steps: number, input: InputState = IDLE): void {
  for (let i = 0; i < steps; i++) step(state, input);
}

function openings(maze: Maze): number {
  let n = 0;
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      if (c < maze.cols - 1 && !maze.cells[r][c].e) n++;
      if (r < maze.rows - 1 && !maze.cells[r][c].s) n++;
    }
  }
  return n;
}

function reachableCells(maze: Maze): number {
  const seen = new Set<number>([0]);
  const queue = [{ col: 0, row: 0 }];
  while (queue.length > 0) {
    const cell = queue.pop()!;
    for (const n of openNeighbors(maze, cell.col, cell.row)) {
      const key = n.row * maze.cols + n.col;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(n);
    }
  }
  return seen.size;
}

/** A real maze match (walls and all), started, with only the spawn timers we choose. */
function mazeGame(seed: number) {
  const s = soloMatch(seed);
  startRun(s);
  s.spawn = { drifterMs: 1e12, orbMs: 1e12 };
  return s;
}

describe('the maze', () => {
  it('is connected, has no dead ends and has loops, for many seeds and every sector', () => {
    for (let sector = 0; sector < 4; sector++) {
      for (let seed = 0; seed < 60; seed++) {
        const maze = mazeForSector(new Rng(seed), CONFIG, sector);
        expect(reachableCells(maze)).toBe(maze.cols * maze.rows);
        for (let r = 0; r < maze.rows; r++) {
          for (let c = 0; c < maze.cols; c++) {
            expect(openNeighbors(maze, c, r).length).toBeGreaterThanOrEqual(2); // never a dead end
          }
        }
        expect(openings(maze)).toBeGreaterThan(maze.cols * maze.rows - 1); // more than a plain maze: it has loops
      }
    }
  });

  it('keeps corridors wide enough for several heroes side by side', () => {
    const size = cellSize(CONFIG);
    expect(size.width - CONFIG.maze.thickness).toBeGreaterThanOrEqual(CONFIG.player.radius * 4);
    expect(size.height - CONFIG.maze.thickness).toBeGreaterThanOrEqual(CONFIG.player.radius * 4);
  });

  it('gets tighter in later sectors (fewer openings on average)', () => {
    const average = (sector: number): number => {
      let total = 0;
      for (let seed = 0; seed < 40; seed++) total += openings(mazeForSector(new Rng(seed), CONFIG, sector));
      return total / 40;
    };
    expect(average(0)).toBeGreaterThan(average(1));
    expect(average(1)).toBeGreaterThan(average(2));
    expect(average(2)).toBeGreaterThan(average(3));
  });

  it('is the same for the same seed', () => {
    expect(soloMatch(99).maze).toEqual(soloMatch(99).maze);
    expect(soloMatch(99).barriers).toEqual(soloMatch(99).barriers);
    expect(soloMatch(99).maze).not.toEqual(soloMatch(100).maze);
  });

  it('draws walls inside the arena that match the maze exactly', () => {
    for (let seed = 0; seed < 20; seed++) {
      const s = soloMatch(seed);
      const { maze } = s;
      for (const b of s.barriers) {
        expect(b.x).toBeGreaterThanOrEqual(arena.x - 1e-9);
        expect(b.y).toBeGreaterThanOrEqual(arena.y - 1e-9);
        expect(b.x + b.width).toBeLessThanOrEqual(arena.x + arena.width + 1e-9);
        expect(b.y + b.height).toBeLessThanOrEqual(arena.y + arena.height + 1e-9);
        expect(b.warningMs).toBe(0);
      }
      const solid = (x: number, y: number): boolean => s.barriers.some((b) => circleHitsRect({ x, y, radius: 1 }, b));
      const centre = (c: number, r: number) => cellCenter(CONFIG, c, r);
      for (let r = 0; r < maze.rows; r++) {
        for (let c = 0; c < maze.cols; c++) {
          const here = centre(c, r);
          // the middle of every corridor cell is clear for a hero
          expect(s.barriers.some((b) => circleHitsRect({ x: here.x, y: here.y, radius: CONFIG.player.radius }, b))).toBe(false);
          if (c < maze.cols - 1) {
            const next = centre(c + 1, r);
            const mid = { x: (here.x + next.x) / 2, y: (here.y + next.y) / 2 };
            expect(solid(mid.x, mid.y)).toBe(maze.cells[r][c].e); // a wall exactly where the maze says
          }
          if (r < maze.rows - 1) {
            const next = centre(c, r + 1);
            const mid = { x: (here.x + next.x) / 2, y: (here.y + next.y) / 2 };
            expect(solid(mid.x, mid.y)).toBe(maze.cells[r][c].s);
          }
        }
      }
    }
  });

  it('lets a hero walk through every opening and not through any wall', () => {
    const s = soloMatch(5);
    const { maze } = s;
    const to = (c: number, r: number) => cellCenter(CONFIG, c, r);
    for (let r = 0; r < maze.rows; r++) {
      for (let c = 0; c < maze.cols - 1; c++) {
        if (maze.cells[r][c].e) continue;
        const a = to(c, r);
        const b = to(c + 1, r);
        for (let k = 0; k <= 10; k++) {
          const x = a.x + ((b.x - a.x) * k) / 10;
          expect(s.barriers.some((w) => circleHitsRect({ x, y: a.y, radius: CONFIG.player.radius }, w))).toBe(false);
        }
      }
    }
  });

  it('finds the shortest route between cells', () => {
    const maze = mazeForSector(new Rng(3), CONFIG, 1);
    for (let r = 0; r < maze.rows; r++) {
      for (let c = 0; c < maze.cols; c++) {
        const found = pathToNearest(maze, { col: 0, row: 0 }, [{ col: c, row: r }]);
        expect(found).not.toBeNull();
        expect(found!.length).toBeGreaterThanOrEqual(c + r); // never shorter than walking straight
        if (found!.length > 0) {
          const step = found!.next;
          expect(Math.abs(step.col) + Math.abs(step.row)).toBe(1); // the first step is a neighbour of (0, 0)
        }
      }
    }
  });

  it('puts every player at the middle of a different corridor cell, for 1 to 10 players', () => {
    for (let n = 1; n <= 10; n++) {
      for (let seed = 0; seed < 20; seed++) {
        const s = createMatch(seed, roster(n));
        const cells = new Set(s.players.map((p) => `${cellOf(CONFIG, p.x, p.y).col},${cellOf(CONFIG, p.x, p.y).row}`));
        expect(cells.size).toBe(n);
        for (const p of s.players) {
          const c = cellOf(CONFIG, p.x, p.y);
          const mid = cellCenter(CONFIG, c.col, c.row);
          expect([p.x, p.y]).toEqual([mid.x, mid.y]);
        }
      }
    }
  });
});

describe('enemies (drifters)', () => {
  it('appear as a harmless marker in a corridor, aimed down it, never near a player', () => {
    let spawned = 0;
    for (let seed = 0; seed < 150; seed++) {
      const s = mazeGame(seed);
      s.spawn.drifterMs = 0;
      step(s, IDLE);
      if (s.drifters.length === 0) continue; // nothing fair fit this time, it just tries again later
      spawned++;
      const d = s.drifters[0];
      const c = cellOf(CONFIG, d.x, d.y);
      const mid = cellCenter(CONFIG, c.col, c.row);
      expect([d.x, d.y]).toEqual([mid.x, mid.y]); // the centre of a cell
      expect(d.warningMs).toBeGreaterThan(0);
      expect(d.vx === 0 || d.vy === 0).toBe(true); // straight down a corridor
      expect(Math.hypot(d.x - me(s).x, d.y - me(s).y)).toBeGreaterThanOrEqual(CONFIG.drifters.minEntryDistance);
      const dir = { dx: Math.sign(d.vx), dy: Math.sign(d.vy) };
      expect(freeRun(s, CONFIG, d.x, d.y, d.radius, dir.dx, dir.dy)).toBeGreaterThanOrEqual(CONFIG.drifters.minTravel);
    }
    expect(spawned).toBeGreaterThan(140);
  });

  it('have speeds inside the current stage range, sliced by enemy type', () => {
    const easy = getDifficulty(0, CONFIG);
    for (let seed = 0; seed < 100; seed++) {
      const s = mazeGame(seed);
      s.spawn.drifterMs = 0;
      step(s, IDLE);
      for (const d of s.drifters) {
        const [lo, hi] = CONFIG.drifters.types[d.kind].speedFactor;
        const min = easy.speedMin + (easy.speedMax - easy.speedMin) * lo;
        const max = easy.speedMin + (easy.speedMax - easy.speedMin) * hi;
        const speed = Math.hypot(d.vx, d.vy);
        expect(speed).toBeGreaterThanOrEqual(min - 1e-6);
        expect(speed).toBeLessThanOrEqual(max + 1e-6);
      }
    }
  });

  it('do not move and cannot hurt during the warning, then start moving', () => {
    const s = quietGame();
    const d = addDrifter(s, { vx: 100, vy: 0, warningMs: 500 }); // sitting on the player
    const startX = d.x;
    run(s, 20); // ~333 ms
    expect(d.x).toBe(startX);
    expect(me(s).lives).toBe(3);
    run(s, 20); // warning over
    expect(d.x).toBeGreaterThan(startX);
  });

  it('hurt on contact once active', () => {
    const s = quietGame();
    addDrifter(s, { x: me(s).x + 100, vx: -300 }); // flying at the player
    run(s, 60);
    expect(me(s).lives).toBe(2);
  });

  it('are removed after leaving the arena', () => {
    const s = quietGame();
    addDrifter(s, { x: arena.x + 40, y: arena.y + 40, vx: -400, vy: 0 });
    run(s, 60);
    expect(s.drifters).toHaveLength(0);
  });

  it('vanish when they fly into a wall, and say where', () => {
    const s = quietGame();
    const wall = { x: me(s).x + 200, y: me(s).y - 100, width: 16, height: 200, warningMs: 0 };
    s.barriers = [wall];
    addDrifter(s, { x: me(s).x + 100, y: me(s).y + 50, vx: 150, vy: 0 });
    const hits: { x: number; y: number }[] = [];
    for (let i = 0; i < 90; i++) hits.push(...step(s, IDLE).wallHits);
    expect(s.drifters).toHaveLength(0);
    expect(hits).toHaveLength(1);
    expect(hits[0].x).toBeLessThan(wall.x + 5);
    expect(me(s).lives).toBe(3); // it never reached the other side
  });

  it('are not stopped by a wall that is still only an outline, nor while still a marker', () => {
    const s = quietGame();
    const wall = { x: me(s).x + 100, y: me(s).y - 100, width: 16, height: 200, warningMs: 99_999 };
    s.barriers = [wall];
    const flying = addDrifter(s, { x: me(s).x + 50, y: me(s).y + 50, vx: 150, vy: 0 });
    const marker = addDrifter(s, { x: wall.x + 8, y: me(s).y - 50, vx: 150, vy: 0, warningMs: 99_999 });
    run(s, 40);
    expect(s.drifters).toContain(flying);
    expect(s.drifters).toContain(marker);
    s.barriers[0].warningMs = 0; // the wall turns solid: the one still marking is safe until it moves
    run(s, 2);
    expect(s.drifters).toContain(marker);
  });

  it('never end up inside a solid wall in a real maze, over long matches', () => {
    for (let seed = 0; seed < 12; seed++) {
      const s = soloMatch(seed);
      startRun(s);
      me(s).invulnerableMs = Number.MAX_SAFE_INTEGER;
      s.timeMs = 120_000; // Hard stage, so plenty of enemies
      s.spawn.drifterMs = 0;
      for (let i = 0; i < 60 * 40; i++) {
        step(s, IDLE);
        for (const d of s.drifters) {
          if (d.warningMs > 0) continue;
          expect(s.barriers.some((w) => w.warningMs <= 0 && circleHitsRect(d, w))).toBe(false);
        }
      }
    }
  });

  it('never exceed the configured maximum', () => {
    const s = quietGame(3);
    me(s).invulnerableMs = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 6000; i++) {
      s.spawn.drifterMs = 0; // force a spawn attempt every step
      step(s, IDLE);
      expect(s.drifters.length).toBeLessThanOrEqual(getDifficulty(s.timeMs, CONFIG).maxDrifters);
    }
  });
});


describe('energy orbs', () => {
  it('spawn on open floor, never on the player', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = soloMatch(seed);
      startRun(s);
      s.spawn.orbMs = 0;
      step(s, IDLE);
      expect(s.orbs).toHaveLength(1);
      const o = s.orbs[0];
      expect(Math.hypot(o.x - me(s).x, o.y - me(s).y)).toBeGreaterThanOrEqual(CONFIG.orbs.minDistanceFromPlayer - 1);
      expect(s.barriers.some((b) => circleHitsRect(o, b))).toBe(false);
    }
  });

  it('give energy when touched, count as collected, and are removed', () => {
    const s = quietGame();
    s.orbs = [{ x: me(s).x, y: me(s).y, radius: 7, ttlMs: 10000 }];
    const result = step(s, IDLE);
    expect(me(s).energy).toBe(CONFIG.energy.perOrb);
    expect(me(s).orbs).toBe(1);
    expect(s.orbs).toHaveLength(0);
    expect(result.pickups).toHaveLength(1);
  });

  it('never push energy above the maximum', () => {
    const s = quietGame();
    me(s).energy = CONFIG.energy.max - 3;
    s.orbs = [{ x: me(s).x, y: me(s).y, radius: 7, ttlMs: 10000 }];
    step(s, IDLE);
    expect(me(s).energy).toBe(CONFIG.energy.max);
  });

  it('expire after their lifetime', () => {
    const s = quietGame();
    s.orbs = [{ x: arena.x + 30, y: arena.y + 30, radius: 7, ttlMs: 500 }];
    run(s, 40);
    expect(s.orbs).toHaveLength(0);
    expect(me(s).energy).toBe(0);
  });

  it('do not add to the survival score: time is only the clock', () => {
    const s = quietGame();
    s.orbs = [{ x: me(s).x, y: me(s).y, radius: 7, ttlMs: 10000 }];
    run(s, 60);
    expect(s.timeMs).toBeCloseTo(1000, 3);
  });
});

describe('abilities: general rules', () => {
  it('cannot be used without enough energy, and cost nothing when refused', () => {
    const s = quietGame();
    me(s).energy = abilities.shield.cost - 1;
    expect(activateAbility(s, 'p1', 'shield')).toEqual({ ok: false, reason: 'no-energy' });
    expect(me(s).energy).toBe(abilities.shield.cost - 1);
    expect(me(s).abilities.shield.activeMs).toBe(0);
  });

  it('spend exactly their energy cost', () => {
    for (const id of ['shield', 'slow', 'teleport', 'magnet'] as const) {
      const s = quietGame();
      me(s).energy = 100;
      expect(activateAbility(s, 'p1', id).ok).toBe(true);
      expect(me(s).energy).toBe(100 - abilities[id].cost);
    }
  });

  it('cannot be used before the game starts', () => {
    const s = soloMatch(1);
    me(s).energy = 100;
    expect(activateAbility(s, 'p1', 'shield')).toEqual({ ok: false, reason: 'not-playing' });
  });

  it('cannot be reactivated while running or on cooldown', () => {
    const s = quietGame();
    me(s).energy = 100;
    activateAbility(s, 'p1', 'magnet');
    expect(activateAbility(s, 'p1', 'magnet')).toEqual({ ok: false, reason: 'active' });

    activateAbility(s, 'p1', 'teleport');
    expect(activateAbility(s, 'p1', 'teleport')).toEqual({ ok: false, reason: 'cooldown' });
    run(s, Math.ceil(abilities.teleport.cooldownMs / STEP) + 2);
    expect(activateAbility(s, 'p1', 'teleport').ok).toBe(true);
  });
});

describe('shield', () => {
  it('absorbs one hit without losing a life, then pops', () => {
    const s = quietGame();
    me(s).energy = 100;
    activateAbility(s, 'p1', 'shield');
    addDrifter(s);
    const result = step(s, IDLE);
    expect(result.shieldBlocks).toEqual([{ playerId: 'p1' }]);
    expect(result.hits).toHaveLength(0);
    expect(me(s).lives).toBe(3);
    expect(me(s).abilities.shield.activeMs).toBe(0);
    expect(me(s).invulnerableMs).toBeGreaterThan(0);
  });

  it('leaves you hit-able after the short grace period', () => {
    const s = quietGame();
    me(s).energy = 100;
    activateAbility(s, 'p1', 'shield');
    addDrifter(s); // keeps overlapping
    run(s, Math.ceil(abilities.shield.blockInvulnerableMs / STEP) + 3);
    expect(me(s).lives).toBe(2);
  });

  it('expires after its duration', () => {
    const s = quietGame();
    me(s).energy = 100;
    activateAbility(s, 'p1', 'shield');
    run(s, Math.ceil(abilities.shield.durationMs / STEP) + 2);
    expect(me(s).abilities.shield.activeMs).toBe(0);
  });
});

describe('slow motion', () => {
  /** Runs the same moment twice (with and without slow) and returns how far a drifter moved. */
  function driftedFar(withSlow: boolean, offsetX: number): { moved: number; playerMoved: number } {
    const s = quietGame();
    if (withSlow) {
      me(s).energy = 100;
      activateAbility(s, 'p1', 'slow');
    }
    const d = addDrifter(s, { x: me(s).x + offsetX, y: me(s).y - 60, vx: 0, vy: 100 });
    const startY = d.y;
    const px = me(s).x;
    run(s, 30, { dx: 1, dy: 0 });
    return { moved: d.y - startY, playerMoved: me(s).x - px };
  }

  it('slows obstacles near the user to the configured fraction, but not the player', () => {
    const slowed = driftedFar(true, 120);
    const normal = driftedFar(false, 120);
    expect(slowed.moved).toBeCloseTo(normal.moved * abilities.slow.factor, 3);
    expect(slowed.playerMoved).toBeCloseTo(normal.playerMoved, 3);
  });

  it('is a zone: obstacles far from the user are not slowed', () => {
    const farAway = driftedFar(true, abilities.slow.radius + 150);
    const normal = driftedFar(false, abilities.slow.radius + 150);
    expect(farAway.moved).toBeCloseTo(normal.moved, 3);
  });

  it('also slows obstacles near another player who is not the user', () => {
    const s = quietGame(1, CONFIG, 2);
    s.players[0].x = arena.x + 100;
    s.players[0].y = arena.y + 100;
    s.players[1].x = arena.x + 700;
    s.players[1].y = arena.y + 300;
    s.players[0].energy = 100;
    activateAbility(s, 'p1', 'slow');
    const nearUser = addDrifter(s, { x: arena.x + 200, y: arena.y + 100, vx: 0, vy: 100 });
    const nearOther = addDrifter(s, { x: arena.x + 700, y: arena.y + 100, vx: 0, vy: 100 });
    run(s, 30);
    expect(nearUser.y - (arena.y + 100)).toBeCloseTo(50 * abilities.slow.factor, 3);
    expect(nearOther.y - (arena.y + 100)).toBeCloseTo(50, 3);
  });
});

describe('magnet', () => {
  it('pulls nearby orbs toward the player', () => {
    const s = quietGame();
    me(s).energy = 100;
    activateAbility(s, 'p1', 'magnet');
    s.orbs = [{ x: me(s).x + 100, y: me(s).y, radius: 7, ttlMs: 10000 }];
    run(s, 10);
    expect(s.orbs[0].x).toBeLessThan(me(s).x + 100 - 10);
  });

  it('eventually delivers the orb', () => {
    const s = quietGame();
    me(s).energy = 0;
    me(s).abilities.magnet.activeMs = 6000; // already running
    s.orbs = [{ x: me(s).x + 120, y: me(s).y, radius: 7, ttlMs: 10000 }];
    run(s, 60);
    expect(me(s).orbs).toBe(1);
  });

  it('ignores orbs outside its radius', () => {
    const s = quietGame();
    me(s).energy = 100;
    activateAbility(s, 'p1', 'magnet');
    const far = abilities.magnet.radius + 50;
    s.orbs = [{ x: me(s).x + far, y: me(s).y, radius: 7, ttlMs: 10000 }];
    run(s, 20);
    expect(s.orbs[0].x).toBeCloseTo(me(s).x + far);
  });

  it('does nothing once it has run out', () => {
    const s = quietGame();
    me(s).energy = 100;
    activateAbility(s, 'p1', 'magnet');
    run(s, Math.ceil(abilities.magnet.durationMs / STEP) + 2);
    s.orbs = [{ x: me(s).x + 100, y: me(s).y, radius: 7, ttlMs: 10000 }];
    run(s, 10);
    expect(s.orbs[0].x).toBeCloseTo(me(s).x + 100);
  });
});

describe('teleport', () => {
  it('lands somewhere safe and far enough away, for many seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = soloMatch(seed);
      startRun(s);
      me(s).energy = 100;
      s.spawn = { drifterMs: 1e12, orbMs: 1e12 };
      addDrifter(s, { x: arena.x + 300, y: arena.y + 200, vx: 50 });
      const result = activateAbility(s, 'p1', 'teleport');
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const { to, from } = result;
      expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThanOrEqual(abilities.teleport.minDistance);
      expect([me(s).x, me(s).y]).toEqual([to.x, to.y]);
      const r = me(s).radius;
      expect(to.x).toBeGreaterThanOrEqual(arena.x + r);
      expect(to.x).toBeLessThanOrEqual(arena.x + arena.width - r);
      expect(to.y).toBeGreaterThanOrEqual(arena.y + r);
      expect(to.y).toBeLessThanOrEqual(arena.y + arena.height - r);
      expect(s.barriers.some((b) => circleHitsRect({ x: to.x, y: to.y, radius: r }, b))).toBe(false);
      expect(s.drifters.some((d) => Math.hypot(to.x - d.x, to.y - d.y) < d.radius + r)).toBe(false);
    }
  });

  it('fails without spending energy when no safe spot exists', () => {
    const impossible: Config = {
      ...CONFIG,
      abilities: { ...CONFIG.abilities, teleport: { ...CONFIG.abilities.teleport, minDistance: 5000 } },
    };
    const s = quietGame(1, impossible);
    me(s).energy = 100;
    const before = { x: me(s).x, y: me(s).y };
    expect(activateAbility(s, 'p1', 'teleport', impossible)).toEqual({ ok: false, reason: 'no-safe-spot' });
    expect(me(s).energy).toBe(100);
    expect([me(s).x, me(s).y]).toEqual([before.x, before.y]);
    expect(me(s).abilities.teleport.cooldownMs).toBe(0);
  });
});

describe('determinism', () => {
  it('replays identically for the same seed and inputs', () => {
    function play(seed: number): string {
      const s = soloMatch(seed);
      startRun(s);
      const inputs: InputState[] = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: -1 }, IDLE];
      for (let i = 0; i < 1800; i++) {
        step(s, inputs[Math.floor(i / 45) % inputs.length]);
        if (i === 300) { me(s).energy = 100; activateAbility(s, 'p1', 'teleport'); }
      }
      return JSON.stringify(s);
    }
    expect(play(12345)).toBe(play(12345));
    expect(play(12345)).not.toBe(play(54321));
  });
});
