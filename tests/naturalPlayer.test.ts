// =============================================================================
// natural-player strategy — phase transitions and termination.
//
// All tests host the strategy in a multiProfileBot so it gets the
// SubBotContext it requires (afterLag, close, shared, etc).
// =============================================================================

import { describe, expect, it } from "vitest";
import { MockerySession } from "../server/MockerySession";
import { FakeClock } from "../server/clock";
import { BotOrchestrator } from "../server/bots/runtime";
import { multiProfileBot, type Profile } from "../server/bots/spawning";
import naturalPlayer from "../server/bots/strategies/natural-player";
import { asTableId, asUserId, type UserId } from "../shared/ids";
import { participantKey, type ResolvedOptions } from "../shared/types";

const HOST = asUserId("host-uid");
const ALICE = asUserId("alice-uid");
const BOB = asUserId("bob-uid");
const CAROL = asUserId("carol-uid");

function newGame(opts?: Partial<ResolvedOptions>) {
  const clock = new FakeClock(1_000_000);
  const merged: ResolvedOptions = {
    cardValues: [1, 2, 9, 10], copiesPerValue: 4,
    informedSeats: 3, uninformedSeats: 0, publicSlots: 0,
    eventMode: "manual", eventIntervalMin: 60, eventIntervalMax: 60,
    endGameGraceSec: 0, seed: 1,
    codeMode: "alpha", enforceCaseByRole: false,
    identityReveal: "all", identityRevealList: [],
    ...opts,
  };
  const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: merged, clock });
  s.claimSeat(ALICE, 0, { displayName: "Alice" });
  s.claimSeat(BOB,   1, { displayName: "Bob" });
  s.claimSeat(CAROL, 2, { displayName: "Carol" });
  s.startGame(HOST);
  return { s, clock };
}

function configureAndStart(s: MockerySession, entityIds: string[], strategyId: string): void {
  s.handleGameMessage(HOST, {
    type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
    payoffSource: "return H.sum(cards);",
  });
  s.handleGameMessage(HOST, { type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } });
  s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds });
  for (const id of entityIds) {
    s.handleGameMessage(HOST, { type: "SETUP_BIND_BOT_STRATEGY", entityId: id, strategyId });
  }
  s.handleGameMessage(HOST, { type: "START_TRADING" });
}

interface NaturalParamsOverride {
  targetQty?: number;
  tightSpreadFrac?: number;
  widthInitTicks?: number;
  historicMedianGuard?: number;
  urgencyDecayPerSec?: number;
  idleSecondsBeforeDecay?: number;
  urgentPennyIntervalMs?: number;
  panicThreshold?: number;
  panicEmaHalfLifeSec?: number;
}

function defaultParams(over: NaturalParamsOverride = {}) {
  return {
    targetQty: 5, tightSpreadFrac: 0.5, widthInitTicks: 3,
    historicMedianGuard: 1.5, urgencyDecayPerSec: 0,
    idleSecondsBeforeDecay: 1.0, urgentPennyIntervalMs: 1000,
    panicThreshold: 1.5, panicEmaHalfLifeSec: 5,
    ...over,
  };
}

function buildBotWithNatural(params: NaturalParamsOverride, lagMs = 0) {
  const profile: Profile = {
    id: "np", strategy: naturalPlayer, params: defaultParams(params),
    spawn: { mode: "permanent" }, lagMs, scope: "shared",
  };
  return multiProfileBot({ seed: 1, profiles: [profile] });
}

function botPosition(s: MockerySession, cid: ReturnType<MockerySession["getEngineState"]>["contracts"][number]["id"]): number {
  const key = participantKey({ kind: "bot", entityId: "XY" });
  return s.getEngineState().positions[key]?.[cid] ?? 0;
}

describe("natural-player", () => {
  it("takes the offer when Phase 2 width budget is breached", () => {
    const { s, clock } = newGame();
    const bot = buildBotWithNatural({ targetQty: 5, widthInitTicks: 3 });
    new BotOrchestrator(s, clock, { "multi-profile": bot });
    configureAndStart(s, ["XY"], "multi-profile");
    const cid = s.getEngineState().contracts[0]!.id;

    // Wide spread → width 10, budget 3 → breached → Phase 3 takes at 105.
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 10, price: 95  });
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 10, price: 105 });
    clock.advance(100);   // past lag-deferred Phase 1 → drive into Phase 3
    expect(botPosition(s, cid)).toBe(5);
  });

  it("closes the instance once target is filled (no further activity)", () => {
    const { s, clock } = newGame();
    const bot = buildBotWithNatural({ targetQty: 3 });
    new BotOrchestrator(s, clock, { "multi-profile": bot });
    configureAndStart(s, ["XY"], "multi-profile");
    const cid = s.getEngineState().contracts[0]!.id;

    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 100, price: 50 });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 1, price: 49 });
    clock.advance(200);
    expect(botPosition(s, cid)).toBe(3);

    // Drive more market activity; bot should be idle (instance closed).
    const posAfterFill = botPosition(s, cid);
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 1, price: 48 });
    clock.advance(2_000);
    expect(botPosition(s, cid)).toBe(posAfterFill);
  });

  it("sell side is symmetric — hits the bid when budget breached", () => {
    const { s, clock } = newGame();
    const bot = buildBotWithNatural({ targetQty: -4, widthInitTicks: 2 });
    new BotOrchestrator(s, clock, { "multi-profile": bot });
    configureAndStart(s, ["XY"], "multi-profile");
    const cid = s.getEngineState().contracts[0]!.id;

    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 10, price: 90  });
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 10, price: 100 });
    clock.advance(100);
    // Width 10, budget 2 → breached → take 4 at the bid (price 90).
    expect(botPosition(s, cid)).toBe(-4);
  });

  it("pennies passively in Phase 2 when within the budget", () => {
    const { s, clock } = newGame();
    // Budget is 10, spread will be 5 → within budget → penny.
    const bot = buildBotWithNatural({ targetQty: 5, widthInitTicks: 10 });
    new BotOrchestrator(s, clock, { "multi-profile": bot });
    configureAndStart(s, ["XY"], "multi-profile");
    const cid = s.getEngineState().contracts[0]!.id;

    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 1, price: 100 });
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 1, price: 105 });
    clock.advance(100);   // past Phase 1
    // Now drive Phase 2 via another market change.
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 1, price: 99 });
    clock.advance(50);    // give Phase 2's afterLag(placePassive) time to fire

    // Bot should have a resting buy at 101 (pennied past ALICE's 100).
    const bids = s.getEngineState().books[cid]!.bids;
    const myBidLevel = bids.find((l) => l.price === 101);
    expect(myBidLevel).toBeDefined();
    expect(myBidLevel!.orders.some((o) => o.participant.kind === "bot")).toBe(true);
  });

  it("buyer with no other bidders sits 1 tick inside the offer (does not cross)", () => {
    // Wide-budget buyer; only a seller has posted, no other bidders.
    // The bot should place a passive bid at bestOffer − 1, not at the
    // offer price (which would cross).
    const { s, clock } = newGame();
    const bot = buildBotWithNatural({ targetQty: 5, widthInitTicks: 10 });
    new BotOrchestrator(s, clock, { "multi-profile": bot });
    configureAndStart(s, ["XY"], "multi-profile");
    const cid = s.getEngineState().contracts[0]!.id;

    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 5, price: 105 });
    clock.advance(100);    // Phase 1 → no q25 → join (no-op, our side empty)
    // Drive Phase 2.
    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 5, price: 110 });
    clock.advance(100);

    // Bot should be resting at 104 (one tick inside the 105 offer),
    // NOT at 105 (which would have crossed and filled).
    expect(botPosition(s, cid)).toBe(0);
    const bids = s.getEngineState().books[cid]!.bids;
    expect(bids.some((l) => l.price === 104 && l.orders.some((o) => o.participant.kind === "bot"))).toBe(true);
  });

  it("two concurrent same-direction profiles each fill their own target", () => {
    // Per-instance attribution: even though both profiles see the bot's
    // shared position growing, each instance counts only its own fills
    // (immediate + onMyFill via restingOrderId match), so they close
    // at 3 + 4 = 7 total, not at the lower of the two targets.
    const { s, clock } = newGame();
    const bot = multiProfileBot({
      seed: 1,
      profiles: [
        { id: "np-a", strategy: naturalPlayer, params: defaultParams({ targetQty: 3 }),
          spawn: { mode: "permanent" }, lagMs: 0, scope: "instance" },
        { id: "np-b", strategy: naturalPlayer, params: defaultParams({ targetQty: 4 }),
          spawn: { mode: "permanent" }, lagMs: 0, scope: "instance" },
      ],
    });
    new BotOrchestrator(s, clock, { "multi-profile": bot });
    configureAndStart(s, ["XY"], "multi-profile");
    const cid = s.getEngineState().contracts[0]!.id;

    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 10, price: 95  });
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 20, price: 105 });
    clock.advance(100);

    expect(botPosition(s, cid)).toBe(7);     // 3 + 4
  });

  it("does not penny itself when computing the touch", () => {
    const { s, clock } = newGame();
    const bot = buildBotWithNatural({ targetQty: 5, widthInitTicks: 10 });
    new BotOrchestrator(s, clock, { "multi-profile": bot });
    configureAndStart(s, ["XY"], "multi-profile");
    const cid = s.getEngineState().contracts[0]!.id;

    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 1, price: 100 });
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 1, price: 105 });
    clock.advance(100);
    // Drive Phase 2; bot pennies to 101.
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 1, price: 99 });
    clock.advance(50);

    // Drive Phase 2 once more — should NOT chase its own 101 → 102.
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 1, price: 98 });
    clock.advance(50);

    const bids = s.getEngineState().books[cid]!.bids;
    expect(bids.some((l) => l.price === 102)).toBe(false);
  });
});
