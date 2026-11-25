import { CONFIG } from '../core/config';
import type { Rng } from '../core/rng';
import type { AbilityId, DrifterKind, GameState, Player, StepResult } from '../core/types';
import { ABILITY_ORDER, type EventsSnap, type PlayerSnap } from '../net/protocol';
import type { Sample } from './interpolation';
import type { OnlineSession } from './session';

/**
 * Turns what the server told us into a GameState, so the arena can be drawn by the very same
 * drawing code as the local game. The result is a picture only: nothing steps it forward.
 */

const ZERO_ABILITY = { activeMs: 0, cooldownMs: 0 };

function abilitiesOf(ab: number[]): Player['abilities'] {
  const out = {} as Player['abilities'];
  ABILITY_ORDER.forEach((id: AbilityId, i) => {
    out[id] = { activeMs: ab[i * 2] ?? 0, cooldownMs: ab[i * 2 + 1] ?? 0 };
  });
  return out;
}

function playerFrom(snap: PlayerSnap, session: OnlineSession, sample: Sample): Player {
  const member = session.matchPlayers.find((m) => m.id === snap.id);
  const down = session.downSince.get(snap.id);
  return {
    id: snap.id,
    name: member?.name ?? snap.id,
    colorIndex: member?.colorIndex ?? 0,
    x: snap.x,
    y: snap.y,
    radius: CONFIG.player.radius,
    lives: snap.lives,
    invulnerableMs: snap.inv,
    alive: snap.alive,
    respawnMs:
      snap.alive || down === undefined
        ? 0
        : Math.max(0, CONFIG.player.respawn.freezeMs - (sample.newest.snap.timeMs - down)),
    deaths: snap.deaths,
    energy: snap.energy,
    orbs: snap.orbs,
    lastOrbAtMs: session.lastOrbAt.get(snap.id) ?? null,
    abilities: snap.ab.length >= 8 ? abilitiesOf(snap.ab) : { shield: ZERO_ABILITY, slow: ZERO_ABILITY, teleport: ZERO_ABILITY, magnet: ZERO_ABILITY },
    bumpVx: 0,
    bumpVy: 0,
    bumpMs: 0,
    connected: true,
    awayMs: 0,
    present: snap.present,
  };
}

/** The match as it should be drawn right now. With no snapshot yet it is an empty arena. */
export function buildViewState(session: OnlineSession, sample: Sample | null): GameState {
  const phase = session.room?.phase;
  const snap = sample?.newest.snap;
  return {
    status: phase === 'playing' ? 'playing' : phase === 'results' ? 'finished' : 'ready',
    timeMs: snap?.timeMs ?? 0,
    players: sample ? sample.players.map((p) => playerFrom(p, session, sample)) : [],
    drifters: (sample?.drifters ?? []).map((d) => ({
      x: d.x,
      y: d.y,
      vx: d.vx,
      vy: d.vy,
      radius: CONFIG.drifters.types[d.kind as DrifterKind].radius,
      kind: d.kind,
      warningMs: d.w,
    })),
    orbs: (snap?.orbs ?? []).map((o) => ({ x: o.x, y: o.y, radius: CONFIG.orbs.radius, ttlMs: o.ttl })),
    maze: session.maze ?? { cols: 0, rows: 0, cells: [] },
    barriers: session.currentWalls(),
    sector: snap?.sector ?? 0,
    spawn: { drifterMs: 0, orbMs: 0 },
    bumpCooldowns: {},
    seed: 0,
    // Nothing in the view ever rolls dice: the server decides everything random.
    rng: null as unknown as Rng,
  };
}

/** Reshapes the effects list of a snapshot into the form the drawing code already understands. */
export function eventsToStepResult(ev: EventsSnap, knownPlayers: ReadonlySet<string>): StepResult {
  const known = (id: string): boolean => knownPlayers.has(id);
  return {
    hits: (ev.hits ?? []).filter(known).map((playerId) => ({ playerId })),
    shieldBlocks: (ev.blocks ?? []).filter(known).map((playerId) => ({ playerId })),
    pickups: (ev.pickups ?? []).filter((p) => known(p.p)).map((p) => ({ playerId: p.p, x: p.x, y: p.y })),
    deaths: (ev.deaths ?? []).filter(known).map((playerId) => ({ playerId })),
    respawns: (ev.respawns ?? []).filter(known).map((playerId) => ({ playerId })),
    bumps: (ev.bumps ?? []).filter(([a, b]) => known(a) && known(b)).map(([a, b]) => ({ a, b })),
    wallHits: ev.wallHits ?? [],
    finished: false,
  };
}
