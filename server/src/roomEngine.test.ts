import { describe, expect, it } from 'vitest';
import { CONFIG, type Config } from '../../src/core/config';
import type { AbilityId } from '../../src/core/types';
import type { ServerMessage, Snapshot } from '../../src/net/protocol';
import { RoomEngine } from './roomEngine';

/** A fake room: a fake clock, fake players, and a record of every message sent to each of them. */
function room(options: { cfg?: Config; resultsMs?: number } = {}) {
  let t = 10_000;
  const inbox = new Map<string, ServerMessage[]>();
  const closed: string[] = [];
  const engine = new RoomEngine(
    'ABCD',
    {
      send: (id, data) => inbox.get(id)?.push(JSON.parse(data) as ServerMessage),
      close: (id) => closed.push(id),
    },
    { now: () => t, seed: () => 7, ...options },
  );

  let nextConn = 1;
  const clock = {
    /** Moves time forward in 16 ms ticks, like the real timer would. */
    advance(ms: number): void {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + 16);
        engine.tick(t);
      }
    },
    get now(): number {
      return t;
    },
  };

  function player(name?: string) {
    const id = `c${nextConn++}`;
    inbox.set(id, []);
    engine.connect(id);
    const api = {
      id,
      send: (m: object | string) => engine.message(id, typeof m === 'string' ? m : JSON.stringify(m)),
      join: (n = name!) => api.send({ t: 'join', name: n }),
      input: (dx: number, dy: number) => api.send({ t: 'input', dx, dy }),
      ability: (ability: AbilityId) => api.send({ t: 'ability', id: ability }),
      start: () => api.send({ t: 'start' }),
      again: () => api.send({ t: 'again' }),
      leave: () => engine.disconnect(id),
      get messages(): ServerMessage[] {
        return inbox.get(id)!;
      },
      of<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
        return api.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === type);
      },
      last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
        return api.of(type).at(-1);
      },
      clear: () => (inbox.get(id)!.length = 0),
    };
    if (name) api.join();
    return api;
  }

  /** `n` players already in the lobby, the first one being the host. */
  function lobby(n: number) {
    return Array.from({ length: n }, (_, i) => player(`Player${i + 1}`));
  }

  return { engine, clock, player, lobby, closed };
}

/** A config with a short match so full games run quickly in the tests. */
function shortMatch(durationMs: number, countdownMs = 1000): Config {
  return { ...CONFIG, match: { ...CONFIG.match, durationMs, countdownMs } };
}

describe('joining', () => {
  it('welcomes players, makes the first one host and tells everyone who is in the room', () => {
    const r = room();
    const [a, b] = [r.player('Alice'), r.player('Bob_2')];
    expect(a.last('welcome')).toEqual({ t: 'welcome', playerId: 'p1', code: 'ABCD', spectating: false });
    expect(b.last('welcome')?.playerId).toBe('p2');
    const state = b.last('room')!;
    expect(state.phase).toBe('lobby');
    expect(state.hostId).toBe('p1');
    expect(state.players.map((p) => p.name)).toEqual(['Alice', 'Bob_2']);
    expect(state.minPlayers).toBe(3);
    expect(state.maxPlayers).toBe(10);
    expect(a.last('room')?.players).toHaveLength(2); // the first player heard about the second too
  });

  it('refuses unusable names with a clear error', () => {
    const r = room();
    for (const name of ['ab', 'has space', 'waytoolongname1']) {
      const p = r.player();
      p.join(name);
      expect(p.last('error')?.code).toBe('bad-name');
    }
    expect(r.engine.playerCount).toBe(0);
  });

  it('refuses a name already in the room, whatever the capital letters', () => {
    const r = room();
    r.player('Alice');
    const twin = r.player();
    twin.join('aLiCe');
    expect(twin.last('error')?.code).toBe('name-taken');
    expect(r.engine.playerCount).toBe(1);
  });

  it('does not let one connection join twice, or do anything before joining', () => {
    const r = room();
    const a = r.player('Alice');
    a.join('Alice2');
    expect(a.last('error')?.code).toBe('already-joined');

    const stranger = r.player();
    stranger.input(1, 0);
    stranger.start();
    expect(stranger.of('error').map((e) => e.code)).toEqual(['not-joined', 'not-joined']);
  });

  it('is full at 10 players', () => {
    const r = room();
    r.lobby(10);
    const late = r.player('Eleven');
    expect(late.last('error')?.code).toBe('room-full');
    expect(r.engine.playerCount).toBe(10);
  });

  it('hands the host role to the next player when the host leaves', () => {
    const r = room();
    const [a, b, c] = r.lobby(3);
    a.leave();
    expect(b.last('room')?.hostId).toBe('p2');
    expect(b.last('room')?.players.map((p) => p.name)).toEqual(['Player2', 'Player3']);
    b.leave();
    expect(c.last('room')?.hostId).toBe('p3');
  });

  it('answers pings', () => {
    const r = room();
    const a = r.player('Alice');
    a.send({ t: 'ping', ts: 77 });
    expect(a.last('pong')).toEqual({ t: 'pong', ts: 77 });
  });
});

describe('starting a match', () => {
  it('needs the host and at least 3 players', () => {
    const r = room();
    const [host, guest] = r.lobby(2);
    host.start();
    expect(host.last('error')?.code).toBe('not-enough-players');

    const third = r.player('Player3');
    guest.start();
    expect(guest.last('error')?.code).toBe('not-host');
    expect(r.engine.currentPhase).toBe('lobby');

    host.start();
    expect(r.engine.currentPhase).toBe('countdown');
    expect(third.last('room')?.phase).toBe('countdown');
    expect(third.last('room')?.countdownMs).toBeGreaterThan(4000);
  });

  it('counts down 5 seconds and then starts, telling everyone the players and the maze', () => {
    const r = room();
    const [host, ...others] = r.lobby(3);
    host.start();
    r.clock.advance(4900);
    expect(r.engine.currentPhase).toBe('countdown');
    r.clock.advance(200);
    expect(r.engine.currentPhase).toBe('playing');

    for (const p of [host, ...others]) {
      const start = p.last('start')!;
      expect(start.durationMs).toBe(240_000);
      expect(start.players.map((x) => x.name)).toEqual(['Player1', 'Player2', 'Player3']);
      expect(new Set(start.players.map((x) => x.colorIndex)).size).toBe(3);
      const maze = p.last('maze')!;
      expect(maze.maze.cols).toBe(16);
      expect(maze.walls.length).toBeGreaterThan(10);
      expect(p.last('room')?.phase).toBe('playing');
    }
  });

  it('cancels the countdown if too many players leave', () => {
    const r = room();
    const [host, b, c] = r.lobby(3);
    host.start();
    r.clock.advance(2000);
    c.leave();
    expect(r.engine.currentPhase).toBe('lobby');
    r.clock.advance(6000);
    expect(r.engine.currentPhase).toBe('lobby');
    expect(b.last('room')?.phase).toBe('lobby');
  });

  it('does not start a second match while one is running', () => {
    const r = room();
    const [host] = r.lobby(3);
    host.start();
    r.clock.advance(5100);
    host.start();
    expect(host.last('error')?.code).toBe('wrong-phase');
  });
});

describe('during the match', () => {
  function playing(n = 3, cfg?: Config) {
    const r = room({ cfg });
    const players = r.lobby(n);
    players[0].start();
    r.clock.advance((cfg ?? CONFIG).match.countdownMs + 100);
    expect(r.engine.currentPhase).toBe('playing');
    // an empty arena makes movement tests predictable
    r.engine.match!.barriers = [];
    players.forEach((p) => p.clear());
    return { r, players };
  }

  it('sends about 20 snapshots a second to everyone', () => {
    const { r, players } = playing();
    r.clock.advance(2000);
    for (const p of players) {
      const count = p.of('snap').length;
      expect(count).toBeGreaterThanOrEqual(38);
      expect(count).toBeLessThanOrEqual(42);
    }
  });

  it('puts the whole picture in each snapshot', () => {
    const { r, players } = playing();
    r.clock.advance(300);
    const snap = players[0].last('snap')!;
    expect(snap.players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    for (const p of snap.players) {
      expect(p.lives).toBe(3);
      expect(p.alive).toBe(true);
      expect(p.ab).toHaveLength(8);
      expect(p.x).toBeGreaterThan(CONFIG.arena.x);
      expect(p.x).toBeLessThan(CONFIG.arena.x + CONFIG.arena.width);
    }
    expect(snap.timeMs).toBeGreaterThan(200);
    expect(snap.timeMs).toBeLessThan(400);
  });

  it('moves a hero when its player sends input, and stops when the input stops coming', () => {
    const { r, players } = playing();
    const me = () => r.engine.match!.players[0];
    const x0 = me().x;
    players[0].input(1, 0);
    r.clock.advance(500);
    players[0].input(1, 0); // a client keeps repeating its input
    r.clock.advance(500);
    expect(me().x - x0).toBeCloseTo(CONFIG.player.speed, -1); // about 180 px in a second

    const x1 = me().x;
    r.clock.advance(1500); // no more input: after a moment the hero stands still
    const travelled = me().x - x1;
    expect(travelled).toBeLessThan(CONFIG.player.speed * 0.7); // at most the short stale window
    const x2 = me().x;
    r.clock.advance(500);
    expect(me().x).toBe(x2);
  });

  it('ignores someone else trying to steer your hero: input only moves your own', () => {
    const { r, players } = playing();
    const others = r.engine.match!.players.slice(1).map((p) => ({ x: p.x, y: p.y }));
    players[0].input(0, 1);
    r.clock.advance(300);
    r.engine.match!.players.slice(1).forEach((p, i) => {
      expect([p.x, p.y]).toEqual([others[i].x, others[i].y]);
    });
  });

  it('answers ability requests and shows them to everyone', () => {
    const { r, players } = playing();
    players[0].ability('shield');
    expect(players[0].last('ability')).toEqual({ t: 'ability', id: 'shield', ok: false, reason: 'no-energy' });

    r.engine.match!.players[0].energy = 100;
    players[0].ability('shield');
    expect(players[0].last('ability')).toEqual({ t: 'ability', id: 'shield', ok: true });
    expect(r.engine.match!.players[0].energy).toBe(60);
    r.clock.advance(100);
    const withEvent = players[1].of('snap').find((s) => s.ev?.abilities);
    expect(withEvent?.ev?.abilities?.[0]).toMatchObject({ p: 'p1', id: 'shield' });
    expect(withEvent?.players[0].ab[0]).toBeGreaterThan(0); // shield active time is visible to others
  });

  it('reports what happened (pickups, hits...) once, in the next snapshot', () => {
    const { r, players } = playing();
    const state = r.engine.match!;
    const hero = state.players[0];
    state.orbs.push({ x: hero.x, y: hero.y, radius: 7, ttlMs: 9000 });
    r.clock.advance(100);
    const snaps = players[1].of('snap');
    const events = snaps.filter((s) => s.ev?.pickups).map((s) => s.ev!.pickups);
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toMatchObject({ p: 'p1' });
    expect(snaps.at(-1)!.players[0].orbs).toBe(1);
  });

  it('sends the walls again when a new maze appears, and shows which are still outlines', () => {
    const { r, players } = playing();
    r.engine.match!.timeMs = CONFIG.transform.everyMs - 20;
    players.forEach((p) => p.clear());
    r.clock.advance(200);
    const maze = players[0].last('maze')!;
    expect(maze.sector).toBe(1);
    expect(maze.walls.every((w) => w.warningMs > 0)).toBe(true);
    const snap = players[0].last('snap')!;
    expect(snap.warn?.length).toBe(maze.walls.length);
    r.clock.advance(CONFIG.transform.barrierWarningMs + 300);
    expect(players[0].last('snap')!.warn).toBeUndefined();
  });

  it('keeps the match going when a player drops, removes the hero after 10 s and lets the same name resume', () => {
    const { r, players } = playing();
    const [, b] = players;
    r.engine.match!.players[1].orbs = 5;
    b.leave();
    expect(r.engine.currentPhase).toBe('playing');
    expect(r.engine.match!.players[1].connected).toBe(false);
    expect(players[0].last('room')?.players.find((p) => p.id === 'p2')?.connected).toBe(false);

    r.clock.advance(4000);
    const back = r.player('player2'); // same name, different capitals
    back.join();
    expect(back.last('welcome')).toMatchObject({ playerId: 'p2', spectating: false });
    expect(back.last('start')).toBeDefined(); // brought up to date straight away
    expect(back.last('maze')).toBeDefined();
    expect(r.engine.match!.players[1].connected).toBe(true);
    r.clock.advance(12_000);
    expect(r.engine.match!.players[1].present).toBe(true);
    expect(r.engine.match!.players[1].orbs).toBe(5);

    back.leave();
    r.clock.advance(11_000);
    expect(r.engine.match!.players[1].present).toBe(false); // gone after 10 s
    expect(r.engine.match!.players[1].orbs).toBe(5); // but the score stays
    const comeBack = r.player('Player2');
    comeBack.join();
    expect(r.engine.match!.players[1].present).toBe(true); // a late return brings the hero back
  });

  it('lets a new person watch, but not play, and puts them in the next lobby', () => {
    const cfg = shortMatch(5000);
    const r = room({ cfg, resultsMs: 2000 });
    const [host] = r.lobby(3);
    host.start();
    r.clock.advance(1100);
    const watcher = r.player('Watcher');
    watcher.join();
    expect(watcher.last('welcome')?.spectating).toBe(true);
    expect(watcher.last('start')).toBeDefined();
    expect(watcher.of('snap').length).toBe(0);
    r.clock.advance(500);
    expect(watcher.of('snap').length).toBeGreaterThan(5); // watching the match
    expect(r.engine.match!.players).toHaveLength(3); // but not in it

    r.clock.advance(5000); // match over
    expect(r.engine.currentPhase).toBe('results');
    r.clock.advance(2100);
    expect(r.engine.currentPhase).toBe('lobby');
    expect(watcher.last('room')?.players.map((p) => p.name)).toEqual(['Player1', 'Player2', 'Player3', 'Watcher']);
  });
});

describe('after the match', () => {
  it('sends the ranking, then the host can take everyone back to the lobby', () => {
    const cfg = shortMatch(4000);
    const r = room({ cfg });
    const players = r.lobby(3);
    players[0].start();
    r.clock.advance(1100);
    r.engine.match!.players[2].orbs = 9;
    r.engine.match!.players[1].orbs = 4;
    r.clock.advance(4500);

    expect(r.engine.currentPhase).toBe('results');
    const results = players[0].last('results')!;
    expect(results.ranking.map((x) => x.name)).toEqual(['Player3', 'Player2', 'Player1']);
    expect(results.ranking.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(players[1].last('room')?.phase).toBe('results');

    players[1].again();
    expect(players[1].last('error')?.code).toBe('not-host');
    players[0].again();
    expect(r.engine.currentPhase).toBe('lobby');
    expect(players[2].last('room')?.phase).toBe('lobby');
    expect(r.engine.match).toBeNull();

    // and the same people can play again straight away
    players[0].start();
    expect(r.engine.currentPhase).toBe('countdown');
  });

  it('goes back to the lobby by itself, dropping anyone who left', () => {
    const cfg = shortMatch(3000);
    const r = room({ cfg, resultsMs: 5000 });
    const players = r.lobby(4);
    players[0].start();
    r.clock.advance(1100);
    players[3].leave();
    r.clock.advance(3500);
    expect(r.engine.currentPhase).toBe('results');
    r.clock.advance(5100);
    expect(r.engine.currentPhase).toBe('lobby');
    expect(players[0].last('room')?.players.map((p) => p.name)).toEqual(['Player1', 'Player2', 'Player3']);
  });

  it('refuses "again" before the match is over', () => {
    const r = room();
    const [host] = r.lobby(3);
    host.again();
    expect(host.last('error')?.code).toBe('wrong-phase');
  });
});

describe('a full 4-minute match with 10 players', () => {
  it('runs to the end, stays small, and ranks everyone', () => {
    const r = room();
    const players = r.lobby(10);
    players[0].start();
    r.clock.advance(5100);
    expect(r.engine.currentPhase).toBe('playing');

    // everyone presses keys now and then, and uses an ability when they can
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]];
    let step = 0;
    while (r.engine.currentPhase === 'playing' && step < 300) {
      players.forEach((p, i) => {
        const d = dirs[(step + i) % dirs.length];
        p.input(d[0], d[1]);
        if (step % 7 === i % 7) p.ability((['shield', 'slow', 'teleport', 'magnet'] as const)[i % 4]);
      });
      r.clock.advance(1000);
      step++;
    }
    expect(r.engine.currentPhase).toBe('results');

    const results = players[4].last('results')!;
    expect(results.ranking).toHaveLength(10);
    expect(new Set(results.ranking.map((x) => x.playerId)).size).toBe(10);
    const stats = r.engine.stats;
    expect(stats.snapshotsSent).toBeGreaterThan(4500);
    expect(stats.lateTicks).toBe(0);
    // A snapshot for 10 players must stay small (it goes to 10 people 20 times a second).
    expect(stats.maxSnapshotBytes).toBeLessThan(6000);
  });
});

describe('abuse and bad data', () => {
  it('survives garbage without crashing or changing anything', () => {
    const r = room();
    const [a] = r.lobby(3);
    const junk = ['', 'x', '{', 'null', '[]', '{"t":1}', '{"t":"input"}', 'a'.repeat(5000), '\u0000\u0001', '{"t":"join","name":{"x":1}}'];
    for (const j of junk) a.send(j);
    a.send(JSON.stringify({ t: 'ability', id: '__proto__' }));
    expect(r.engine.playerCount).toBe(3);
    expect(r.engine.currentPhase).toBe('lobby');
    expect(r.engine.stats.messagesDropped).toBeGreaterThanOrEqual(junk.length);
  });

  it('drops a flood of messages from one connection but still serves everyone else', () => {
    const r = room();
    const [a, b, c] = r.lobby(3);
    a.start();
    r.clock.advance(5100);
    r.engine.match!.barriers = [];
    for (let i = 0; i < 500; i++) a.input(1, 0); // 500 messages in the same instant
    expect(r.engine.stats.messagesDropped).toBeGreaterThan(400);
    b.input(0, 1);
    r.clock.advance(100);
    expect(r.engine.currentPhase).toBe('playing');
    // after a moment the flooder is heard again
    r.clock.advance(1000);
    a.input(-1, 0);
    expect(r.engine.stats.messagesDropped).toBeLessThan(520);
    expect(c.of('snap').length).toBeGreaterThan(0);
  });

  it('forgets a player cleanly when their connection closes before joining', () => {
    const r = room();
    const p = r.player();
    p.leave();
    expect(r.engine.connectionCount).toBe(0);
    p.leave(); // closing twice is harmless
    expect(r.engine.playerCount).toBe(0);
  });

  it('ignores snapshots-only phases for the lobby (nothing is sent to an empty room)', () => {
    const r = room();
    r.clock.advance(5000);
    expect(r.engine.stats.snapshotsSent).toBe(0);
  });
});

describe('stats', () => {
  it('count late ticks so we can tell when the server falls behind', () => {
    const r = room();
    r.player('Alice');
    r.engine.tick(r.clock.now + 16);
    r.engine.tick(r.clock.now + 16 + 200); // a 200 ms hiccup
    expect(r.engine.stats.lateTicks).toBe(1);
    expect(r.engine.stats.maxTickGapMs).toBeGreaterThanOrEqual(200);
  });

  it('expose the snapshot type to clients unchanged by JSON', () => {
    const r = room();
    const players = r.lobby(3);
    players[0].start();
    r.clock.advance(5200);
    const snap = players[1].last('snap') as Snapshot;
    expect(snap.t).toBe('snap');
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});
