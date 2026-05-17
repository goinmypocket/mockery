// =============================================================================
// Market-stats helpers — touch queries, TimeSeries ring buffer,
// null-skipping reducers.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  fractionTruthy,
  isMarketSafe,
  marketWidth,
  mean,
  median,
  quantile,
  secondsSinceLastAction,
  stdev,
  TimeSeries,
} from "../server/bots/helpers/marketstats";
import type { BookSnapshot, BotTrade, MarketSnapshot } from "../server/bots/api";
import { asContractId, asOrderId, asTradeId } from "../shared/ids";

const CID = asContractId("c1");
const CID2 = asContractId("c2");

function book(
  bids: Array<{ price: number; size: number }>,
  offers: Array<{ price: number; size: number }>,
): BookSnapshot {
  return {
    contractId: CID,
    bids: bids.map((b) => ({ ...b, parties: [] })),
    offers: offers.map((o) => ({ ...o, parties: [] })),
    lastTradePrice: null,
    midPrice: null,
  };
}

describe("isMarketSafe / marketWidth", () => {
  it("isMarketSafe is false when either side empty", () => {
    expect(isMarketSafe(book([], [{ price: 1, size: 1 }]))).toBe(false);
    expect(isMarketSafe(book([{ price: 1, size: 1 }], []))).toBe(false);
  });

  it("isMarketSafe is false when touch size is 0", () => {
    expect(isMarketSafe(book(
      [{ price: 1, size: 0 }],
      [{ price: 2, size: 1 }],
    ))).toBe(false);
  });

  it("marketWidth returns null when one-sided", () => {
    expect(marketWidth(book([], [{ price: 10, size: 1 }]))).toBeNull();
  });

  it("marketWidth = best offer − best bid", () => {
    expect(marketWidth(book(
      [{ price: 9, size: 1 }],
      [{ price: 11, size: 1 }],
    ))).toBe(2);
  });
});

describe("TimeSeries", () => {
  it("trims by age", () => {
    const ts = new TimeSeries<number>(1000);
    ts.push(0, 1);
    ts.push(500, 2);
    ts.push(1100, 3);   // pushes past maxAgeMs=1000 → ts=0 evicted
    expect(ts.size()).toBe(2);
    expect(ts.valuesWithin(1100)).toEqual([2, 3]);
  });

  it("trims by max samples", () => {
    const ts = new TimeSeries<number>(Infinity, 3);
    for (let i = 0; i < 5; i++) ts.push(i, i);
    expect(ts.size()).toBe(3);
    expect(ts.valuesWithin(10)).toEqual([2, 3, 4]);
  });

  it("within returns only samples newer than now − ms", () => {
    const ts = new TimeSeries<number>(Infinity);
    for (let i = 0; i < 10; i++) ts.push(i * 100, i);
    // now = 1000; window = 500 → cutoff 500 → samples at ts ≥ 500
    expect(ts.valuesWithin(1000, 500)).toEqual([5, 6, 7, 8, 9]);
  });

  it("clear empties the buffer", () => {
    const ts = new TimeSeries<number>(Infinity);
    ts.push(0, 1); ts.push(1, 2);
    ts.clear();
    expect(ts.size()).toBe(0);
  });
});

function trade(contractId: typeof CID, ts: number, price = 5, qty = 1): BotTrade {
  return {
    id: asTradeId(`t-${ts}`),
    ts, phase: 0, contractId,
    buyerCode: "AA", sellerCode: "BB",
    price, qty, aggressor: "buyer",
    restingOrderId: asOrderId("dummy"),
  };
}

function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    ts: 10_000, phase: 0, status: "playing", myCode: "ME",
    cardValues: [1, 2], copiesPerValue: 4,
    publicCards: [], contracts: [], participants: [],
    eventQueue: [], eventMode: "manual", msUntilNextEvent: null,
    books: {}, recentTrades: [],
    myPositions: {}, myCash: 0, myMtmPnl: 0, myOpenOrders: [],
    ...over,
  };
}

describe("secondsSinceLastAction", () => {
  it("returns null when no trades match the contract", () => {
    expect(secondsSinceLastAction(snap({ recentTrades: [] }), CID)).toBeNull();
    expect(secondsSinceLastAction(snap({ recentTrades: [trade(CID2, 5000)] }), CID)).toBeNull();
  });

  it("returns seconds since the most recent matching trade", () => {
    const s = snap({
      recentTrades: [trade(CID, 1000), trade(CID2, 5000), trade(CID, 8000)],
    });
    expect(secondsSinceLastAction(s, CID)).toBe(2);     // (10000 - 8000) / 1000
    expect(secondsSinceLastAction(s, CID2)).toBe(5);
  });
});

describe("reducers (null-skipping)", () => {
  it("mean skips nulls", () => {
    expect(mean([1, null, 3])).toBe(2);
    expect(mean([null, null])).toBeNull();
  });

  it("median skips nulls and interpolates", () => {
    expect(median([1, 2, null, 4])).toBe(2);     // [1,2,4] → middle
    expect(median([1, 2, null, 3, 4])).toBe(2.5); // [1,2,3,4] → interpolate
    expect(median([5])).toBe(5);
    expect(median([])).toBeNull();
  });

  it("quantile honours q ∈ [0, 1]", () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 9);
  });

  it("stdev needs at least two non-null samples", () => {
    expect(stdev([1])).toBeNull();
    expect(stdev([null, 5])).toBeNull();
    expect(stdev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 9);
  });

  it("fractionTruthy counts truthy entries", () => {
    expect(fractionTruthy([true, false, true, true])).toBeCloseTo(0.75, 9);
    expect(fractionTruthy([])).toBe(0);
    expect(fractionTruthy([1, 0, null, "x"])).toBeCloseTo(0.5, 9);
  });
});
