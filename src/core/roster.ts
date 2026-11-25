import type { GameState, Player } from './types';

/** Who is actually in the arena? Small helpers shared by the rules. */

/** In the arena and able to act: connected (or only briefly away) and not frozen. */
export function isActive(p: Player): boolean {
  return p.present && p.alive;
}

export function activePlayers(state: GameState): Player[] {
  return state.players.filter(isActive);
}

/** Everyone whose hero still exists, including players who are frozen after dying. */
export function presentPlayers(state: GameState): Player[] {
  return state.players.filter((p) => p.present);
}

export function findPlayer(state: GameState, id: string): Player | undefined {
  return state.players.find((p) => p.id === id);
}
