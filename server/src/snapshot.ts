import type { AbilityId, GameState, StepResult } from '../../src/core/types';
import { ABILITY_ORDER, type EventsSnap, type PlayerSnap, type Snapshot } from '../../src/net/protocol';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Collects what happened in each simulation step so the next snapshot can tell the clients
 * (they use it for sparks, shakes and sounds). take() hands over the list and starts a new one.
 */
export class EventLog {
  private events: EventsSnap = {};

  addStep(result: StepResult): void {
    const e = this.events;
    for (const p of result.pickups) (e.pickups ??= []).push({ p: p.playerId, x: round1(p.x), y: round1(p.y) });
    for (const h of result.hits) (e.hits ??= []).push(h.playerId);
    for (const b of result.shieldBlocks) (e.blocks ??= []).push(b.playerId);
    for (const d of result.deaths) (e.deaths ??= []).push(d.playerId);
    for (const r of result.respawns) (e.respawns ??= []).push(r.playerId);
    for (const b of result.bumps) (e.bumps ??= []).push([b.a, b.b]);
    for (const w of result.wallHits) (e.wallHits ??= []).push({ x: round1(w.x), y: round1(w.y) });
  }

  addAbility(playerId: string, id: AbilityId, from: { x: number; y: number }, to: { x: number; y: number }): void {
    (this.events.abilities ??= []).push({
      p: playerId,
      id,
      from: { x: round1(from.x), y: round1(from.y) },
      to: { x: round1(to.x), y: round1(to.y) },
    });
  }

  /** Returns everything collected so far (or undefined if nothing happened) and starts afresh. */
  take(): EventsSnap | undefined {
    const events = this.events;
    this.events = {};
    return Object.keys(events).length > 0 ? events : undefined;
  }
}

/** The compact picture of the match that is sent to every client about 20 times a second. */
export function buildSnapshot(state: GameState, tick: number, ev: EventsSnap | undefined): Snapshot {
  const players: PlayerSnap[] = state.players.map((p) => ({
    id: p.id,
    x: round1(p.x),
    y: round1(p.y),
    lives: p.lives,
    alive: p.alive,
    present: p.present,
    inv: Math.round(p.invulnerableMs),
    energy: p.energy,
    orbs: p.orbs,
    deaths: p.deaths,
    ab: ABILITY_ORDER.flatMap((id) => [
      Math.round(p.abilities[id].activeMs),
      Math.round(p.abilities[id].cooldownMs),
    ]),
  }));

  const warn: [number, number][] = [];
  state.barriers.forEach((b, i) => {
    if (b.warningMs > 0) warn.push([i, Math.round(b.warningMs)]);
  });

  const snapshot: Snapshot = {
    t: 'snap',
    tick,
    timeMs: Math.round(state.timeMs),
    sector: state.sector,
    players,
    drifters: state.drifters.map((d) => ({
      x: round1(d.x),
      y: round1(d.y),
      vx: round1(d.vx),
      vy: round1(d.vy),
      kind: d.kind,
      w: Math.round(d.warningMs),
    })),
    orbs: state.orbs.map((o) => ({ x: round1(o.x), y: round1(o.y), ttl: Math.round(o.ttlMs) })),
  };
  if (warn.length > 0) snapshot.warn = warn;
  if (ev) snapshot.ev = ev;
  return snapshot;
}
