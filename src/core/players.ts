import type { Config } from './config';
import type { Rng } from './rng';
import { activePlayers } from './roster';
import { findRespawnSpot } from './spawn';
import type { AbilityId, GameState, Player, StepResult } from './types';

/** Who is playing: an id that never changes (used by the server) and a display name. */
export interface RosterEntry {
  id: string;
  name: string;
}

/** Hero colours available (the renderer picks the actual colours). */
export const HERO_COLORS = 10;

const ABILITY_IDS: AbilityId[] = ['shield', 'slow', 'teleport', 'magnet'];

function idleAbilities(): Player['abilities'] {
  const idle = () => ({ activeMs: 0, cooldownMs: 0 });
  return { shield: idle(), slow: idle(), teleport: idle(), magnet: idle() };
}

/** Evenly spaced start spots on an ellipse around the centre, so nobody starts on top of anyone. */
export function spawnPositions(count: number, rng: Rng, cfg: Config): { x: number; y: number }[] {
  const { arena, match } = cfg;
  const cx = arena.x + arena.width / 2;
  const cy = arena.y + arena.height / 2;
  const rx = arena.width * match.spawnRingFraction;
  const ry = arena.height * match.spawnRingFraction;
  const start = rng.range(0, Math.PI * 2);
  return Array.from({ length: count }, (_, i) => {
    const angle = start + (i / Math.max(1, count)) * Math.PI * 2;
    // A single player starts in the middle, which is what the solo test mode wants.
    return count === 1 ? { x: cx, y: cy } : { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}

export function createPlayer(
  entry: RosterEntry,
  index: number,
  position: { x: number; y: number },
  cfg: Config,
): Player {
  return {
    id: entry.id,
    name: entry.name,
    colorIndex: index % HERO_COLORS,
    x: position.x,
    y: position.y,
    radius: cfg.player.radius,
    lives: cfg.player.lives,
    invulnerableMs: 0,
    alive: true,
    respawnMs: 0,
    deaths: 0,
    energy: 0,
    orbs: 0,
    lastOrbAtMs: null,
    abilities: idleAbilities(),
    bumpVx: 0,
    bumpVy: 0,
    bumpMs: 0,
    connected: true,
    awayMs: 0,
    present: true,
  };
}

/** A player lost their last life: frozen for a while, energy and abilities lost. Orbs stay. */
export function killPlayer(player: Player, cfg: Config): void {
  player.lives = 0;
  player.alive = false;
  player.respawnMs = cfg.player.respawn.freezeMs;
  player.deaths++;
  player.energy = 0;
  player.abilities = idleAbilities();
  player.bumpMs = 0;
}

/** Brings a frozen player back at a safe spot with the respawn lives and a short protection. */
export function respawnPlayer(state: GameState, player: Player, cfg: Config): void {
  const spot = findRespawnSpot(state, player, cfg);
  player.x = spot.x;
  player.y = spot.y;
  player.alive = true;
  player.respawnMs = 0;
  player.lives = cfg.player.respawn.lives;
  player.invulnerableMs = cfg.player.respawn.invulnerableMs;
  player.energy = 0;
  player.abilities = idleAbilities();
  player.bumpMs = 0;
}

/**
 * Marks a player as connected or disconnected. A disconnected hero stays for a short
 * while (then disappears, keeping its orbs). Reconnecting before that changes nothing;
 * reconnecting after it brings the hero back at a safe spot.
 */
export function setConnected(state: GameState, playerId: string, connected: boolean, cfg: Config): void {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return;
  player.connected = connected;
  if (!connected) return;

  player.awayMs = 0;
  if (!player.present) {
    player.present = true;
    if (state.status === 'playing') respawnPlayer(state, player, cfg);
  }
}

/**
 * Players who touch are shoved straight apart. Harmless; walls and the arena edge still
 * stop the shove. The same two players cannot bump again until their cooldown ends.
 */
export function applyBumps(state: GameState, cfg: Config, result: StepResult): void {
  const players = activePlayers(state);
  const speed = cfg.bump.distance / (cfg.bump.durationMs / 1000);

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= a.radius + b.radius) continue;

      const key = `${a.id}|${b.id}`;
      if ((state.bumpCooldowns[key] ?? 0) > 0) continue;

      // Exactly on top of each other has no "away" direction, so pick one.
      let ux: number;
      let uy: number;
      if (dist < 1e-6) {
        const angle = state.rng.range(0, Math.PI * 2);
        ux = Math.cos(angle);
        uy = Math.sin(angle);
      } else {
        ux = dx / dist;
        uy = dy / dist;
      }

      a.bumpVx = ux * speed;
      a.bumpVy = uy * speed;
      b.bumpVx = -ux * speed;
      b.bumpVy = -uy * speed;
      a.bumpMs = cfg.bump.durationMs;
      b.bumpMs = cfg.bump.durationMs;
      state.bumpCooldowns[key] = cfg.bump.cooldownMs;
      result.bumps.push({ a: a.id, b: b.id });
    }
  }
}

export { ABILITY_IDS };
