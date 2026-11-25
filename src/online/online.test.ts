import { describe, expect, it } from 'vitest';
import { CONFIG } from '../core/config';
import { moveHero } from '../core/movement';
import type { Barrier } from '../core/types';
import type { PlayerSnap, ServerMessage, Snapshot } from '../net/protocol';
import { cleanCode, codeProblem, nameProblem, parseServerMessage, toWsUrl } from './connection';
import { HEARTBEAT_MS, InputSender } from './inputSender';
import { INTERP_DELAY_MS, JUMP_DISTANCE, SnapshotBuffer } from './interpolation';
import { Predictor, SNAP_DISTANCE } from './prediction';
import { OnlineSession } from './session';
import { buildViewState, eventsToStepResult } from './view';

function playerSnap(id: string, x: number, y: number, extra: Partial<PlayerSnap> = {}): PlayerSnap {
  return {
    id, x, y, lives: 3, alive: true, present: true, inv: 0, energy: 0, orbs: 0, deaths: 0,
    ab: [0, 0, 0, 0, 0, 0, 0, 0], ...extra,
  };
}

function snap(tick: number, players: PlayerSnap[], extra: Partial<Snapshot> = {}): Snapshot {
  return { t: 'snap', tick, timeMs: tick * 50, sector: 0, players, drifters: [], orbs: [], ...extra };
}

describe('SnapshotBuffer (smoothing other players)', () => {
  it('slides a hero between two snapshots', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1, [playerSnap('a', 100, 100)]), 1000);
    buffer.push(snap(2, [playerSnap('a', 110, 100)]), 1050);
    expect(buffer.sample(1025)!.players[0].x).toBeCloseTo(105);
    expect(buffer.sample(1000)!.players[0].x).toBeCloseTo(100);
  });

  it('does not slide across a teleport or respawn', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1, [playerSnap('a', 100, 100)]), 1000);
    buffer.push(snap(2, [playerSnap('a', 100 + JUMP_DISTANCE + 50, 100)]), 1050);
    const early = buffer.sample(1010)!.players[0].x;
    const late = buffer.sample(1040)!.players[0].x;
    expect(early).toBe(100);
    expect(late).toBe(210);
  });

  it('holds still when the drawn moment is newer than the newest snapshot', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1, [playerSnap('a', 100, 100)]), 1000);
    buffer.push(snap(2, [playerSnap('a', 110, 100)]), 1050);
    expect(buffer.sample(5000)!.players[0].x).toBe(110);
  });

  it('shows the oldest picture before any snapshot is old enough', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1, [playerSnap('a', 100, 100)]), 1000);
    expect(buffer.sample(900)!.players[0].x).toBe(100);
  });

  it('ignores snapshots that arrive late or twice', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.push(snap(5, []), 1000)).toBe(true);
    expect(buffer.push(snap(5, []), 1001)).toBe(false);
    expect(buffer.push(snap(4, []), 1002)).toBe(false);
    expect(buffer.size).toBe(1);
  });

  it('keeps obstacles moving along their path, but warning markers stay put', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(
      snap(1, [], {
        drifters: [
          { x: 100, y: 100, vx: 100, vy: 0, kind: 'crab', w: 0 },
          { x: 300, y: 300, vx: 100, vy: 0, kind: 'bug', w: 500 },
        ],
      }),
      1000,
    );
    const drifters = buffer.sample(1050)!.drifters;
    expect(drifters[0].x).toBeCloseTo(105);
    expect(drifters[1].x).toBe(300);
  });

  it('draws the world a short moment in the past', () => {
    expect(INTERP_DELAY_MS).toBeGreaterThan(50 * 2); // more than two snapshot gaps, so there is always a "next" picture
  });
});

describe('moveHero (the movement code shared with the server)', () => {
  const noWalls: Barrier[] = [];
  const hero = () => ({ x: 400, y: 300, radius: CONFIG.player.radius, bumpVx: 0, bumpVy: 0, bumpMs: 0 });

  it('moves at the configured speed and normalises diagonals', () => {
    const straight = hero();
    moveHero(straight, { dx: 1, dy: 0 }, 1000, noWalls);
    expect(straight.x - 400).toBeCloseTo(CONFIG.player.speed);

    const diagonal = hero();
    moveHero(diagonal, { dx: 1, dy: 1 }, 1000, noWalls);
    expect(Math.hypot(diagonal.x - 400, diagonal.y - 300)).toBeCloseTo(CONFIG.player.speed);
  });

  it('is stopped by a solid wall but not by an outline that is still warning', () => {
    const wall = (warningMs: number): Barrier => ({ x: 420, y: 250, width: 16, height: 100, warningMs });
    const solid = hero();
    for (let i = 0; i < 30; i++) moveHero(solid, { dx: 1, dy: 0 }, CONFIG.timestep.stepMs, [wall(0)]);
    expect(solid.x).toBeLessThanOrEqual(420 - CONFIG.player.radius + 0.01);

    const outline = hero();
    for (let i = 0; i < 30; i++) moveHero(outline, { dx: 1, dy: 0 }, CONFIG.timestep.stepMs, [wall(500)]);
    expect(outline.x).toBeGreaterThan(440);
  });
});

describe('Predictor (your own hero)', () => {
  const step = CONFIG.timestep.stepMs;

  /** Runs `ms` of constant input starting at time `from`, returning the time reached. */
  function run(p: Predictor, ms: number, from: number, dx = 1): number {
    let t = from;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t += step;
      p.step({ dx, dy: 0 }, step, [], t);
    }
    return t;
  }

  it('moves immediately, without waiting for the server', () => {
    const p = new Predictor();
    p.reset(400, 300);
    run(p, 100, 0);
    expect(p.x).toBeGreaterThan(410);
  });

  it('leaves a correct prediction alone', () => {
    const p = new Predictor();
    p.reset(400, 300);
    const t = run(p, 500, 0);
    // The server's answer is what we predicted a round trip ago.
    const rtt = 100;
    const wasAt = 400 + CONFIG.player.speed * ((t - rtt) / 1000);
    expect(p.reconcile({ x: wasAt, y: 300 }, t, rtt)).toBe('ok');
  });

  it('nudges (does not jump) when the server disagrees a little', () => {
    const p = new Predictor();
    p.reset(400, 300);
    const t = run(p, 500, 0);
    const before = p.x;
    const wasAt = 400 + CONFIG.player.speed * ((t - 100) / 1000);
    expect(p.reconcile({ x: wasAt - 10, y: 300 }, t, 100)).toBe('nudged');
    expect(p.x).toBeLessThan(before);
    expect(before - p.x).toBeLessThan(10);
  });

  it('does not count the same correction twice', () => {
    const p = new Predictor();
    p.reset(400, 300);
    const t = run(p, 500, 0);
    const wasAt = 400 + CONFIG.player.speed * ((t - 100) / 1000);
    p.reconcile({ x: wasAt - 10, y: 300 }, t, 100);
    // The server still reports the same (now already half-fixed) disagreement: error shrinks each time.
    const errors: number[] = [];
    for (let i = 0; i < 12; i++) {
      const then = p.x;
      p.reconcile({ x: wasAt - 10, y: 300 }, t, 100);
      errors.push(Math.abs(then - p.x));
    }
    expect(errors[errors.length - 1]).toBeLessThan(errors[0]);
  });

  it('jumps to the server after a big difference (bump, respawn)', () => {
    const p = new Predictor();
    p.reset(400, 300);
    const t = run(p, 500, 0);
    expect(p.reconcile({ x: 400, y: 300 + SNAP_DISTANCE + 20 }, t, 100)).toBe('snapped');
    expect(p.y).toBe(300 + SNAP_DISTANCE + 20);
  });

  it('after our own teleport, ignores snapshots that still show the old place', () => {
    const p = new Predictor();
    p.reset(400, 300);
    let t = run(p, 300, 0);
    p.teleport(700, 100, t, 100);
    t = run(p, 50, t);
    expect(p.reconcile({ x: 400, y: 300 }, t, 100)).toBe('ok'); // a snapshot sent before the teleport
    expect(p.x).toBeGreaterThan(690);
  });

  it('stops at walls like the server does', () => {
    const p = new Predictor();
    p.reset(400, 300);
    const wall: Barrier = { x: 450, y: 200, width: 16, height: 200, warningMs: 0 };
    for (let i = 0; i < 120; i++) p.step({ dx: 1, dy: 0 }, step, [wall], i * step);
    expect(p.x).toBeLessThanOrEqual(450 - CONFIG.player.radius + 0.01);
  });
});

describe('InputSender', () => {
  it('sends changes at once, repeats a held key, and stays quiet while idle', () => {
    const sender = new InputSender();
    expect(sender.next(0, 0, 0)).toBeNull(); // nothing pressed, nothing to say
    expect(sender.next(1, 0, 10)).toEqual({ dx: 1, dy: 0 });
    expect(sender.next(1, 0, 20)).toBeNull();
    expect(sender.next(1, 0, 10 + HEARTBEAT_MS)).toEqual({ dx: 1, dy: 0 }); // keeps the server from timing us out
    expect(sender.next(0, 0, 300)).toEqual({ dx: 0, dy: 0 }); // release must be told
    expect(sender.next(0, 0, 900)).toBeNull();
  });
});

describe('connection helpers', () => {
  it('builds the websocket address', () => {
    expect(toWsUrl('http://localhost:8787', 'ABCD')).toBe('ws://localhost:8787/ws/ABCD');
    expect(toWsUrl('https://game.example.com/', 'WXYZ')).toBe('wss://game.example.com/ws/WXYZ');
  });

  it('checks names and codes the way the server does', () => {
    expect(nameProblem('Bob_7')).toBeNull();
    expect(nameProblem('ab')).not.toBeNull();
    expect(nameProblem('has space')).not.toBeNull();
    expect(nameProblem('  Alice  ')).toBeNull(); // surrounding spaces are trimmed
    expect(cleanCode(' abcd ')).toBe('ABCD');
    expect(codeProblem('abcd')).toBeNull();
    expect(codeProblem('ab1')).not.toBeNull();
  });

  it('ignores anything that is not a server message', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('{"x":1}')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
    expect(parseServerMessage('{"t":"pong","ts":5}')).toEqual({ t: 'pong', ts: 5 });
  });
});

describe('OnlineSession (following the server)', () => {
  const members = [
    { id: 'p1', name: 'Ann', colorIndex: 0, connected: true },
    { id: 'p2', name: 'Bo', colorIndex: 1, connected: true },
    { id: 'p3', name: 'Cy', colorIndex: 2, connected: true },
  ];
  const roomMessage = (phase: 'lobby' | 'countdown' | 'playing' | 'results', extra: Partial<ServerMessage> = {}): ServerMessage =>
    ({ t: 'room', phase, players: members, waiting: [], hostId: 'p1', minPlayers: 3, maxPlayers: 10, ...extra }) as ServerMessage;

  function joined(playerId = 'p2'): OnlineSession {
    const s = new OnlineSession();
    s.apply({ t: 'welcome', playerId, code: 'ABCD', spectating: false }, 0);
    s.apply(roomMessage('lobby'), 0);
    return s;
  }

  it('starts on the title screen and follows the room phase', () => {
    const s = new OnlineSession();
    expect(s.screen).toBe('title');
    s.apply({ t: 'welcome', playerId: 'p2', code: 'ABCD', spectating: false }, 0);
    s.apply(roomMessage('lobby'), 0);
    expect(s.screen).toBe('lobby');
    s.apply(roomMessage('countdown', { countdownMs: 5000 }), 1000);
    expect(s.screen).toBe('lobby');
    expect(s.countdownLeftMs(3000)).toBe(3000);
    s.apply(roomMessage('playing'), 6000);
    expect(s.screen).toBe('playing');
    s.apply(roomMessage('results'), 9000);
    expect(s.screen).toBe('results');
  });

  it('knows who the host is', () => {
    expect(joined('p1').isHost).toBe(true);
    expect(joined('p2').isHost).toBe(false);
  });

  it('keeps match data until the lobby comes back, then forgets it', () => {
    const s = joined();
    s.apply({ t: 'start', players: members, durationMs: 240000, timeMs: 0 }, 0);
    s.apply(roomMessage('playing'), 0);
    s.apply(snap(1, [playerSnap('p1', 1, 1)]), 10);
    s.apply({ t: 'results', ranking: [] }, 20);
    expect(s.snapshots.size).toBe(1);
    expect(s.results).not.toBeNull();
    s.apply(roomMessage('lobby'), 30);
    expect(s.snapshots.size).toBe(0);
    expect(s.results).toBeNull();
  });

  it('queues effects and refusals exactly once', () => {
    const s = joined();
    s.apply(snap(1, [playerSnap('p1', 1, 1)], { ev: { hits: ['p1'] } }), 10);
    s.apply({ t: 'ability', id: 'shield', ok: false, reason: 'no-energy' }, 11);
    expect(s.takeEvents()).toEqual([{ hits: ['p1'] }]);
    expect(s.takeEvents()).toEqual([]);
    expect(s.takeRefusals()).toEqual(['shield']);
    expect(s.takeRefusals()).toEqual([]);
  });

  it('counts a frozen player down from when they went down', () => {
    const s = joined();
    s.apply({ t: 'start', players: members, durationMs: 240000, timeMs: 0 }, 0);
    s.apply(roomMessage('playing'), 0);
    s.apply(snap(10, [playerSnap('p1', 5, 5, { alive: false, lives: 0 })]), 100); // timeMs 500
    s.apply(snap(30, [playerSnap('p1', 5, 5, { alive: false, lives: 0 })]), 200); // timeMs 1500
    const view = buildViewState(s, s.snapshots.sample(10_000));
    expect(view.players[0].respawnMs).toBe(CONFIG.player.respawn.freezeMs - 1000);
    s.apply(snap(40, [playerSnap('p1', 5, 5)]), 300);
    expect(s.downSince.has('p1')).toBe(false);
  });

  it('uses the walls from the maze message, and the warnings from the newest snapshot', () => {
    const s = joined();
    s.apply({ t: 'start', players: members, durationMs: 240000, timeMs: 0 }, 0);
    s.apply(snap(1, []), 5); // belongs to the old maze
    s.apply(
      {
        t: 'maze',
        sector: 1,
        maze: { cols: 1, rows: 1, cells: [[{ n: true, e: true, s: true, w: true }]] },
        walls: [
          { x: 0, y: 0, width: 10, height: 10, warningMs: 2000 },
          { x: 20, y: 0, width: 10, height: 10, warningMs: 2000 },
        ],
      },
      10,
    );
    expect(s.currentWalls().map((w) => w.warningMs)).toEqual([2000, 2000]); // not trusting the old snapshot
    s.apply(snap(2, [], { warn: [[1, 700]] }), 60);
    expect(s.currentWalls().map((w) => w.warningMs)).toEqual([0, 700]);
  });

  it('adjusts the measured round trip from pongs', () => {
    const s = joined();
    s.roundTripMs = 100;
    s.apply({ t: 'pong', ts: 1000 }, 1200);
    expect(s.roundTripMs).toBeGreaterThan(100);
    expect(s.roundTripMs).toBeLessThan(200);
  });

  it('remembers the last error for the screens', () => {
    const s = new OnlineSession();
    s.apply({ t: 'error', code: 'name-taken', message: 'That name is already in this room.' }, 0);
    expect(s.lastError?.code).toBe('name-taken');
  });
});

describe('view state (what gets drawn)', () => {
  it('builds heroes with names, colours and ability timers from snapshots', () => {
    const s = new OnlineSession();
    s.apply({ t: 'welcome', playerId: 'p1', code: 'ABCD', spectating: false }, 0);
    s.apply({ t: 'start', players: [{ id: 'p1', name: 'Ann', colorIndex: 4, connected: true }], durationMs: 240000, timeMs: 0 }, 0);
    s.apply({ t: 'room', phase: 'playing', players: [], waiting: [], hostId: 'p1', minPlayers: 3, maxPlayers: 10 }, 0);
    s.apply(
      snap(1, [playerSnap('p1', 200, 150, { orbs: 7, energy: 40, ab: [3000, 0, 0, 5000, 0, 0, 0, 0] })], {
        orbs: [{ x: 10, y: 20, ttl: 5000 }],
        drifters: [{ x: 1, y: 2, vx: 0, vy: 0, kind: 'star', w: 0 }],
      }),
      10,
    );
    const view = buildViewState(s, s.snapshots.sample(10));
    expect(view.status).toBe('playing');
    expect(view.players[0]).toMatchObject({ name: 'Ann', colorIndex: 4, orbs: 7, energy: 40 });
    expect(view.players[0].abilities.shield).toEqual({ activeMs: 3000, cooldownMs: 0 });
    expect(view.players[0].abilities.slow).toEqual({ activeMs: 0, cooldownMs: 5000 });
    expect(view.orbs[0]).toMatchObject({ x: 10, y: 20, ttlMs: 5000, radius: CONFIG.orbs.radius });
    expect(view.drifters[0].radius).toBe(CONFIG.drifters.types.star.radius);
  });

  it('is an empty arena before any snapshot', () => {
    const view = buildViewState(new OnlineSession(), null);
    expect(view.players).toEqual([]);
    expect(view.status).toBe('ready');
  });

  it('turns snapshot effects into step results and drops unknown players', () => {
    const result = eventsToStepResult(
      { pickups: [{ p: 'a', x: 1, y: 2 }, { p: 'ghost', x: 3, y: 4 }], hits: ['a'], bumps: [['a', 'b']], wallHits: [{ x: 9, y: 9 }] },
      new Set(['a', 'b']),
    );
    expect(result.pickups).toEqual([{ playerId: 'a', x: 1, y: 2 }]);
    expect(result.hits).toEqual([{ playerId: 'a' }]);
    expect(result.bumps).toEqual([{ a: 'a', b: 'b' }]);
    expect(result.wallHits).toEqual([{ x: 9, y: 9 }]);
    expect(result.deaths).toEqual([]);
  });
});

describe('prediction against a server that is 100 ms away (simulation)', () => {
  const step = CONFIG.timestep.stepMs;
  const ONE_WAY = 50;
  const walls: Barrier[] = [{ x: 500, y: 150, width: 16, height: 250, warningMs: 0 }];

  /** Plays a scripted sequence of key presses against a pretend server and returns the worst gap seen. */
  function simulate(shoveAtMs: number | null): { worstGap: number; finalGap: number } {
    const client = new Predictor();
    const start = { x: 300, y: 300 };
    client.reset(start.x, start.y);

    const server = { x: start.x, y: start.y, radius: CONFIG.player.radius, bumpVx: 0, bumpVy: 0, bumpMs: 0 };
    // The "ideal" hero: what the server would do if there were no delay at all.
    const ideal = { x: start.x, y: start.y, radius: CONFIG.player.radius, bumpVx: 0, bumpVy: 0, bumpMs: 0 };

    const keysAt = (t: number) =>
      t < 600 ? { dx: 1, dy: 0 } : t < 900 ? { dx: 0, dy: 1 } : t < 1100 ? { dx: 0, dy: 0 } : t < 1700 ? { dx: -1, dy: -1 } : { dx: 0, dy: 0 };

    const inputsInFlight: { arrives: number; input: { dx: number; dy: number } }[] = [];
    const snapshotsInFlight: { arrives: number; sentAt: number; x: number; y: number }[] = [];
    let serverInput = { dx: 0, dy: 0 };
    let lastSent = { dx: 99, dy: 99 };
    let worstGap = 0;
    let shoved = false;
    let finalGap = 0;

    for (let t = 0; t <= 3000; t += step) {
      // the player's keys; a change travels to the server
      const keys = keysAt(t);
      if (keys.dx !== lastSent.dx || keys.dy !== lastSent.dy) {
        inputsInFlight.push({ arrives: t + ONE_WAY, input: keys });
        lastSent = keys;
      }
      // the server
      while (inputsInFlight.length && inputsInFlight[0].arrives <= t) serverInput = inputsInFlight.shift()!.input;
      if (shoveAtMs !== null && !shoved && t >= shoveAtMs) {
        shoved = true;
        server.bumpVx = 0;
        server.bumpVy = 80; // a 20 px shove over 250 ms that the client could not know about
        server.bumpMs = 250;
        ideal.bumpVx = 0;
        ideal.bumpVy = 80;
        ideal.bumpMs = 250;
      }
      moveHero(server, serverInput, step, walls);
      if (Math.round(t / step) % 3 === 0) snapshotsInFlight.push({ arrives: t + ONE_WAY, sentAt: t, x: server.x, y: server.y });
      // the client
      client.step(keys, step, walls, t);
      while (snapshotsInFlight.length && snapshotsInFlight[0].arrives <= t) {
        const s = snapshotsInFlight.shift()!;
        client.reconcile({ x: s.x, y: s.y }, t, 2 * ONE_WAY);
      }
      moveHero(ideal, keys, step, walls);

      // Ignore the shove in the "ideal": measure against the server's own truth once things settle.
      const gap = Math.hypot(client.x - ideal.x, client.y - ideal.y);
      if (shoveAtMs === null) worstGap = Math.max(worstGap, gap);
      finalGap = Math.hypot(client.x - server.x, client.y - server.y);
    }
    return { worstGap, finalGap };
  }

  it('stays within a few pixels of the ideal path while moving, and settles exactly on the server', () => {
    // Up to ~6 px comes from the server applying a key change on its own 60 Hz step, not ours.
    const result = simulate(null);
    expect(result.worstGap).toBeLessThan(8);
    expect(result.finalGap).toBeLessThan(0.5);
  });

  it('lets itself be pulled back to the server after a surprise shove', () => {
    expect(simulate(1000).finalGap).toBeLessThan(1);
  });
});
