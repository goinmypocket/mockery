// =============================================================================
// Bot helpers — pure-function unit tests. We construct minimal
// MarketSnapshot fixtures by hand and assert each helper computes
// what its docstring promises.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  bestBid,
  bestOffer,
  isMyTrade,
  ladder,
  midOrFallback,
  myOrderIdsAt,
  myRestingAt,
  netAggressorVolume,
  recentVwap,
  sizeUnderLimit,
  spread,
  touch,
  twoSided,
} from "../server/bots/helpers";
import type {
  BotTrade,
  MarketSnapshot,
} from "../server/bots/api";
import { asContractId, asOrderId, asTradeId } from "../shared/ids";
import type { Order } from "../shared/types";

const CID = asContractId("c1");

function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    ts: 0,
    phase: 0,
    status: "playing",
    myCode: "ME",
    cardValues: [1, 2],
    copiesPerValue: 4,
    publicCards: [],
    contracts: [],
    participants: [],
    eventQueue: [],
    eventMode: "manual",
    msUntilNextEvent: null,
    books: {
      [CID]: {
        contractId: CID,
        bids: [
          { price: 24, size: 3, parties: [{ code: "A", qty: 3 }] },
          { price: 23, size: 5, parties: [{ code: "B", qty: 5 }] },
        ],
        offers: [
          { price: 26, size: 2, parties: [{ code: "C", qty: 2 }] },
          { price: 27, size: 4, parties: [{ code: "D", qty: 4 }] },
        ],
        lastTradePrice: 25,
        midPrice: 25,
      },
    },
    recentTrades: [],
    myPositions: {},
    myCash: 0,
    myMtmPnl: 0,
    myOpenOrders: [],
    ...over,
  };
}

function mkOrder(over: Partial<Order>): Order {
  return {
    id: asOrderId("o0"),
    participant: { kind: "bot", entityId: "me" },
    contractId: CID,
    side: "buy",
    price: 20,
    qty: 1,
    enteredAt: 0,
    ...over,
  } as Order;
}

describe("helpers/book", () => {
  it("bestBid + bestOffer return the top level on each side", () => {
    const s = snap();
    expect(bestBid(s, CID)?.price).toBe(24);
    expect(bestOffer(s, CID)?.price).toBe(26);
  });

  it("touch returns both sides together", () => {
    const t = touch(snap(), CID);
    expect(t.bid?.price).toBe(24);
    expect(t.offer?.price).toBe(26);
  });

  it("spread is offer − bid; null when one side empty", () => {
    expect(spread(snap(), CID)).toBe(2);
    const oneSided = snap({
      books: {
        [CID]: {
          contractId: CID,
          bids: [],
          offers: [{ price: 26, size: 2, parties: [{ code: "C", qty: 2 }] }],
          lastTradePrice: null,
          midPrice: null,
        },
      },
    });
    expect(spread(oneSided, CID)).toBeNull();
  });

  it("midOrFallback prefers midPrice → lastTradePrice → fallback", () => {
    expect(midOrFallback(snap(), CID, 99)).toBe(25);
    const noMid = snap({
      books: {
        [CID]: {
          contractId: CID,
          bids: [],
          offers: [],
          lastTradePrice: 30,
          midPrice: null,
        },
      },
    });
    expect(midOrFallback(noMid, CID, 99)).toBe(30);
    const empty = snap({
      books: {
        [CID]: {
          contractId: CID,
          bids: [], offers: [],
          lastTradePrice: null,
          midPrice: null,
        },
      },
    });
    expect(midOrFallback(empty, CID, 99)).toBe(99);
    expect(midOrFallback(empty, CID)).toBeNull();
  });

  it("myRestingAt sums qty across same-level orders", () => {
    const s = snap({
      myOpenOrders: [
        mkOrder({ id: asOrderId("o1"), side: "buy", price: 20, qty: 2 }),
        mkOrder({ id: asOrderId("o2"), side: "buy", price: 20, qty: 3 }),
        mkOrder({ id: asOrderId("o3"), side: "buy", price: 21, qty: 1 }),
      ],
    });
    expect(myRestingAt(s, CID, "buy", 20)).toBe(5);
    expect(myRestingAt(s, CID, "buy", 21)).toBe(1);
    expect(myRestingAt(s, CID, "sell", 20)).toBe(0);
  });

  it("myOrderIdsAt returns just the ids of matching orders", () => {
    const s = snap({
      myOpenOrders: [
        mkOrder({ id: asOrderId("o1"), price: 20 }),
        mkOrder({ id: asOrderId("o2"), price: 20 }),
        mkOrder({ id: asOrderId("o3"), price: 21 }),
      ],
    });
    expect(myOrderIdsAt(s, CID, "buy", 20)).toEqual(["o1", "o2"]);
  });
});

describe("helpers/quoting", () => {
  it("twoSided floors bid and ceils offer", () => {
    const q = twoSided(25.7, 1.5, 2);
    expect(q.bid).toEqual({ side: "buy", price: 24, qty: 2 });
    expect(q.offer).toEqual({ side: "sell", price: 28, qty: 2 });
  });

  it("ladder fans out N levels per side at the given step", () => {
    const out = ladder({ center: 25, halfSpread: 1, step: 1, levels: 3, size: 1 });
    const bids = out.filter((q) => q.side === "buy").map((q) => q.price);
    const offers = out.filter((q) => q.side === "sell").map((q) => q.price);
    expect(bids).toEqual([24, 23, 22]);
    expect(offers).toEqual([26, 27, 28]);
  });

  it("sizeUnderLimit clamps qty toward the cap from either direction", () => {
    expect(
      sizeUnderLimit({ side: "buy", baseQty: 5, myPosition: 3, positionLimit: 5 }),
    ).toBe(2);
    expect(
      sizeUnderLimit({ side: "buy", baseQty: 5, myPosition: 5, positionLimit: 5 }),
    ).toBe(0);
    expect(
      sizeUnderLimit({ side: "sell", baseQty: 5, myPosition: -4, positionLimit: 5 }),
    ).toBe(1);
    expect(
      sizeUnderLimit({ side: "sell", baseQty: 5, myPosition: -5, positionLimit: 5 }),
    ).toBe(0);
  });
});

describe("helpers/trades", () => {
  function mkTrade(over: Partial<BotTrade> = {}): BotTrade {
    return {
      id: asTradeId("t0"),
      ts: 0,
      phase: 0,
      contractId: CID,
      buyerCode: "A",
      sellerCode: "B",
      price: 25,
      qty: 1,
      aggressor: "buyer",
      restingOrderId: asOrderId("dummy"),
      ...over,
    };
  }

  it("isMyTrade catches both sides", () => {
    const s = snap({ myCode: "ME" });
    expect(isMyTrade(s, mkTrade({ buyerCode: "ME" }))).toBe(true);
    expect(isMyTrade(s, mkTrade({ sellerCode: "ME" }))).toBe(true);
    expect(isMyTrade(s, mkTrade())).toBe(false);
  });

  it("recentVwap returns the qty-weighted average of the last N units", () => {
    // Two prints: 10@1, 30@2 → vwap over last 3 units = (10*1 + 30*2)/3 = 23.33...
    const trades: BotTrade[] = [
      mkTrade({ id: asTradeId("t1"), price: 10, qty: 1 }),
      mkTrade({ id: asTradeId("t2"), price: 30, qty: 2 }),
    ];
    const s = snap({ recentTrades: trades });
    expect(recentVwap(s, CID, 3)).toBeCloseTo((10 + 60) / 3);
    expect(recentVwap(s, CID, 0)).toBeNull();
  });

  it("netAggressorVolume signs buys positive, sells negative", () => {
    const trades: BotTrade[] = [
      { id: asTradeId("t1"), ts: 0, phase: 0, contractId: CID,
        buyerCode: "A", sellerCode: "B", price: 25, qty: 3, aggressor: "buyer",
        restingOrderId: asOrderId("dummy") },
      { id: asTradeId("t2"), ts: 0, phase: 0, contractId: CID,
        buyerCode: "A", sellerCode: "B", price: 25, qty: 2, aggressor: "seller",
        restingOrderId: asOrderId("dummy") },
    ];
    const s = snap({ recentTrades: trades });
    expect(netAggressorVolume(s, CID, 10)).toBe(1);   // +3 - 2
  });
});
