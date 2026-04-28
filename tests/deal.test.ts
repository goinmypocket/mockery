import { describe, expect, it } from "vitest";
import { buildDeck, deal, finalCardTuple } from "../engine/deal";
import { createInitialState } from "../engine/state";
import { asUserId } from "../shared/ids";
import type { ResolvedOptions } from "../shared/types";

function mkState(seed: number) {
  const opts: ResolvedOptions = {
    cardValues: [1, 2, 9, 10],
    copiesPerValue: 4,
    informedSeats: 6,
    uninformedSeats: 0,
    publicSlots: 3,
    eventMode: "auto",
    eventIntervalMin: 1,
    eventIntervalMax: 1,
    endGameGraceSec: 0,
    seed,
    codeMode: "alpha",
    enforceCaseByRole: false,
    identityReveal: "all",
    identityRevealList: [],
  };
  return createInitialState({
    options: opts,
    hostUserId: asUserId("host"),
    seats: new Array(6).fill(asUserId("u")),
    now: 0,
  });
}

describe("deal", () => {
  it("builds a deck with cardValues × copiesPerValue", () => {
    const s = mkState(1);
    const deck = buildDeck(s);
    expect(deck).toHaveLength(16);
    expect(deck.filter((v) => v === 1)).toHaveLength(4);
    expect(deck.filter((v) => v === 2)).toHaveLength(4);
    expect(deck.filter((v) => v === 9)).toHaveLength(4);
    expect(deck.filter((v) => v === 10)).toHaveLength(4);
  });

  it("deals deterministically given a seed", () => {
    const s1 = mkState(42);
    const s2 = mkState(42);
    deal(s1);
    deal(s2);
    expect(s1.informedCards).toEqual(s2.informedCards);
    expect(s1.publicCards).toEqual(s2.publicCards);
  });

  it("different seeds produce different deals (with overwhelming probability)", () => {
    const s1 = mkState(1);
    const s2 = mkState(2);
    deal(s1);
    deal(s2);
    expect(
      s1.informedCards.join(",") + "|" + s1.publicCards.join(","),
    ).not.toEqual(
      s2.informedCards.join(",") + "|" + s2.publicCards.join(","),
    );
  });

  it("informedCards and publicCards are within the deck values", () => {
    const s = mkState(7);
    deal(s);
    const allowed = new Set([1, 2, 9, 10]);
    for (const c of s.informedCards) expect(allowed.has(c)).toBe(true);
    for (const c of s.publicCards) expect(allowed.has(c)).toBe(true);
  });

  it("finalCardTuple is informedCards followed by publicCards", () => {
    const s = mkState(3);
    deal(s);
    const tup = finalCardTuple(s);
    expect(tup.length).toBe(s.informedCards.length + s.publicCards.length);
    expect(tup.slice(0, 6)).toEqual(s.informedCards);
    expect(tup.slice(6)).toEqual(s.publicCards);
  });

  it("throws when the deck is too small", () => {
    const s = mkState(1);
    s.options = { ...s.options, informedSeats: 100 };
    expect(() => deal(s)).toThrow();
  });
});
