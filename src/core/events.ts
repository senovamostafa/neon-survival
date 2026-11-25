import type { Config } from './config';
import type { Rect } from './collision';
import type { Rng } from './rng';
import type { EventKind, GameState, GravityDirection } from './types';

/**
 * Random arena events: gravity shift, blackout and shrinking arena.
 *
 * Only one event exists at a time. Each one first announces itself (phase 'warning',
 * nothing changes yet), then takes effect (phase 'active'), then the game goes quiet
 * for a random while before the next warning. No event ever repeats back to back.
 */

const KINDS: EventKind[] = ['gravity', 'blackout', 'shrink'];
const DIRECTIONS: GravityDirection[] = ['up', 'down', 'left', 'right'];

/** Unit vector for each gravity direction (screen coordinates: y grows downward). */
export const GRAVITY_VECTORS: Record<GravityDirection, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** How long the first event waits at the start of a run. */
export function firstEventDelay(rng: Rng, cfg: Config): number {
  return rng.range(...cfg.events.firstDelayMs);
}

function activeDuration(kind: EventKind, cfg: Config): number {
  return cfg.events[kind].durationMs;
}

/** Counts down to the next event, and moves the running event through warning -> active -> done. */
export function updateEvent(state: GameState, dtMs: number, cfg: Config): void {
  const { rng } = state;

  if (!state.event) {
    state.nextEventMs -= dtMs;
    if (state.nextEventMs > 0) return;

    const choices = KINDS.filter((k) => k !== state.lastEventKind);
    const kind = choices[rng.int(0, choices.length - 1)];
    state.event = {
      kind,
      phase: 'warning',
      msLeft: cfg.events.warningMs,
      totalMs: cfg.events.warningMs,
      direction: kind === 'gravity' ? DIRECTIONS[rng.int(0, DIRECTIONS.length - 1)] : undefined,
    };
    return;
  }

  const event = state.event;
  event.msLeft -= dtMs;
  if (event.msLeft > 0) return;

  if (event.phase === 'warning') {
    event.phase = 'active';
    event.totalMs = activeDuration(event.kind, cfg);
    event.msLeft = event.totalMs;
  } else {
    state.lastEventKind = event.kind;
    state.event = null;
    state.nextEventMs = rng.range(...cfg.events.intervalMs);
  }
}

/** The constant push the player feels right now (px per second), or zero. */
export function gravityPush(state: GameState, cfg: Config): { x: number; y: number } {
  const event = state.event;
  if (!event || event.kind !== 'gravity' || event.phase !== 'active' || !event.direction) {
    return { x: 0, y: 0 };
  }
  const v = GRAVITY_VECTORS[event.direction];
  return { x: v.x * cfg.events.gravity.force, y: v.y * cfg.events.gravity.force };
}

/** The arena with every side moved inwards by `progress` (0 = full arena, 1 = smallest allowed). */
export function insetArena(cfg: Config, progress: number): Rect {
  const { arena, events } = cfg;
  const shrinkBy = (1 - events.shrink.minFraction) / 2;
  const insetX = arena.width * shrinkBy * progress;
  const insetY = arena.height * shrinkBy * progress;
  return {
    x: arena.x + insetX,
    y: arena.y + insetY,
    width: arena.width - insetX * 2,
    height: arena.height - insetY * 2,
  };
}

/** The playable area for the current moment. Only a running shrink event changes it. */
export function computeBounds(state: GameState, cfg: Config): Rect {
  const event = state.event;
  if (!event || event.kind !== 'shrink' || event.phase !== 'active') return insetArena(cfg, 0);

  const { shrinkMs, restoreMs } = cfg.events.shrink;
  const elapsed = event.totalMs - event.msLeft;
  let progress: number;
  if (elapsed < shrinkMs) progress = elapsed / shrinkMs; // closing in
  else if (event.msLeft > restoreMs) progress = 1; // holding at the smallest size
  else progress = event.msLeft / restoreMs; // opening back up
  return insetArena(cfg, Math.min(1, Math.max(0, progress)));
}

/** True while an event is changing the rules (not just warning about it). */
export function isEventActive(state: GameState, kind: EventKind): boolean {
  return state.event?.kind === kind && state.event.phase === 'active';
}
