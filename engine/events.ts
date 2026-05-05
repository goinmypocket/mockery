// =============================================================================
// Event handlers — rotate informed seats, reveal a public slot.
//
// Both functions mutate state in place (deck of one in-place op per event).
// =============================================================================

import type { GameEvent } from "../shared/types";
import type { GameState } from "./state";

/** Rotate informed cards: each informed seat passes its card to the
 *  next informed seat (rightward). Seats are 0..informedSeats-1; the
 *  rotation is purely within that range, leaving uninformed seats
 *  untouched.
 *
 *  Pass right means seat i's card goes to seat (i+1) mod N.
 *
 *  `informedCardOrigin` rotates in lockstep so each card remembers
 *  which seat originally held it — the UI displays each card under
 *  its original-holder's banner, so a card a player is dealt stays
 *  attached to *their* name even after rotations move the value to
 *  another seat.
 */
export function rotateInformed(state: GameState): GameEvent {
  const n = state.options.informedSeats;
  if (n < 2) {
    // No-op for a 1-informed game; spec says "to the right" is undefined
    // with one player. Still increments phase and emits a ROTATED event.
    state.phase++;
    return { type: "ROTATED" };
  }
  const cards = state.informedCards.slice(0, n);
  const origins = state.informedCardOrigin.slice(0, n);
  const rotatedCards = new Array<number>(n);
  const rotatedOrigins = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    rotatedCards[(i + 1) % n] = cards[i]!;
    rotatedOrigins[(i + 1) % n] = origins[i]!;
  }
  for (let i = 0; i < n; i++) {
    state.informedCards[i] = rotatedCards[i]!;
    state.informedCardOrigin[i] = rotatedOrigins[i]!;
  }
  state.phase++;
  return { type: "ROTATED" };
}

/** Reveal the public slot at `slotIndex`. If `slotIndex` is null,
 *  picks the lowest-indexed still-hidden slot. Throws if no hidden
 *  slot exists (caller should have removed the queue entry first).
 */
export function revealPublic(
  state: GameState,
  slotIndex: number | null,
): GameEvent {
  let idx: number;
  if (slotIndex === null) {
    idx = state.publicRevealed.findIndex((r) => !r);
    if (idx < 0) throw new Error("no hidden public slot to reveal");
  } else {
    if (slotIndex < 0 || slotIndex >= state.publicRevealed.length) {
      throw new Error(`reveal: slot ${slotIndex} out of range`);
    }
    if (state.publicRevealed[slotIndex]) {
      throw new Error(`reveal: slot ${slotIndex} already revealed`);
    }
    idx = slotIndex;
  }
  state.publicRevealed[idx] = true;
  state.phase++;
  return { type: "REVEALED", slotIndex: idx, value: state.publicCards[idx]! };
}

/** Reveal every still-hidden public slot atomically. Used at game end.
 *  Does NOT increment phase (settlement is a non-event transition). */
export function revealAllRemaining(state: GameState): readonly GameEvent[] {
  const out: GameEvent[] = [];
  for (let i = 0; i < state.publicRevealed.length; i++) {
    if (!state.publicRevealed[i]) {
      state.publicRevealed[i] = true;
      out.push({ type: "REVEALED", slotIndex: i, value: state.publicCards[i]! });
    }
  }
  return out;
}
