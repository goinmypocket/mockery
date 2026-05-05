import { describe, expect, it } from "vitest";
import { rotateInformed, revealPublic } from "../engine/events";
import { createInitialState, type GameState } from "../engine/state";
import { asUserId } from "../shared/ids";
import type { ResolvedOptions } from "../shared/types";

function mkState(args: { informedSeats: number; publicSlots: number }): GameState {
  const opts: ResolvedOptions = {
    cardValues: [1, 2, 3, 4],
    copiesPerValue: 4,
    informedSeats: args.informedSeats,
    uninformedSeats: 0,
    publicSlots: args.publicSlots,
    eventMode: "auto",
    eventIntervalMin: 1,
    eventIntervalMax: 1,
    endGameGraceSec: 0,
    seed: 1,
    codeMode: "alpha",
    enforceCaseByRole: false,
    identityReveal: "all",
    identityRevealList: [],
  };
  const s = createInitialState({
    options: opts,
    hostUserId: asUserId("host"),
    seats: new Array(args.informedSeats).fill(asUserId("u")),
    now: 0,
  });
  s.status = "playing";
  s.informedCards = new Array(args.informedSeats).fill(0).map((_, i) => i + 1);
  s.informedCardOrigin = new Array(args.informedSeats).fill(0).map((_, i) => i);
  s.publicCards = new Array(args.publicSlots).fill(0).map((_, i) => 100 + i);
  s.publicRevealed = new Array(args.publicSlots).fill(false);
  return s;
}

describe("events", () => {
  it("rotateInformed passes each card to the next seat", () => {
    const s = mkState({ informedSeats: 4, publicSlots: 0 });
    expect(s.informedCards).toEqual([1, 2, 3, 4]);
    expect(s.informedCardOrigin).toEqual([0, 1, 2, 3]);
    rotateInformed(s);
    expect(s.informedCards).toEqual([4, 1, 2, 3]);   // each card shifted right
    expect(s.informedCardOrigin).toEqual([3, 0, 1, 2]); // origin shifts the same way
    expect(s.phase).toBe(1);
  });

  it("rotateInformed wraps around", () => {
    const s = mkState({ informedSeats: 3, publicSlots: 0 });
    s.informedCards = [10, 20, 30];
    s.informedCardOrigin = [0, 1, 2];
    rotateInformed(s);
    rotateInformed(s);
    rotateInformed(s);
    expect(s.informedCards).toEqual([10, 20, 30]);
    expect(s.informedCardOrigin).toEqual([0, 1, 2]);
    expect(s.phase).toBe(3);
  });

  it("rotateInformed keeps each card paired with its original seat", () => {
    const s = mkState({ informedSeats: 4, publicSlots: 0 });
    // After every rotation, value-and-origin travel together: at seat
    // i the value originally dealt to seat informedCardOrigin[i].
    const dealt = s.informedCards.slice();
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < s.informedCards.length; i++) {
        expect(s.informedCards[i]).toBe(dealt[s.informedCardOrigin[i]!]!);
      }
      rotateInformed(s);
    }
  });

  it("revealPublic with null picks lowest still-hidden slot", () => {
    const s = mkState({ informedSeats: 0, publicSlots: 3 });
    const e1 = revealPublic(s, null);
    expect(e1).toEqual({ type: "REVEALED", slotIndex: 0, value: 100 });
    expect(s.publicRevealed).toEqual([true, false, false]);
    const e2 = revealPublic(s, null);
    expect(e2).toEqual({ type: "REVEALED", slotIndex: 1, value: 101 });
  });

  it("revealPublic with a specific slot reveals it", () => {
    const s = mkState({ informedSeats: 0, publicSlots: 4 });
    const e = revealPublic(s, 2);
    expect(e).toEqual({ type: "REVEALED", slotIndex: 2, value: 102 });
    expect(s.publicRevealed).toEqual([false, false, true, false]);
  });

  it("revealPublic throws if slot already revealed", () => {
    const s = mkState({ informedSeats: 0, publicSlots: 2 });
    revealPublic(s, 0);
    expect(() => revealPublic(s, 0)).toThrow();
  });
});
