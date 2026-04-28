// =============================================================================
// Deck & deal. Builds the deck from cardValues × copiesPerValue, shuffles
// via the seeded RNG, then deals into informed seats and public slots.
// =============================================================================

import type { GameState } from "./state";
import { shuffle } from "./rng";

export function buildDeck(state: GameState): number[] {
  const out: number[] = [];
  for (const v of state.options.cardValues) {
    for (let i = 0; i < state.options.copiesPerValue; i++) out.push(v);
  }
  return out;
}

export function deal(state: GameState): void {
  const deck = shuffle(buildDeck(state), state.rng);
  const need = state.options.informedSeats + state.options.publicSlots;
  if (deck.length < need) {
    throw new Error(`deck (${deck.length}) too small for ${need} cards in play`);
  }

  state.informedCards = new Array<number>(state.options.informedSeats);
  for (let i = 0; i < state.options.informedSeats; i++) {
    state.informedCards[i] = deck[i]!;
  }
  state.publicCards = new Array<number>(state.options.publicSlots);
  state.publicRevealed = new Array<boolean>(state.options.publicSlots).fill(false);
  for (let i = 0; i < state.options.publicSlots; i++) {
    state.publicCards[i] = deck[state.options.informedSeats + i]!;
  }
}

/** Final cards array passed into payoff: informed seats first (in seat
 *  order), then public slots (in slot order). At game end all values
 *  must be revealed. */
export function finalCardTuple(state: GameState): number[] {
  return [...state.informedCards, ...state.publicCards];
}
