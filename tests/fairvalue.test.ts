// =============================================================================
// Fair-value helpers — weightedMid + EMA primitives. Time/volume EMA
// integration tests live in botOrchestrator.test.ts (they need a real
// session + clock to exercise the 1-second ticker).
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  contractPrior,
  decayForHalfLife,
  emaDecay,
  emaObserve,
  emaStep,
  emaValue,
  newEma,
  weightedMid,
} from "../server/bots/helpers/fairvalue";
import type { BookSnapshot, MarketSnapshot } from "../server/bots/api";
import { asContractId } from "../shared/ids";

const CID = asContractId("c1");

function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    ts: 0, phase: 0, status: "playing", myCode: "ME",
    cardValues: [1, 2, 3, 4], copiesPerValue: 2,
    publicCards: [null],
    contracts: [{ id: CID, name: "Sum", description: "",
      payoffSource: "return H.sum(cards);", payoffHash: "" }],
    participants: [
      { code: "AA", role: "informed", displayName: null },
      { code: "BB", role: "informed", displayName: null },
    ],
    eventQueue: [], eventMode: "manual", msUntilNextEvent: null,
    books: {}, recentTrades: [],
    myPositions: {}, myCash: 0, myMtmPnl: 0, myOpenOrders: [],
    ...over,
  };
}

function book(
  bids: Array<{ price: number; size: number }>,
  offers: Array<{ price: number; size: number }>,
): BookSnapshot {
  return {
    contractId: CID,
    bids: bids.map((b) => ({ ...b, parties: [] })),
    offers: offers.map((o) => ({ ...o, parties: [] })),
    lastTradePrice: null,
    midPrice: bids[0] && offers[0] ? (bids[0].price + offers[0].price) / 2 : null,
  };
}

describe("weightedMid", () => {
  it("returns null when bid side is empty", () => {
    expect(weightedMid(book([], [{ price: 10, size: 1 }]))).toBeNull();
  });

  it("returns null when offer side is empty", () => {
    expect(weightedMid(book([{ price: 10, size: 1 }], []))).toBeNull();
  });

  it("returns null when both sides have zero total size", () => {
    expect(weightedMid(book(
      [{ price: 10, size: 0 }],
      [{ price: 12, size: 0 }],
    ))).toBeNull();
  });

  it("equals the simple mid when bid size equals offer size", () => {
    expect(weightedMid(book(
      [{ price: 10, size: 5 }],
      [{ price: 12, size: 5 }],
    ))).toBe(11);
  });

  it("leans toward bid when offer side is heavier (microprice semantics)", () => {
    const m = weightedMid(book(
      [{ price: 10, size: 1 }],
      [{ price: 12, size: 9 }],
    ))!;
    // (10*9 + 12*1) / 10 = 102/10 = 10.2
    expect(m).toBeCloseTo(10.2, 9);
    expect(m).toBeLessThan(11);
  });
});

describe("EMA primitives", () => {
  it("starts at null until the first observation", () => {
    const s = newEma();
    expect(emaValue(s)).toBeNull();
  });

  it("emaObserve adds weighted contributions", () => {
    const s = newEma();
    emaObserve(s, 10, 1);
    emaObserve(s, 20, 1);
    expect(emaValue(s)).toBe(15);
  });

  it("emaDecay preserves the central value but shrinks weight", () => {
    const s = newEma();
    emaObserve(s, 10, 4);
    expect(emaValue(s)).toBe(10);
    emaDecay(s, 0.5);
    expect(emaValue(s)).toBe(10);   // still 10 — both sums halved
    expect(s.totalWeight).toBe(2);
  });

  it("emaStep with null value decays only", () => {
    const s = newEma();
    emaObserve(s, 10, 1);
    emaStep(s, null, 0.5, 1);
    expect(emaValue(s)).toBe(10);
    expect(s.totalWeight).toBe(0.5);
  });

  it("emaStep with a value mixes new evidence at the chosen weight", () => {
    const s = newEma();
    emaObserve(s, 10, 1);
    emaStep(s, 20, 1.0, 1);   // no decay, full weight on new obs
    // weightedSum = 10 + 20 = 30; totalWeight = 1 + 1 = 2; EMA = 15
    expect(emaValue(s)).toBe(15);
  });

  it("decayForHalfLife returns 0.5 at one half-life and 1 at infinity", () => {
    expect(decayForHalfLife(1)).toBeCloseTo(0.5, 9);
    expect(decayForHalfLife(2)).toBeCloseTo(Math.sqrt(0.5), 9);
    expect(decayForHalfLife(1e12)).toBeCloseTo(1, 6);
  });

  it("repeated emaStep with null and a constant initial observation drifts toward 0 weight", () => {
    const s = newEma();
    emaObserve(s, 42, 1);
    for (let i = 0; i < 10; i++) emaStep(s, null, 0.5, 1);
    expect(emaValue(s)).toBe(42);         // central value preserved
    expect(s.totalWeight).toBeLessThan(0.01);
  });
});

describe("contractPrior", () => {
  it("equals informedSeats * mean(deck) for a SUM payoff with no public reveals", () => {
    // Deck mean = (1+2+3+4)/4 = 2.5; 2 informed + 1 public = 3 cards in play.
    // Expected sum = 7.5.
    const m = contractPrior(snap(), CID);
    expect(m).not.toBeNull();
    expect(m!).toBeCloseTo(7.5, 9);
  });

  it("conditions on a revealed public card", () => {
    const m = contractPrior(snap({ publicCards: [4] }), CID);
    // Closed form: 4 + 2 × ( (1×2+2×2+3×2+4×1)/7 ) = 4 + 32/7.
    expect(m!).toBeCloseTo(4 + 32 / 7, 9);
  });

  it("returns null when the contract is not in the snapshot", () => {
    expect(contractPrior(snap({ contracts: [] }), CID)).toBeNull();
  });
});
