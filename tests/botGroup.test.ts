// =============================================================================
// BotGroup — one strategy fronting multiple engine bot entities for
// multi-code routing. Orders are routed across the group's entityIds
// uniformly via a seeded RNG; myPosition / myCash / onMyFill aggregate.
// =============================================================================

import { describe, expect, it } from "vitest";
import { MockerySession } from "../server/MockerySession";
import { FakeClock } from "../server/clock";
import { BotOrchestrator } from "../server/bots/runtime";
import type { BotStrategy, BotGroupConfig } from "../server/bots/api";
import { asTableId, asUserId, type UserId } from "../shared/ids";
import { participantKey, type ResolvedOptions } from "../shared/types";

const HOST = asUserId("host");
const ALICE = asUserId("alice");
const BOB = asUserId("bob");
const CAROL = asUserId("carol");

function newGame(over?: Partial<ResolvedOptions>) {
  const clock = new FakeClock(1_000_000);
  const opts: ResolvedOptions = {
    cardValues: [1, 2, 9, 10], copiesPerValue: 4,
    informedSeats: 3, uninformedSeats: 0, publicSlots: 0,
    eventMode: "manual", eventIntervalMin: 60, eventIntervalMax: 60,
    endGameGraceSec: 0, seed: 1,
    codeMode: "alpha", enforceCaseByRole: false,
    identityReveal: "all", identityRevealList: [],
    ...over,
  };
  const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
  s.claimSeat(ALICE, 0, { displayName: "Alice" });
  s.claimSeat(BOB,   1, { displayName: "Bob" });
  s.claimSeat(CAROL, 2, { displayName: "Carol" });
  s.startGame(HOST);
  return { s, clock };
}

function setupBots(s: MockerySession, entityIds: string[]) {
  s.handleGameMessage(HOST, {
    type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
    payoffSource: "return H.sum(cards);",
  });
  s.handleGameMessage(HOST, { type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } });
  s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds });
  s.handleGameMessage(HOST, { type: "START_TRADING" });
}

describe("BotGroup multi-code routing", () => {
  it("places orders across all group entities (uniform routing)", () => {
    const placements: Array<{ entityId: string }> = [];
    const eager: BotStrategy = {
      id: "eager", displayName: "eager",
      onMarketData(ctx) {
        if (ctx.local.get("done")) return;
        ctx.local.set("done", true);
        const cid = ctx.snapshot.contracts[0]!.id;
        for (let i = 0; i < 12; i++) {
          ctx.placeIoc({ contractId: cid, side: "buy", qty: 1, price: 105 });
        }
      },
    };
    const { s, clock } = newGame();
    const group: BotGroupConfig = {
      groupId: "G1", entityIds: ["AA", "BB", "CC"],
      strategy: eager, seed: 7,
    };
    new BotOrchestrator(s, clock, {}, { groups: [group] });
    setupBots(s, ["AA", "BB", "CC"]);

    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 100, price: 105 });
    clock.advance(10);

    // Each code should have placed some orders. The bot doesn't tell us
    // directly which placed what — check positions per entity.
    const posAA = s.getEngineState().positions[participantKey({ kind: "bot", entityId: "AA" })]?.[cid] ?? 0;
    const posBB = s.getEngineState().positions[participantKey({ kind: "bot", entityId: "BB" })]?.[cid] ?? 0;
    const posCC = s.getEngineState().positions[participantKey({ kind: "bot", entityId: "CC" })]?.[cid] ?? 0;
    expect(posAA + posBB + posCC).toBe(12);
    // With 12 draws across 3 buckets and seed=7, all three buckets get
    // something (P(all-three-nonempty) > 99% for n=12).
    expect(posAA).toBeGreaterThan(0);
    expect(posBB).toBeGreaterThan(0);
    expect(posCC).toBeGreaterThan(0);

    void placements;
  });

  it("myPosition / myCash / myOpenOrders aggregate across group entities", () => {
    let observedPos = 0;
    let observedCash = 0;
    let observedOpenCount = 0;
    const observer: BotStrategy = {
      id: "observer", displayName: "observer",
      onMarketData(ctx) {
        if (ctx.local.get("done")) return;
        ctx.local.set("done", true);
        const cid = ctx.snapshot.contracts[0]!.id;
        ctx.placeIoc({ contractId: cid, side: "buy", qty: 3, price: 105 });
        ctx.placeLimit({ contractId: cid, side: "buy", qty: 2, price: 90 });   // rests
        observedPos = ctx.myPosition(cid);
        observedCash = ctx.myCash();
        observedOpenCount = ctx.myOpenOrders().length;
      },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, {}, {
      groups: [{ groupId: "G", entityIds: ["AA", "BB"], strategy: observer, seed: 1 }],
    });
    setupBots(s, ["AA", "BB"]);
    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 10, price: 105 });
    clock.advance(10);

    expect(observedPos).toBe(3);            // aggregated across the 2 entities
    expect(observedCash).toBe(-315);        // 3 lots @ 105 = 315 paid
    expect(observedOpenCount).toBe(1);      // the resting bid
  });

  it("onMyFill fires for trades against any group entity", () => {
    const fills: Array<{ qty: number; side: "buy" | "sell" }> = [];
    const taker: BotStrategy = {
      id: "taker-g", displayName: "taker",
      onStart(ctx) {
        const cid = ctx.snapshot.contracts[0]!.id;
        ctx.placeLimit({ contractId: cid, side: "buy", qty: 4, price: 100 });
        ctx.placeLimit({ contractId: cid, side: "buy", qty: 4, price: 100 });
      },
      onMyFill(_ctx, trade, side) { fills.push({ qty: trade.qty, side }); },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, {}, {
      groups: [{ groupId: "G", entityIds: ["AA", "BB"], strategy: taker, seed: 2 }],
    });
    setupBots(s, ["AA", "BB"]);
    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 7, price: 100 });
    clock.advance(10);

    const totalFilled = fills.reduce((sum, f) => sum + f.qty, 0);
    expect(totalFilled).toBe(7);
    expect(fills.every((f) => f.side === "buy")).toBe(true);
  });

  it("myCodes exposes the full code set; myCode is the first", () => {
    let observed: { myCode: string; myCodes: readonly string[] } | null = null;
    const peek: BotStrategy = {
      id: "peek-g", displayName: "peek",
      onStart(ctx) { observed = { myCode: ctx.myCode, myCodes: ctx.myCodes }; },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, {}, {
      groups: [{ groupId: "G", entityIds: ["XX", "YY", "ZZ"], strategy: peek }],
    });
    setupBots(s, ["XX", "YY", "ZZ"]);
    expect(observed).not.toBeNull();
    expect(observed!.myCode).toBe("XX");
    expect(observed!.myCodes).toEqual(["XX", "YY", "ZZ"]);
  });

  it("same seed → same routing sequence (replay-stable)", () => {
    function runOnce(seed: number): number[] {
      const places: string[] = [];
      const eager: BotStrategy = {
        id: "eager", displayName: "eager",
        onStart(ctx) {
          const cid = ctx.snapshot.contracts[0]!.id;
          for (let i = 0; i < 6; i++) {
            ctx.placeIoc({ contractId: cid, side: "buy", qty: 1, price: 105 });
          }
        },
      };
      const { s, clock } = newGame();
      new BotOrchestrator(s, clock, {}, {
        groups: [{ groupId: "G", entityIds: ["AA", "BB", "CC"], strategy: eager, seed }],
      });
      setupBots(s, ["AA", "BB", "CC"]);
      const cid = s.getEngineState().contracts[0]!.id;
      s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 100, price: 105 });
      clock.advance(10);
      return ["AA", "BB", "CC"].map((eid) =>
        s.getEngineState().positions[participantKey({ kind: "bot", entityId: eid })]?.[cid] ?? 0);
      void places;
    }
    const a = runOnce(99);
    const b = runOnce(99);
    expect(a).toEqual(b);
  });
});
