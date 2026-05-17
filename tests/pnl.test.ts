import { describe, expect, it } from "vitest";
import { applyTrade, getCash, getPosition, mtmPnl, settledPnl, markPrice } from "../engine/pnl";
import { createInitialState, type GameState } from "../engine/state";
import { emptyBook, placeOrder } from "../engine/orderBook";
import { asContractId, asOrderId, asTradeId, asUserId } from "../shared/ids";
import type { ParticipantId, ResolvedOptions, Trade } from "../shared/types";

function mkState(): GameState {
  const opts: ResolvedOptions = {
    cardValues: [1, 2],
    copiesPerValue: 2,
    informedSeats: 1,
    uninformedSeats: 1,
    publicSlots: 0,
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
  return createInitialState({
    options: opts,
    hostUserId: asUserId("host"),
    seats: [asUserId("alice"), asUserId("bob")],
    now: 0,
  });
}

const alice: ParticipantId = { kind: "player", userId: asUserId("alice") };
const bob:   ParticipantId = { kind: "player", userId: asUserId("bob") };

describe("pnl bookkeeping", () => {
  it("credits position and cash on a trade", () => {
    const s = mkState();
    const cid = asContractId("c1");
    const trade: Trade = {
      id: asTradeId("t1"),
      ts: 1,
      phase: 0,
      contractId: cid,
      buyer: alice,
      seller: bob,
      price: 10,
      qty: 5,
      aggressor: "buyer",
      restingOrderId: asOrderId("dummy"),
    };
    applyTrade(s, trade);
    expect(getPosition(s, alice, cid)).toBe(5);
    expect(getCash(s, alice)).toBe(-50);
    expect(getPosition(s, bob, cid)).toBe(-5);
    expect(getCash(s, bob)).toBe(50);
    // sum of cash is zero (no friction)
    expect(getCash(s, alice) + getCash(s, bob)).toBe(0);
  });

  it("MTM uses mid > last > 0", () => {
    const s = mkState();
    const cid = asContractId("c1");
    s.books[cid] = emptyBook(cid);
    // After one trade at 10, with no quotes — mark = 10
    applyTrade(s, {
      id: asTradeId("t1"), ts: 1, phase: 0, contractId: cid,
      buyer: alice, seller: bob, price: 10, qty: 5, aggressor: "buyer",
      restingOrderId: asOrderId("dummy"),
    });
    s.books[cid]!.lastTradePrice = 10;
    expect(markPrice(s, cid)).toBe(10);
    expect(mtmPnl(s, alice)).toBe(0);   // bought 5 @ 10, mark 10 → flat

    // Add bid 9 and offer 13 → mid 11
    let oseq = 0, tseq = 0;
    placeOrder(s.books[cid]!, {
      participant: alice, contractId: cid, side: "buy", qty: 1, price: 9, ioc: false,
      ts: 2, phase: 0,
      mintOrderId: () => asOrderId(`o${++oseq}`),
      mintTradeId: () => asTradeId(`t${++tseq}`),
    });
    placeOrder(s.books[cid]!, {
      participant: bob, contractId: cid, side: "sell", qty: 1, price: 13, ioc: false,
      ts: 3, phase: 0,
      mintOrderId: () => asOrderId(`o${++oseq}`),
      mintTradeId: () => asTradeId(`t${++tseq}`),
    });
    expect(markPrice(s, cid)).toBe(11);
    expect(mtmPnl(s, alice)).toBe(5);    // 5 long, +1 vs entry, mark 11
  });

  it("settled PnL uses settlement value", () => {
    const s = mkState();
    const cid = asContractId("c1");
    s.books[cid] = emptyBook(cid);
    applyTrade(s, {
      id: asTradeId("t1"), ts: 1, phase: 0, contractId: cid,
      buyer: alice, seller: bob, price: 10, qty: 5, aggressor: "buyer",
      restingOrderId: asOrderId("dummy"),
    });
    const settled = settledPnl(s, alice, { [cid]: 25 });
    expect(settled).toBe(75);   // 5 × 25 + (-50)
    const settledBob = settledPnl(s, bob, { [cid]: 25 });
    expect(settledBob).toBe(-75);
  });
});
