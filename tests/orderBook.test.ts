import { describe, expect, it } from "vitest";
import { emptyBook, placeOrder, cancelOrder, bestBid, bestOffer, midPrice } from "../engine/orderBook";
import { asContractId, asOrderId, asTradeId, asUserId } from "../shared/ids";
import type { ParticipantId } from "../shared/types";

const C = asContractId("c1");
function alice(): ParticipantId { return { kind: "player", userId: asUserId("alice") }; }
function bob():   ParticipantId { return { kind: "player", userId: asUserId("bob") }; }
function carol(): ParticipantId { return { kind: "player", userId: asUserId("carol") }; }

function mkPlace(participant: ParticipantId, side: "buy"|"sell", qty: number, price: number, ioc = false) {
  let oseq = 0, tseq = 0;
  return {
    participant, contractId: C, side, qty, price, ioc,
    ts: 1000 + price, phase: 0,
    mintOrderId: () => asOrderId(`o${++oseq}`),
    mintTradeId: () => asTradeId(`t${++tseq}`),
  };
}

describe("orderBook", () => {
  it("posts a non-crossing limit and exposes best", () => {
    const b = emptyBook(C);
    const r = placeOrder(b, mkPlace(alice(), "buy", 5, 10));
    expect(r.trades).toHaveLength(0);
    expect(r.residentOrderId).not.toBeNull();
    expect(bestBid(b)?.price).toBe(10);
    expect(bestOffer(b)).toBeNull();
  });

  it("fills against existing offer at standing price", () => {
    const b = emptyBook(C);
    const bobR = placeOrder(b, mkPlace(bob(), "sell", 10, 12));
    const r = placeOrder(b, mkPlace(alice(), "buy", 4, 15));    // crosses
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.price).toBe(12);                          // standing wins
    expect(r.trades[0]!.qty).toBe(4);
    expect(r.trades[0]!.aggressor).toBe("buyer");
    expect(r.trades[0]!.restingOrderId).toBe(bobR.residentOrderId);
    expect(b.lastTradePrice).toBe(12);
    // residual offer at 12 should be 6
    expect(bestOffer(b)?.orders[0]!.qty).toBe(6);
  });

  it("respects FIFO at the same price level", () => {
    const b = emptyBook(C);
    placeOrder(b, mkPlace(bob(),   "sell", 3, 12));
    placeOrder(b, mkPlace(carol(), "sell", 5, 12));
    const r = placeOrder(b, mkPlace(alice(), "buy", 4, 15));
    // first 3 fill from bob, next 1 fills from carol
    expect(r.trades).toHaveLength(2);
    expect(r.trades[0]!.qty).toBe(3);
    expect(r.trades[0]!.seller.kind === "player" && r.trades[0]!.seller.userId).toBe("bob");
    expect(r.trades[1]!.qty).toBe(1);
    expect(r.trades[1]!.seller.kind === "player" && r.trades[1]!.seller.userId).toBe("carol");
    expect(bestOffer(b)?.orders[0]!.qty).toBe(4);                 // carol's 4 left
  });

  it("walks through multiple price levels until limit doesn't cross", () => {
    const b = emptyBook(C);
    placeOrder(b, mkPlace(bob(), "sell", 2, 11));
    placeOrder(b, mkPlace(bob(), "sell", 2, 12));
    placeOrder(b, mkPlace(bob(), "sell", 2, 13));
    const r = placeOrder(b, mkPlace(alice(), "buy", 10, 12));    // limit at 12 — stops at 13
    expect(r.trades.map((t) => t.price)).toEqual([11, 12]);
    // residual buyer order at 12 with qty 6 posts as resting bid
    expect(bestBid(b)?.price).toBe(12);
    expect(bestBid(b)?.orders[0]!.qty).toBe(6);
    // best offer is now the 13 level
    expect(bestOffer(b)?.price).toBe(13);
  });

  it("IOC residual is cancelled, not posted", () => {
    const b = emptyBook(C);
    placeOrder(b, mkPlace(bob(), "sell", 2, 12));
    const r = placeOrder(b, mkPlace(alice(), "buy", 5, 15, /* ioc */ true));
    expect(r.trades).toHaveLength(1);
    expect(r.residentOrderId).toBeNull();
    expect(bestBid(b)).toBeNull();
  });

  it("self-trade prevention cancels resting opposing-side order", () => {
    const b = emptyBook(C);
    placeOrder(b, mkPlace(alice(), "sell", 3, 12));
    const r = placeOrder(b, mkPlace(alice(), "buy", 5, 15));    // would self-cross
    // resting order cancelled, no trades, then the buy posts as resting bid
    expect(r.trades).toHaveLength(0);
    expect(bestOffer(b)).toBeNull();
    expect(bestBid(b)?.price).toBe(15);
  });

  it("cancels a resting order by id", () => {
    const b = emptyBook(C);
    const placed = placeOrder(b, mkPlace(alice(), "buy", 5, 10));
    expect(cancelOrder(b, placed.residentOrderId!)).toBe(true);
    expect(bestBid(b)).toBeNull();
  });

  it("midPrice is null without both sides; correct when both quoted", () => {
    const b = emptyBook(C);
    expect(midPrice(b)).toBeNull();
    placeOrder(b, mkPlace(alice(), "buy", 1, 10));
    expect(midPrice(b)).toBeNull();
    placeOrder(b, mkPlace(bob(), "sell", 1, 14));
    expect(midPrice(b)).toBe(12);
  });

  it("rejects invalid qty / price", () => {
    const b = emptyBook(C);
    expect(() => placeOrder(b, mkPlace(alice(), "buy", 0, 10))).toThrow();
    expect(() => placeOrder(b, mkPlace(alice(), "buy", 1, 1.5))).toThrow();
  });
});
