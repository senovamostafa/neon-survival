import { CONFIG, type Config } from './config';
import { findTeleportSpot } from './spawn';
import type { AbilityId, AbilityResult, GameState } from './types';

/**
 * Tries to use an ability. Nothing changes (and no energy is spent) unless it succeeds.
 *
 * Shield, slow and magnet start a timer that stepGame() counts down and applies.
 * Teleport is instant: it moves the player straight away.
 */
export function activateAbility(state: GameState, id: AbilityId, cfg: Config = CONFIG): AbilityResult {
  if (state.status !== 'playing') return { ok: false, reason: 'not-playing' };

  const ability = state.abilities[id];
  const spec = cfg.abilities[id];
  const { player } = state;

  if (ability.activeMs > 0) return { ok: false, reason: 'active' };
  if (ability.cooldownMs > 0) return { ok: false, reason: 'cooldown' };
  if (state.energy < spec.cost) return { ok: false, reason: 'no-energy' };

  const from = { x: player.x, y: player.y };

  if (id === 'teleport') {
    const to = findTeleportSpot(state, cfg);
    if (!to) return { ok: false, reason: 'no-safe-spot' };
    player.x = to.x;
    player.y = to.y;
  } else {
    ability.activeMs = cfg.abilities[id].durationMs;
  }

  state.energy -= spec.cost;
  ability.cooldownMs = spec.cooldownMs;
  return { ok: true, from, to: { x: player.x, y: player.y } };
}
