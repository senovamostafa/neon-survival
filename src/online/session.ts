import type { AbilityId, Barrier, Maze, RankEntry } from '../core/types';
import type { ErrorCode, EventsSnap, RoomMember, RoomPhase, ServerMessage, Snapshot } from '../net/protocol';
import { SnapshotBuffer } from './interpolation';

/**
 * Everything the browser knows about the room it is in, built only from the server's messages.
 * No sockets and no drawing in here: feed it messages with apply() and read the result. That
 * keeps the whole message flow testable without a server or a browser.
 */

/** Which full-page screen the player should see. */
export type Screen = 'title' | 'lobby' | 'playing' | 'results';

export interface RoomInfo {
  phase: RoomPhase;
  players: RoomMember[];
  waiting: string[];
  hostId: string | null;
  minPlayers: number;
  maxPlayers: number;
  /** Browser time when the countdown will end (only during the countdown). */
  countdownEndsAt: number | null;
}

export interface ServerError {
  code: ErrorCode;
  message: string;
}

export class OnlineSession {
  playerId: string | null = null;
  code: string | null = null;
  /** Joined while a match was running: watches until the next lobby. */
  spectating = false;
  room: RoomInfo | null = null;

  /** The players of the current match, in colour order. */
  matchPlayers: RoomMember[] = [];
  durationMs = 240_000;
  maze: Maze | null = null;
  /** The walls as the maze message sent them. Snapshots say which are still outlines. */
  walls: Barrier[] = [];
  readonly snapshots = new SnapshotBuffer();
  results: RankEntry[] | null = null;
  lastError: ServerError | null = null;
  /** Measured delay to the server and back, in ms. */
  roundTripMs = 80;

  /** Match time when each frozen player went down (to count their respawn). */
  readonly downSince = new Map<string, number>();
  /** Match time when each player last scored (for the live scoreboard tie-break). */
  readonly lastOrbAt = new Map<string, number>();
  private readonly lastOrbs = new Map<string, number>();

  private pendingEvents: EventsSnap[] = [];
  private pendingRefusals: AbilityId[] = [];
  /** Snapshots up to this tick describe the old maze, so their wall warnings must be ignored. */
  private mazeAfterTick = -1;

  get screen(): Screen {
    if (!this.room) return 'title';
    switch (this.room.phase) {
      case 'lobby':
      case 'countdown':
        return 'lobby';
      case 'playing':
        return 'playing';
      case 'results':
        return 'results';
    }
  }

  get isHost(): boolean {
    return this.playerId !== null && this.room?.hostId === this.playerId;
  }

  /** Forget the room (after leaving or losing the connection). */
  reset(): void {
    this.playerId = null;
    this.code = null;
    this.spectating = false;
    this.room = null;
    this.clearMatch();
    this.lastError = null;
  }

  apply(msg: ServerMessage, now: number): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.code = msg.code;
        this.spectating = msg.spectating;
        this.lastError = null;
        break;

      case 'room':
        this.room = {
          phase: msg.phase,
          players: msg.players,
          waiting: msg.waiting,
          hostId: msg.hostId,
          minPlayers: msg.minPlayers,
          maxPlayers: msg.maxPlayers,
          countdownEndsAt: msg.countdownMs === undefined ? null : now + msg.countdownMs,
        };
        if (msg.phase === 'lobby') {
          // Back in the lobby: if we were waiting for a seat we now have one.
          this.spectating = !msg.players.some((p) => p.id === this.playerId);
          this.clearMatch();
        }
        break;

      case 'start':
        this.clearMatch();
        this.matchPlayers = msg.players;
        this.durationMs = msg.durationMs;
        break;

      case 'maze':
        this.maze = msg.maze;
        this.walls = msg.walls;
        this.mazeAfterTick = this.snapshots.latest?.snap.tick ?? -1;
        break;

      case 'snap':
        if (this.snapshots.push(msg, now)) this.trackSnapshot(msg);
        break;

      case 'ability':
        if (!msg.ok) this.pendingRefusals.push(msg.id);
        break;

      case 'results':
        this.results = msg.ranking;
        break;

      case 'pong':
        // Smooth the measurement a little so one slow reply does not throw the prediction off.
        this.roundTripMs = this.roundTripMs * 0.7 + Math.max(0, now - msg.ts) * 0.3;
        break;

      case 'error':
        this.lastError = { code: msg.code, message: msg.message };
        break;
    }
  }

  /** Walls with their current warning time, as of the newest snapshot. */
  currentWalls(): Barrier[] {
    const latest = this.snapshots.latest?.snap;
    if (!latest || latest.tick <= this.mazeAfterTick) return this.walls;
    const warn = new Map<number, number>(latest.warn ?? []);
    return this.walls.map((w, i) => ({ ...w, warningMs: warn.get(i) ?? 0 }));
  }

  /** Seconds-resolution countdown for the lobby. Null when not counting down. */
  countdownLeftMs(now: number): number | null {
    const end = this.room?.countdownEndsAt;
    return end === null || end === undefined ? null : Math.max(0, end - now);
  }

  /** Effects the snapshots reported since the last call (hand each to the screen once). */
  takeEvents(): EventsSnap[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  /** Abilities the server refused since the last call. */
  takeRefusals(): AbilityId[] {
    const refusals = this.pendingRefusals;
    this.pendingRefusals = [];
    return refusals;
  }

  private clearMatch(): void {
    this.matchPlayers = [];
    this.maze = null;
    this.walls = [];
    this.snapshots.clear();
    this.results = null;
    this.downSince.clear();
    this.lastOrbAt.clear();
    this.lastOrbs.clear();
    this.pendingEvents = [];
    this.pendingRefusals = [];
    this.mazeAfterTick = -1;
  }

  private trackSnapshot(snap: Snapshot): void {
    if (snap.ev) this.pendingEvents.push(snap.ev);
    for (const p of snap.players) {
      if (p.alive) this.downSince.delete(p.id);
      else if (!this.downSince.has(p.id)) this.downSince.set(p.id, snap.timeMs);

      if (p.orbs > (this.lastOrbs.get(p.id) ?? 0)) this.lastOrbAt.set(p.id, snap.timeMs);
      this.lastOrbs.set(p.id, p.orbs);
    }
  }
}
