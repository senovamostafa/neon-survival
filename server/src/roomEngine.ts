import { activateAbility } from '../../src/core/abilities';
import { CONFIG, type Config } from '../../src/core/config';
import { createMatch, startRun, stepGame } from '../../src/core/game';
import { setConnected } from '../../src/core/players';
import { rankPlayers } from '../../src/core/ranking';
import { FixedStepper } from '../../src/core/stepper';
import type { AbilityId, GameState, InputMap, InputState } from '../../src/core/types';
import {
  encode,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type RoomMember,
  type RoomPhase,
  type ServerMessage,
} from '../../src/net/protocol';
import { buildSnapshot, EventLog } from './snapshot';

/**
 * One room: the lobby, the countdown, the 4-minute match and the results.
 *
 * It is plain TypeScript with no Cloudflare code in it. The Durable Object (room.ts) is a thin
 * wrapper that gives it sockets and a timer, so the engine can be tested with fake players and
 * a fake clock. It runs the same game rules (src/core) as the browser and is the only place the
 * match is decided: clients only send what keys they press.
 */

/** Where the engine sends its messages. The Durable Object provides the real sockets. */
export interface Transport {
  send(connId: string, data: string): void;
  close(connId: string): void;
}

export interface EngineOptions {
  cfg?: Config;
  /** Current time in ms (injected so tests can use a fake clock). */
  now?: () => number;
  /** A fresh random seed for each match. */
  seed?: () => number;
  /** How often snapshots go out while playing. */
  snapshotEveryMs?: number;
  /** How long the results stay up before everyone goes back to the lobby. */
  resultsMs?: number;
  /** A player who has sent no input for this long is treated as standing still. */
  staleInputMs?: number;
}

interface Member {
  id: string;
  name: string;
  /** null while disconnected. */
  connId: string | null;
  /** Arrived during a match: watches until the next lobby. */
  waiting: boolean;
  input: InputState;
  inputAt: number;
}

interface Conn {
  id: string;
  member: Member | null;
  /** Rate limit: a bucket of message "tokens". */
  tokens: number;
  refilledAt: number;
}

const IDLE: InputState = { dx: 0, dy: 0 };

function isJoinMessage(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return false;
  try {
    return (JSON.parse(raw) as { t?: unknown } | null)?.t === 'join';
  } catch {
    return false;
  }
}
const BUCKET_SIZE = 60;
const BUCKET_REFILL_PER_SEC = 60;

export interface EngineStats {
  ticks: number;
  /** Ticks that arrived more than 40 ms after the previous one (the server was running behind). */
  lateTicks: number;
  maxTickGapMs: number;
  stepsRun: number;
  snapshotsSent: number;
  lastSnapshotBytes: number;
  maxSnapshotBytes: number;
  messagesReceived: number;
  messagesDropped: number;
  connectionsPeak: number;
}

export class RoomEngine {
  private readonly cfg: Config;
  private readonly now: () => number;
  private readonly seed: () => number;
  private readonly snapshotEveryMs: number;
  private readonly resultsMs: number;
  private readonly staleInputMs: number;

  private readonly conns = new Map<string, Conn>();
  private members: Member[] = [];
  private nextMemberNumber = 1;

  private phase: RoomPhase = 'lobby';
  private countdownEndsAt = 0;
  private resultsEndsAt = 0;

  private state: GameState | null = null;
  private stepper: FixedStepper;
  private lastTickAt: number | null = null;
  private nextSnapshotAt = 0;
  private tickNumber = 0;
  private lastMaze: GameState['maze'] | null = null;
  private readonly events = new EventLog();

  readonly stats: EngineStats = {
    ticks: 0,
    lateTicks: 0,
    maxTickGapMs: 0,
    stepsRun: 0,
    snapshotsSent: 0,
    lastSnapshotBytes: 0,
    maxSnapshotBytes: 0,
    messagesReceived: 0,
    messagesDropped: 0,
    connectionsPeak: 0,
  };

  constructor(
    readonly code: string,
    private readonly transport: Transport,
    options: EngineOptions = {},
  ) {
    this.cfg = options.cfg ?? CONFIG;
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? (() => Math.floor(Math.random() * 0xffffffff));
    this.snapshotEveryMs = options.snapshotEveryMs ?? 50;
    this.resultsMs = options.resultsMs ?? 30_000;
    this.staleInputMs = options.staleInputMs ?? 600;
    this.stepper = new FixedStepper(this.cfg.timestep.stepMs, this.cfg.timestep.maxFrameMs);
  }

  // ---- what the outside can ask --------------------------------------------

  get currentPhase(): RoomPhase {
    return this.phase;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  get playerCount(): number {
    return this.members.filter((m) => !m.waiting).length;
  }

  /** The match in progress (read-only use: tests and stats). */
  get match(): GameState | null {
    return this.state;
  }

  /** True when the room needs frequent ticks (counting down or playing). */
  get needsFastTicks(): boolean {
    return this.phase === 'countdown' || this.phase === 'playing';
  }

  // ---- connections ---------------------------------------------------------

  connect(connId: string): void {
    this.conns.set(connId, { id: connId, member: null, tokens: BUCKET_SIZE, refilledAt: this.now() });
    this.stats.connectionsPeak = Math.max(this.stats.connectionsPeak, this.conns.size);
  }

  disconnect(connId: string): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.conns.delete(connId);
    const member = conn.member;
    if (!member) return;

    member.connId = null;
    const inMatch = this.phase === 'playing' && !member.waiting;
    if (inMatch && this.state) {
      // The hero stays for a few seconds, then disappears. The same name can come back.
      setConnected(this.state, member.id, false, this.cfg);
    } else {
      this.members = this.members.filter((m) => m !== member);
      if (this.phase === 'countdown' && this.connectedPlayers().length < this.cfg.match.minPlayers) {
        this.phase = 'lobby'; // not enough players any more: cancel the countdown
      }
    }
    this.broadcastRoom();
  }

  // ---- messages from players -----------------------------------------------

  message(connId: string, raw: unknown): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.stats.messagesReceived++;

    // Rate limit: refill the bucket for the time that passed, then spend one token.
    const now = this.now();
    conn.tokens = Math.min(BUCKET_SIZE, conn.tokens + ((now - conn.refilledAt) / 1000) * BUCKET_REFILL_PER_SEC);
    conn.refilledAt = now;
    if (conn.tokens < 1) {
      this.stats.messagesDropped++;
      return;
    }
    conn.tokens -= 1;

    const msg = parseClientMessage(raw);
    if (!msg) {
      this.stats.messagesDropped++;
      // A join with an unusable name deserves an answer; everything else invalid is just ignored.
      if (isJoinMessage(raw)) this.error(conn.id, 'bad-name', 'Names are 3-12 letters, digits or underscores.');
      return;
    }
    try {
      this.handle(conn, msg);
    } catch {
      this.stats.messagesDropped++; // a bug must never take the room down
    }
  }

  private handle(conn: Conn, msg: ClientMessage): void {
    if (msg.t === 'ping') {
      this.send(conn.id, { t: 'pong', ts: msg.ts });
      return;
    }
    if (msg.t === 'join') return this.join(conn, msg.name);

    const member = conn.member;
    if (!member) return this.error(conn.id, 'not-joined', 'Join the room first.');

    switch (msg.t) {
      case 'input':
        member.input = { dx: msg.dx, dy: msg.dy };
        member.inputAt = this.now();
        break;
      case 'ability':
        this.useAbility(conn, member, msg.id);
        break;
      case 'start':
        this.startCountdown(conn, member);
        break;
      case 'again':
        if (this.hostId() !== member.id) return this.error(conn.id, 'not-host', 'Only the host can do that.');
        if (this.phase !== 'results') return this.error(conn.id, 'wrong-phase', 'The match is not over yet.');
        this.backToLobby();
        break;
    }
  }

  private join(conn: Conn, name: string): void {
    if (conn.member) return this.error(conn.id, 'already-joined', 'You are already in this room.');

    const same = this.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (same) {
      if (same.connId !== null) return this.error(conn.id, 'name-taken', 'That name is already in this room.');
      // The same name coming back is the same player: pick up where they left off.
      same.connId = conn.id;
      conn.member = same;
      if (this.state && this.phase === 'playing') setConnected(this.state, same.id, true, this.cfg);
      this.welcome(conn, same);
      this.broadcastRoom();
      this.sendMatchSetup(conn.id);
      return;
    }

    const lobbyOpen = this.phase === 'lobby';
    if (lobbyOpen && this.playerCount >= this.cfg.match.maxPlayers) {
      return this.error(conn.id, 'room-full', 'This room is full.');
    }

    const member: Member = {
      id: `p${this.nextMemberNumber++}`,
      name,
      connId: conn.id,
      waiting: !lobbyOpen,
      input: IDLE,
      inputAt: 0,
    };
    this.members.push(member);
    conn.member = member;
    this.welcome(conn, member);
    this.broadcastRoom();
    this.sendMatchSetup(conn.id);
  }

  private startCountdown(conn: Conn, member: Member): void {
    if (this.hostId() !== member.id) return this.error(conn.id, 'not-host', 'Only the host can start the match.');
    if (this.phase !== 'lobby') return this.error(conn.id, 'wrong-phase', 'A match is already under way.');
    if (this.connectedPlayers().length < this.cfg.match.minPlayers) {
      return this.error(conn.id, 'not-enough-players', `You need at least ${this.cfg.match.minPlayers} players.`);
    }
    this.phase = 'countdown';
    this.countdownEndsAt = this.now() + this.cfg.match.countdownMs;
    this.broadcastRoom();
  }

  private useAbility(conn: Conn, member: Member, id: AbilityId): void {
    if (!this.state || this.phase !== 'playing' || member.waiting) {
      this.send(conn.id, { t: 'ability', id, ok: false, reason: 'not-playing' });
      return;
    }
    const result = activateAbility(this.state, member.id, id, this.cfg);
    if (result.ok) {
      this.events.addAbility(member.id, id, result.from, result.to);
      this.send(conn.id, { t: 'ability', id, ok: true });
    } else {
      this.send(conn.id, { t: 'ability', id, ok: false, reason: result.reason });
    }
  }

  // ---- the clock -----------------------------------------------------------

  /** Moves the room forward to `nowMs`. The Durable Object calls this several times a second. */
  tick(nowMs: number = this.now()): void {
    const gap = this.lastTickAt === null ? 0 : nowMs - this.lastTickAt;
    this.lastTickAt = nowMs;
    this.stats.ticks++;
    if (gap > 40) this.stats.lateTicks++;
    this.stats.maxTickGapMs = Math.max(this.stats.maxTickGapMs, gap);

    switch (this.phase) {
      case 'countdown':
        if (nowMs >= this.countdownEndsAt) this.startMatch(nowMs);
        break;
      case 'playing':
        this.runMatch(nowMs, gap);
        break;
      case 'results':
        if (nowMs >= this.resultsEndsAt) this.backToLobby();
        break;
      case 'lobby':
        break;
    }
  }

  private startMatch(nowMs: number): void {
    const roster = this.members.filter((m) => !m.waiting && m.connId !== null).map((m) => ({ id: m.id, name: m.name }));
    // Anyone who dropped during the countdown is gone; if that leaves too few, stay in the lobby.
    this.members = this.members.filter((m) => m.waiting || m.connId !== null);
    if (roster.length < this.cfg.match.minPlayers) {
      this.phase = 'lobby';
      this.broadcastRoom();
      return;
    }

    this.state = createMatch(this.seed(), roster, this.cfg);
    startRun(this.state);
    this.stepper = new FixedStepper(this.cfg.timestep.stepMs, this.cfg.timestep.maxFrameMs);
    this.phase = 'playing';
    this.tickNumber = 0;
    this.nextSnapshotAt = nowMs;
    this.lastMaze = null;
    this.broadcastRoom();
    this.broadcast({ t: 'start', players: this.roomMembers(), durationMs: this.cfg.match.durationMs, timeMs: 0 });
    this.sendMazeIfNew();
  }

  private runMatch(nowMs: number, gapMs: number): void {
    const state = this.state;
    if (!state) return;

    const steps = this.stepper.advance(gapMs);
    for (let i = 0; i < steps; i++) {
      const result = stepGame(state, this.collectInputs(nowMs), this.cfg.timestep.stepMs, this.cfg);
      this.stats.stepsRun++;
      this.events.addStep(result);
      if (result.finished) break;
    }
    this.sendMazeIfNew();

    const finished = state.status === 'finished';
    if (nowMs >= this.nextSnapshotAt || finished) {
      this.sendSnapshot();
      // Keep to a steady grid (every 50 ms) rather than "50 ms after the last one went out",
      // otherwise each snapshot would drift late by up to one tick. If we fell far behind, skip ahead.
      this.nextSnapshotAt += this.snapshotEveryMs;
      if (this.nextSnapshotAt <= nowMs) this.nextSnapshotAt = nowMs + this.snapshotEveryMs;
    }
    if (finished) this.finishMatch(nowMs);
  }

  private collectInputs(nowMs: number): InputMap {
    const inputs: InputMap = {};
    for (const m of this.members) {
      if (m.waiting) continue;
      inputs[m.id] = nowMs - m.inputAt > this.staleInputMs ? IDLE : m.input;
    }
    return inputs;
  }

  private finishMatch(nowMs: number): void {
    if (!this.state) return;
    this.phase = 'results';
    this.resultsEndsAt = nowMs + this.resultsMs;
    this.broadcast({ t: 'results', ranking: rankPlayers(this.state) });
    this.broadcastRoom();
  }

  private backToLobby(): void {
    this.phase = 'lobby';
    this.state = null;
    this.lastMaze = null;
    // Players who left during the match are gone; people who were waiting take their seats.
    this.members = this.members.filter((m) => m.connId !== null);
    for (const m of this.members) {
      if (m.waiting && this.playerCount < this.cfg.match.maxPlayers) m.waiting = false;
    }
    this.broadcastRoom();
  }

  // ---- sending -------------------------------------------------------------

  private sendSnapshot(): void {
    if (!this.state) return;
    const data = encode(buildSnapshot(this.state, ++this.tickNumber, this.events.take()));
    this.stats.snapshotsSent++;
    this.stats.lastSnapshotBytes = data.length;
    this.stats.maxSnapshotBytes = Math.max(this.stats.maxSnapshotBytes, data.length);
    // Serialised once, sent to everyone.
    for (const id of this.conns.keys()) this.transport.send(id, data);
  }

  private sendMazeIfNew(): void {
    if (!this.state || this.state.maze === this.lastMaze) return;
    this.lastMaze = this.state.maze;
    this.broadcast({ t: 'maze', sector: this.state.sector, maze: this.state.maze, walls: this.state.barriers });
  }

  /** Brings someone who joins (or comes back) mid-match up to date. */
  private sendMatchSetup(connId: string): void {
    if (!this.state || this.phase !== 'playing') return;
    this.send(connId, { t: 'start', players: this.roomMembers(), durationMs: this.cfg.match.durationMs, timeMs: Math.round(this.state.timeMs) });
    this.send(connId, { t: 'maze', sector: this.state.sector, maze: this.state.maze, walls: this.state.barriers });
  }

  private welcome(conn: Conn, member: Member): void {
    this.send(conn.id, { t: 'welcome', playerId: member.id, code: this.code, spectating: member.waiting });
  }

  private broadcastRoom(): void {
    const message: ServerMessage = {
      t: 'room',
      phase: this.phase,
      players: this.roomMembers(),
      waiting: this.members.filter((m) => m.waiting).map((m) => m.name),
      hostId: this.hostId(),
      minPlayers: this.cfg.match.minPlayers,
      maxPlayers: this.cfg.match.maxPlayers,
    };
    if (this.phase === 'countdown') message.countdownMs = Math.max(0, this.countdownEndsAt - this.now());
    this.broadcast(message);
  }

  private broadcast(message: ServerMessage): void {
    const data = encode(message);
    for (const id of this.conns.keys()) this.transport.send(id, data);
  }

  private send(connId: string, message: ServerMessage): void {
    this.transport.send(connId, encode(message));
  }

  private error(connId: string, code: ErrorCode, message: string): void {
    this.send(connId, { t: 'error', code, message });
  }

  // ---- who is who ----------------------------------------------------------

  /** The host is the first connected player who joined. If they leave, the next one takes over. */
  private hostId(): string | null {
    return this.members.find((m) => !m.waiting && m.connId !== null)?.id ?? null;
  }

  private connectedPlayers(): Member[] {
    return this.members.filter((m) => !m.waiting && m.connId !== null);
  }

  private roomMembers(): RoomMember[] {
    // During a match the colours come from the match itself, so everyone agrees.
    const colours = new Map(this.state?.players.map((p) => [p.id, p.colorIndex]) ?? []);
    let next = 0;
    return this.members
      .filter((m) => !m.waiting)
      .map((m) => ({
        id: m.id,
        name: m.name,
        colorIndex: colours.get(m.id) ?? next++ % 10,
        connected: m.connId !== null,
      }));
  }
}
