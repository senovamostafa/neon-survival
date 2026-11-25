import type { AbilityId, Barrier, DrifterKind, Maze, RankEntry } from '../core/types';

/**
 * The messages sent between a browser and the room server, as JSON text over a WebSocket.
 * This file is shared: the server uses it to read and write messages, and the online client
 * (next phase) will use the same types, so they can never drift apart.
 */

export const NAME_PATTERN = /^[A-Za-z0-9_]{3,12}$/;
export const ROOM_CODE_PATTERN = /^[A-Z]{4}$/;

/** Longest message the server will read. Real messages are far smaller. */
export const MAX_MESSAGE_BYTES = 512;

export type RoomPhase = 'lobby' | 'countdown' | 'playing' | 'results';

/** The order of the numbers in PlayerSnap.ab: [active, cooldown] for each ability. */
export const ABILITY_ORDER: AbilityId[] = ['shield', 'slow', 'teleport', 'magnet'];

// ---- client -> server ------------------------------------------------------

export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'start' } // host only
  | { t: 'input'; dx: number; dy: number }
  | { t: 'ability'; id: AbilityId }
  | { t: 'again' } // host only: back to the lobby after the results
  | { t: 'ping'; ts: number };

const ABILITIES = new Set<string>(ABILITY_ORDER);

/**
 * Reads one message from a client. Returns null for anything that is not exactly a valid
 * message, so the server never has to trust what it receives. Inputs are forced to -1, 0 or 1.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;

  switch (m.t) {
    case 'join':
      return typeof m.name === 'string' && NAME_PATTERN.test(m.name) ? { t: 'join', name: m.name } : null;
    case 'start':
      return { t: 'start' };
    case 'again':
      return { t: 'again' };
    case 'input':
      if (typeof m.dx !== 'number' || typeof m.dy !== 'number') return null;
      if (!Number.isFinite(m.dx) || !Number.isFinite(m.dy)) return null;
      return { t: 'input', dx: Math.sign(m.dx), dy: Math.sign(m.dy) };
    case 'ability':
      return typeof m.id === 'string' && ABILITIES.has(m.id) ? { t: 'ability', id: m.id as AbilityId } : null;
    case 'ping':
      return typeof m.ts === 'number' && Number.isFinite(m.ts) ? { t: 'ping', ts: m.ts } : null;
    default:
      return null;
  }
}

// ---- server -> client ------------------------------------------------------

export interface RoomMember {
  id: string;
  name: string;
  colorIndex: number;
  connected: boolean;
}

export type ErrorCode =
  | 'bad-name' // not 3-12 letters, digits or underscores
  | 'name-taken'
  | 'room-full'
  | 'not-host'
  | 'not-enough-players'
  | 'not-joined'
  | 'already-joined'
  | 'wrong-phase';

/** One player in a snapshot. Numbers are rounded to keep messages small. */
export interface PlayerSnap {
  id: string;
  x: number;
  y: number;
  lives: number;
  alive: boolean;
  present: boolean;
  /** Invulnerability left, ms. */
  inv: number;
  energy: number;
  orbs: number;
  deaths: number;
  /** [active, cooldown] ms for each ability in ABILITY_ORDER, flattened (8 numbers). */
  ab: number[];
}

export interface DrifterSnap {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: DrifterKind;
  /** Warning (marker) time left, ms. */
  w: number;
}

export interface OrbSnap {
  x: number;
  y: number;
  ttl: number;
}

/** Things that happened since the previous snapshot, so the client can play effects. Empty lists are left out. */
export interface EventsSnap {
  pickups?: { p: string; x: number; y: number }[];
  hits?: string[];
  blocks?: string[];
  deaths?: string[];
  respawns?: string[];
  bumps?: [string, string][];
  wallHits?: { x: number; y: number }[];
  abilities?: { p: string; id: AbilityId; from: { x: number; y: number }; to: { x: number; y: number } }[];
}

export interface Snapshot {
  t: 'snap';
  tick: number;
  /** Match time in ms. */
  timeMs: number;
  sector: number;
  players: PlayerSnap[];
  drifters: DrifterSnap[];
  orbs: OrbSnap[];
  /** Walls still showing as outlines: [index into walls, ms left]. Left out when there are none. */
  warn?: [number, number][];
  ev?: EventsSnap;
}

export type ServerMessage =
  /** Sent once after a successful join. */
  | { t: 'welcome'; playerId: string; code: string; spectating: boolean }
  /** The room as it is now. Sent whenever anything about it changes. */
  | {
      t: 'room';
      phase: RoomPhase;
      players: RoomMember[];
      /** Names of people waiting for the next match. */
      waiting: string[];
      hostId: string | null;
      minPlayers: number;
      maxPlayers: number;
      /** Only during the countdown. */
      countdownMs?: number;
    }
  /** The match begins. Players are in the order of their colours. */
  | { t: 'start'; players: RoomMember[]; durationMs: number; timeMs: number }
  /** The maze walls. Sent at the start and whenever a new maze appears. */
  | { t: 'maze'; sector: number; maze: Maze; walls: Barrier[] }
  | Snapshot
  | { t: 'ability'; id: AbilityId; ok: boolean; reason?: string }
  | { t: 'results'; ranking: RankEntry[] }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: ErrorCode; message: string };

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
