import { CONFIG, type Config } from './config';
import { cellCenter, cellOf, pathToNearest } from './maze';
import { isActive, findPlayer } from './roster';
import type { AbilityId, GameState, InputState } from './types';

/**
 * Simple computer-controlled players. They follow the corridors by the shortest route to the
 * nearest orb, steer away from enemies, and spend energy sensibly. They are used to try the
 * game locally, in tests, and later to load-test the server. They are deterministic: the same
 * state always gives the same decision.
 */

const IDLE: InputState = { dx: 0, dy: 0 };

/** Which way should this bot move this step? */
export function botInput(state: GameState, botId: string, cfg: Config = CONFIG): InputState {
  const bot = findPlayer(state, botId);
  if (!bot || !isActive(bot)) return IDLE;

  // Steering vector: follow the maze towards an orb, plus repulsion from enemies.
  let vx = 0;
  let vy = 0;

  const here = cellOf(cfg, bot.x, bot.y);
  const hereCenter = cellCenter(cfg, here.col, here.row);
  const orbCells = state.orbs.map((o) => cellOf(cfg, o.x, o.y));
  const route = pathToNearest(state.maze, here, orbCells);

  if (route && route.length === 0) {
    // The orb is in this very cell: go straight for the nearest one here.
    let best = state.orbs[0];
    let bestDist = Infinity;
    for (const o of state.orbs) {
      const c = cellOf(cfg, o.x, o.y);
      if (c.col !== here.col || c.row !== here.row) continue;
      const d = Math.hypot(o.x - bot.x, o.y - bot.y);
      if (d < bestDist) {
        best = o;
        bestDist = d;
      }
    }
    const d = bestDist || 1;
    vx += (best.x - bot.x) / d;
    vy += (best.y - bot.y) / d;
  } else {
    // Head for the next cell on the route (or the middle of the maze if there is no orb),
    // staying on the centre line of the corridor so we do not scrape the walls.
    const goalCell = route ? route.next : cellOf(cfg, cfg.arena.x + cfg.arena.width / 2, cfg.arena.y + cfg.arena.height / 2);
    const dc = goalCell.col - here.col;
    const dr = goalCell.row - here.row;
    const lean = (offset: number): number => Math.max(-1, Math.min(1, offset / 14));
    if (dc !== 0 || dr !== 0) {
      vx += dc;
      vy += dr;
      if (dc !== 0) vy += lean(hereCenter.y - bot.y);
      else vx += lean(hereCenter.x - bot.x);
    } else {
      // Waiting in the middle of the maze.
      vx += lean(hereCenter.x - bot.x) * 0.5;
      vy += lean(hereCenter.y - bot.y) * 0.5;
    }
  }

  for (const d of state.drifters) {
    // Look a little ahead along the enemy's path.
    const lead = d.warningMs > 0 ? 0 : 0.35;
    const fx = d.x + d.vx * lead;
    const fy = d.y + d.vy * lead;
    const dist = Math.hypot(bot.x - fx, bot.y - fy) || 1;
    const danger = d.radius + bot.radius + 55;
    if (dist < danger) {
      const w = ((danger - dist) / danger) * 3.2;
      vx += ((bot.x - fx) / dist) * w;
      vy += ((bot.y - fy) / dist) * w;
    }
  }

  const length = Math.hypot(vx, vy);
  if (length < 0.15) return IDLE;
  const nx = vx / length;
  const ny = vy / length;
  return { dx: Math.abs(nx) > 0.38 ? Math.sign(nx) : 0, dy: Math.abs(ny) > 0.38 ? Math.sign(ny) : 0 };
}

/** Which ability (if any) does this bot want to try right now? */
export function botAbility(state: GameState, botId: string, cfg: Config = CONFIG): AbilityId | null {
  const bot = findPlayer(state, botId);
  if (!bot || !isActive(bot)) return null;
  const a = cfg.abilities;
  const ready = (id: AbilityId, extraEnergy = 0): boolean =>
    bot.abilities[id].activeMs <= 0 &&
    bot.abilities[id].cooldownMs <= 0 &&
    bot.energy >= a[id].cost + extraEnergy;

  const threatened = state.drifters.some(
    (d) =>
      d.warningMs <= 0 &&
      Math.hypot(bot.x - (d.x + d.vx * 0.25), bot.y - (d.y + d.vy * 0.25)) < d.radius + bot.radius + 28,
  );

  if (threatened && ready('shield')) return 'shield';
  if (threatened && bot.abilities.shield.activeMs <= 0 && ready('teleport')) return 'teleport';

  const crowded = state.drifters.filter(
    (d) => Math.hypot(bot.x - d.x, bot.y - d.y) <= a.slow.radius,
  ).length;
  if (crowded >= 2 && ready('slow', 20)) return 'slow';

  const nearbyOrbs = state.orbs.filter(
    (o) => Math.hypot(bot.x - o.x, bot.y - o.y) < a.magnet.radius,
  ).length;
  if (nearbyOrbs >= 2 && ready('magnet', 30)) return 'magnet';

  return null;
}
