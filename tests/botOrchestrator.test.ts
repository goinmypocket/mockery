// =============================================================================
// Bot orchestrator: runs strategies through a real session lifecycle and
// asserts the engine sees their actions.
// =============================================================================

import { describe, expect, it } from "vitest";
import { MockerySession } from "../server/MockerySession";
import { FakeClock } from "../server/clock";
import { BotOrchestrator } from "../server/bots/runtime";
import { STRATEGIES } from "../server/bots/registry";
import type { BotStrategy } from "../server/bots/api";
import { asTableId, asUserId, type UserId } from "../shared/ids";
import { participantKey, type ResolvedOptions } from "../shared/types";

const HOST = asUserId("host-uid");
const ALICE = asUserId("alice-uid");
const BOB = asUserId("bob-uid");
const CAROL = asUserId("carol-uid");

function newGame(opts?: Partial<ResolvedOptions>) {
  const clock = new FakeClock(1000_000);
  const merged: ResolvedOptions = {
    cardValues: [1, 2, 9, 10],
    copiesPerValue: 4,
    informedSeats: 3,
    uninformedSeats: 0,
    publicSlots: 0,
    eventMode: "manual",
    eventIntervalMin: 60,
    eventIntervalMax: 60,
    endGameGraceSec: 0,
    seed: 1,
    codeMode: "alpha",
    enforceCaseByRole: false,
    identityReveal: "all",
    identityRevealList: [],
    ...opts,
  };
  const s = new MockerySession({
    tableId: asTableId("t1"),
    hostUserId: HOST,
    options: merged,
    clock,
  });
  s.claimSeat(ALICE, 0, { displayName: "Alice" });
  s.claimSeat(BOB, 1, { displayName: "Bob" });
  s.claimSeat(CAROL, 2, { displayName: "Carol" });
  s.startGame(HOST);
  return { s, clock };
}

function configureAndStart(s: MockerySession, entityIds: string[], strategyId: string | null): void {
  s.handleGameMessage(HOST, {
    type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
    payoffSource: "return H.sum(cards);",
  });
  s.handleGameMessage(HOST, {
    type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" },
  });
  s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds });
  if (strategyId) {
    for (const id of entityIds) {
      s.handleGameMessage(HOST, {
        type: "SETUP_BIND_BOT_STRATEGY", entityId: id, strategyId,
      });
    }
  }
  s.handleGameMessage(HOST, { type: "START_TRADING" });
}

describe("BotOrchestrator", () => {
  it("calls onStart for each instantiated bot", () => {
    const startCalls: string[] = [];
    const tracker: BotStrategy = {
      id: "tracker",
      displayName: "Tracker",
      onStart(ctx) { startCalls.push(ctx.entityId); },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { tracker });
    configureAndStart(s, ["XY", "ZQ"], "tracker");
    expect(startCalls.sort()).toEqual(["XY", "ZQ"]);
  });

  it("strategies that don't bind don't get instantiated", () => {
    const startCalls: string[] = [];
    const tracker: BotStrategy = {
      id: "tracker",
      displayName: "Tracker",
      onStart(ctx) { startCalls.push(ctx.entityId); },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { tracker });
    configureAndStart(s, ["XY"], null);  // no strategy bound
    expect(startCalls).toEqual([]);
  });

  it("a placeLimit from a bot reaches the engine and updates positions", () => {
    const placeOnStart: BotStrategy = {
      id: "place-on-start",
      displayName: "Buys 1@10 on start",
      onStart(ctx) {
        const cid = ctx.snapshot.contracts[0]!.id;
        ctx.placeLimit({ contractId: cid, side: "buy", qty: 1, price: 10 });
      },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { "place-on-start": placeOnStart });
    configureAndStart(s, ["XY"], "place-on-start");
    const cid = s.getEngineState().contracts[0]!.id;
    expect(s.getEngineState().books[cid]!.bids).toHaveLength(1);
    expect(s.getEngineState().books[cid]!.bids[0]!.price).toBe(10);
    expect(s.getEngineState().books[cid]!.bids[0]!.orders[0]!.participant)
      .toEqual({ kind: "bot", entityId: "XY" });
  });

  it("onEvent fires on each event, onMarketData fires on changes", () => {
    const events: string[] = [];
    const marketCalls = { count: 0 };
    const tracker: BotStrategy = {
      id: "tracker",
      displayName: "Tracker",
      onEvent(_, evt) { events.push(evt.type); },
      onMarketData() { marketCalls.count++; },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { tracker });
    configureAndStart(s, ["XY"], "tracker");
    const before = marketCalls.count;
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    expect(events).toEqual(["ROTATED"]);
    expect(marketCalls.count).toBeGreaterThan(before);
  });

  it("onTrade fires for every print", () => {
    const trades: string[] = [];
    const watcher: BotStrategy = {
      id: "watcher",
      displayName: "Watcher",
      onTrade(_, t) { trades.push(`${t.buyerCode}-${t.sellerCode}@${t.price}x${t.qty}`); },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { watcher });
    configureAndStart(s, ["XY"], "watcher");
    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 1, price: 12 });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 1, price: 12 });
    expect(trades).toEqual(["AL-BO@12x1"]);
  });

  it("onGameOver fires with the bot's final PnL", () => {
    let captured: { myFinalPnl: number; settlements: Record<string, number> } | null = null;
    const watcher: BotStrategy = {
      id: "watcher",
      displayName: "Watcher",
      onGameOver(_, result) {
        captured = { myFinalPnl: result.myFinalPnl, settlements: { ...result.settlements } };
      },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { watcher });
    configureAndStart(s, ["XY"], "watcher");
    // Bot trades 5 long @ 10 against Bob.
    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 5, price: 10 });
    s.submitBotIntent("XY", { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 5, price: 10 });
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    s.handleGameMessage(HOST, { type: "END_GAME" });

    expect(captured).not.toBeNull();
    const settle = captured!.settlements[cid as unknown as string]!;
    expect(captured!.myFinalPnl).toBe(5 * (settle - 10));
  });

  it("setTimer fires through the SessionClock", () => {
    const tickCounts = { count: 0 };
    const ticker: BotStrategy = {
      id: "ticker",
      displayName: "Ticker",
      onStart(ctx) {
        const tick = (): void => {
          tickCounts.count++;
          ctx.setTimer(1000, tick);
        };
        ctx.setTimer(1000, tick);
      },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { ticker });
    configureAndStart(s, ["XY"], "ticker");

    expect(tickCounts.count).toBe(0);
    clock.advance(1000);
    expect(tickCounts.count).toBe(1);
    clock.advance(2500);
    expect(tickCounts.count).toBe(3);
  });

  it("random-quoter posts a bid+offer per contract on start", () => {
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, STRATEGIES);
    configureAndStart(s, ["XY"], "random-quoter");
    const cid = s.getEngineState().contracts[0]!.id;
    const book = s.getEngineState().books[cid]!;
    expect(book.bids.length).toBe(1);
    expect(book.offers.length).toBe(1);
    // After an event, quotes are pulled. The strategy will re-quote on the
    // next timer (scheduled inside its onStart's `tick`).
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    const book2 = s.getEngineState().books[cid]!;
    expect(book2.bids.length).toBe(0);
    expect(book2.offers.length).toBe(0);
  });

  it("teardown on game-over: pending bot timers are cancelled", () => {
    const ticks = { n: 0 };
    const ticker: BotStrategy = {
      id: "ticker",
      displayName: "Ticker",
      onStart(ctx) {
        const tick = (): void => { ticks.n++; ctx.setTimer(1000, tick); };
        ctx.setTimer(1000, tick);
      },
    };
    const { s, clock } = newGame();
    new BotOrchestrator(s, clock, { ticker });
    configureAndStart(s, ["XY"], "ticker");
    clock.advance(1500);
    expect(ticks.n).toBe(1);
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    s.handleGameMessage(HOST, { type: "END_GAME" });
    const before = ticks.n;
    clock.advance(10_000);
    expect(ticks.n).toBe(before);   // no further ticks after game over
  });

  it("the bot's snapshot keeps cards hidden — only revealed publics surface", () => {
    let observed: ReadonlyArray<number | null> | null = null;
    const peeker: BotStrategy = {
      id: "peeker",
      displayName: "Peeker",
      onStart(ctx) { observed = ctx.snapshot.publicCards; },
    };
    const clock = new FakeClock(0);
    const opts: ResolvedOptions = {
      cardValues: [1, 2, 9, 10], copiesPerValue: 4,
      informedSeats: 3, uninformedSeats: 0, publicSlots: 2,
      eventMode: "manual", eventIntervalMin: 60, eventIntervalMax: 60,
      endGameGraceSec: 0, seed: 7,
      codeMode: "alpha", enforceCaseByRole: false,
      identityReveal: "all", identityRevealList: [],
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    s.claimSeat(ALICE, 0, { displayName: "Alice" });
    s.claimSeat(BOB, 1, { displayName: "Bob" });
    s.claimSeat(CAROL, 2, { displayName: "Carol" });
    s.startGame(HOST);
    new BotOrchestrator(s, clock, { peeker });
    configureAndStart(s, ["XY"], "peeker");
    expect(observed).not.toBeNull();
    expect(observed!).toEqual([null, null]);
  });

  it("orchestrator quarantines a bot after repeated errors", () => {
    let calls = 0;
    const angry: BotStrategy = {
      id: "angry",
      displayName: "Angry",
      onMarketData() { calls++; throw new Error("boom"); },
    };
    const { s, clock } = newGame();
    const orch = new BotOrchestrator(s, clock, { angry });
    configureAndStart(s, ["XY"], "angry");
    // suppress console noise from the orchestrator
    const origWarn = console.warn; console.warn = () => {};
    try {
      const cid = s.getEngineState().contracts[0]!.id;
      // Trigger market changes repeatedly
      for (let i = 0; i < 10; i++) {
        s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 1, price: i + 1 });
      }
    } finally {
      console.warn = origWarn;
    }
    // After quarantine, calls stop incrementing on subsequent triggers.
    const callsAtQuarantine = calls;
    s.handleGameMessage(BOB, { type: "PLACE_LIMIT", contractId: s.getEngineState().contracts[0]!.id, side: "buy", qty: 1, price: 99 });
    expect(calls).toBe(callsAtQuarantine);
    void orch;   // keep ref alive
  });

  it("position bookkeeping stays consistent across player + bot trades", () => {
    const { s, clock } = newGame();
    const noopStrat: BotStrategy = { id: "noop", displayName: "noop" };
    new BotOrchestrator(s, clock, { noop: noopStrat });
    configureAndStart(s, ["XY"], "noop");
    const cid = s.getEngineState().contracts[0]!.id;

    // Bot offers 3 @ 12; Alice buys 3 @ 14.
    s.submitBotIntent("XY", { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 3, price: 12 });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 3, price: 14 });

    const st = s.getEngineState();
    const aliceKey = participantKey({ kind: "player", userId: ALICE });
    const botKey = participantKey({ kind: "bot", entityId: "XY" });
    expect(st.positions[aliceKey]![cid]).toBe(3);
    expect(st.positions[botKey]![cid]).toBe(-3);
    expect(st.cash[aliceKey]).toBe(-36);
    expect(st.cash[botKey]).toBe(36);
  });
});

function _suppressUnused(...args: unknown[]): void { void args; }
_suppressUnused(participantKey);
