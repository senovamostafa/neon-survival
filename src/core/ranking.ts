import type { GameState, RankEntry } from './types';

/**
 * The final standings: most orbs wins. If orbs are equal, whoever reached that count
 * first ranks higher. If that is also equal, the player who joined the match first does.
 * Every player gets a different rank. Players who disconnected keep their place.
 */
export function rankPlayers(state: GameState): RankEntry[] {
  const rows = state.players.map((p, joinOrder) => ({ p, joinOrder }));
  rows.sort((a, b) => {
    if (b.p.orbs !== a.p.orbs) return b.p.orbs - a.p.orbs;
    const timeA = a.p.lastOrbAtMs ?? Infinity;
    const timeB = b.p.lastOrbAtMs ?? Infinity;
    if (timeA !== timeB) return timeA - timeB;
    return a.joinOrder - b.joinOrder;
  });
  return rows.map(({ p }, i) => ({
    rank: i + 1,
    playerId: p.id,
    name: p.name,
    orbs: p.orbs,
    deaths: p.deaths,
    reachedAtMs: p.lastOrbAtMs,
  }));
}
