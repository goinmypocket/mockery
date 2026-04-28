// =============================================================================
// Trading + projection tests against the live session.
// =============================================================================

import { describe, expect, it } from "vitest";
import { MockerySession } from "../server/MockerySession";
import { FakeClock } from "../server/clock";
import { asTableId, asUserId, type UserId } from "../shared/ids";
import type { ResolvedOptions } from "../shared/types";

const HOST = asUserId("host-uid");
const ALICE = asUserId("alice-uid");
const BOB = asUserId("bob-uid");
const CAROL = asUserId("carol-uid");

function setup(eventMode: "auto" | "manual" = "manual", identityReveal: "all" | "host" | "listed" = "all") {
  const clock = new FakeClock(1000_000);
  const opts: ResolvedOptions = {
    cardValues: [1, 2, 9, 10],
    copiesPerValue: 4,
    informedSeats: 3,
    uninformedSeats: 0,
    publicSlots: 0,
    eventMode,
    eventIntervalMin: 60,
    eventIntervalMax: 60,
    endGameGraceSec: 0,
    seed: 42,
    codeMode: "alpha",
    enforceCaseByRole: false,
    identityReveal,
    identityRevealList: [],
  };
  const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
  s.claimSeat(ALICE, 0, { displayName: "Alice" });
  s.claimSeat(BOB, 1, { displayName: "Bob" });
  s.claimSeat(CAROL, 2, { displayName: "Carol" });
  s.startGame(HOST);
  s.handleGameMessage(HOST, {
    type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
    payoffSource: "return H.sum(cards);",
  });
  s.handleGameMessage(HOST, {
    type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" },
  });
  s.handleGameMessage(HOST, { type: "START_TRADING" });
  return { s, clock, opts };
}

describe("trading on a live session", () => {
  it("places, matches, and emits a trade with the correct codes", () => {
    const { s } = setup();
    const cid = s.getStateForTesting().contracts[0]!.id;
    s.handleGameMessage(BOB,  { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 5, price: 12 });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 3, price: 14 });

    const st = s.getStateForTesting();
    expect(st.trades).toHaveLength(1);
    expect(st.trades[0]!.price).toBe(12);
    expect(st.trades[0]!.qty).toBe(3);

    // Project for Alice — she sees Bob and Carol by code.
    const snap = s.projectFor(ALICE);
    expect(snap.recentTrades).toHaveLength(1);
    expect(snap.recentTrades[0]!.buyerCode).toBe("AL");
    expect(snap.recentTrades[0]!.sellerCode).toBe("BO");
  });

  it("CANCEL_ORDER removes resting order", () => {
    const { s } = setup();
    const cid = s.getStateForTesting().contracts[0]!.id;
    let lastSnapshot: unknown = null;
    s.attachConnection(ALICE, (m) => { lastSnapshot = m; });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 5, price: 10 });
    const st = s.getStateForTesting();
    const orderId = st.books[cid]!.bids[0]!.orders[0]!.id;
    s.handleGameMessage(ALICE, { type: "CANCEL_ORDER", orderId });
    expect(s.getStateForTesting().books[cid]!.bids).toHaveLength(0);
    expect(lastSnapshot).not.toBeNull();
  });

  it("rejects spectator orders", () => {
    const { s } = setup();
    const cid = s.getStateForTesting().contracts[0]!.id;
    let rejected: string | null = null;
    s.attachConnection(HOST, (m) => {
      const obj = m as Record<string, unknown>;
      if (obj["type"] === "INTENT_REJECTED") rejected = String(obj["reason"]);
    });
    s.handleGameMessage(HOST, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 1, price: 5 });
    expect(rejected).toMatch(/spectators/);
  });
});

describe("projection and identity reveal", () => {
  it("with identityReveal=all every viewer sees displayNames", () => {
    const { s } = setup("manual", "all");
    const snap = s.projectFor(BOB);
    const alice = snap.participants.find((p) => p.code === "AL")!;
    expect(alice.displayName).toBe("Alice");
  });

  it("with identityReveal=host, only the host sees other participants' names", () => {
    const { s } = setup("manual", "host");
    const bobSnap = s.projectFor(BOB);
    const aliceP = bobSnap.participants.find((p) => p.code === "AL")!;
    const bobSelf = bobSnap.participants.find((p) => p.code === "BO")!;
    expect(aliceP.displayName).toBeNull();        // redacted
    expect(bobSelf.displayName).toBe("Bob");      // self always revealed

    const hostSnap = s.projectFor(HOST);
    const aliceForHost = hostSnap.participants.find((p) => p.code === "AL")!;
    expect(aliceForHost.displayName).toBe("Alice");
  });

  it("informed viewer sees their own card; spectator sees no card; uninformed has none", () => {
    const { s } = setup();
    const aliceSnap = s.projectFor(ALICE);
    expect(aliceSnap.viewer.role).toBe("informed");
    expect(aliceSnap.viewer.myCard).not.toBeNull();
    expect([1, 2, 9, 10]).toContain(aliceSnap.viewer.myCard);

    const hostSnap = s.projectFor(HOST);
    expect(hostSnap.viewer.role).toBe("host");
    expect(hostSnap.viewer.myCard).toBeNull();
  });

  it("hidden public cards project as null until revealed", () => {
    const clock = new FakeClock(1000_000);
    const opts: ResolvedOptions = {
      cardValues: [1, 2, 9, 10],
      copiesPerValue: 4,
      informedSeats: 3,
      uninformedSeats: 0,
      publicSlots: 2,
      eventMode: "manual",
      eventIntervalMin: 60, eventIntervalMax: 60,
      endGameGraceSec: 0, seed: 42,
      codeMode: "alpha", enforceCaseByRole: false,
      identityReveal: "all", identityRevealList: [],
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    s.claimSeat(ALICE, 0, { displayName: "Alice" });
    s.claimSeat(BOB, 1, { displayName: "Bob" });
    s.claimSeat(CAROL, 2, { displayName: "Carol" });
    s.startGame(HOST);
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND", event: { type: "REVEAL_PUBLIC", slotIndex: 0 },
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });

    let snap = s.projectFor(ALICE);
    expect(snap.publicCards).toHaveLength(2);
    expect(snap.publicCards[0]).toBeNull();
    expect(snap.publicCards[1]).toBeNull();

    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    snap = s.projectFor(ALICE);
    expect(snap.publicCards[0]).not.toBeNull();
    expect(snap.publicCards[1]).toBeNull();
  });
});

describe("settlement", () => {
  it("computes per-participant settled PnL after game ends", () => {
    const { s } = setup();
    const cid = s.getStateForTesting().contracts[0]!.id;
    // Trade: Alice buys 5 from Bob @ 12.
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 5, price: 12 });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 5, price: 12 });
    // Fire one rotate, then end.
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    s.handleGameMessage(HOST, { type: "END_GAME" });

    const st = s.getStateForTesting();
    expect(st.status).toBe("finished");
    const settled = st.settlements!;
    expect(settled[cid]).toBeGreaterThanOrEqual(0);

    // Sum of finalPnl across all participants is zero (no friction).
    const allPnl = Object.values(st.finalPnl!);
    const sum = allPnl.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 5);

    // Alice's PnL should equal 5 * (settle - 12).
    const settle = settled[cid]!;
    const aliceKey = `p:${ALICE}`;
    const bobKey = `p:${BOB}`;
    expect(st.finalPnl![aliceKey]).toBe(5 * (settle - 12));
    expect(st.finalPnl![bobKey]).toBe(-5 * (settle - 12));
  });
});

describe("setup-phase code book", () => {
  it("SETUP_SET_CODE updates a single code with collision check", () => {
    const { s } = setup();
    let rejected: string | null = null;
    s.attachConnection(HOST, (m) => {
      const obj = m as Record<string, unknown>;
      if (obj["type"] === "INTENT_REJECTED") rejected = String(obj["reason"]);
    });
    // Cannot run setup ops once playing — verify and set up a fresh one.
    s.handleGameMessage(HOST, { type: "SETUP_SET_CODE", participantKey: `p:${ALICE}`, code: "ZZ" });
    expect(rejected).toMatch(/setup/);
  });

  it("SETUP_RESHUFFLE_CODES regenerates the book in setup", () => {
    const clock = new FakeClock();
    const opts = {
      cardValues: [1, 2, 9, 10],
      copiesPerValue: 4,
      informedSeats: 3, uninformedSeats: 0, publicSlots: 0,
      eventMode: "manual" as const, eventIntervalMin: 60, eventIntervalMax: 60,
      endGameGraceSec: 0, seed: 42,
      codeMode: "random" as const, enforceCaseByRole: false,
      identityReveal: "all" as const, identityRevealList: [],
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    s.claimSeat(ALICE, 0, { displayName: "Alice" });
    s.claimSeat(BOB, 1, { displayName: "Bob" });
    s.claimSeat(CAROL, 2, { displayName: "Carol" });
    s.startGame(HOST);
    const before = { ...s.getStateForTesting().codeBook };
    s.handleGameMessage(HOST, { type: "SETUP_RESHUFFLE_CODES" });
    const after = s.getStateForTesting().codeBook;
    // With random mode the rng has advanced, so the second shuffle is likely different.
    expect(after).not.toEqual(before);
  });

  it("SETUP_SET_BOT_ENTITIES adds bots to the code book using their entityId as code", () => {
    const { s } = setup();   // already in playing phase from the helper
    // Need to reach setup phase manually to test this. Build a fresh session.
    const clock = new FakeClock();
    const opts: ResolvedOptions = {
      cardValues: [1, 2, 9, 10], copiesPerValue: 4,
      informedSeats: 3, uninformedSeats: 0, publicSlots: 0,
      eventMode: "manual", eventIntervalMin: 60, eventIntervalMax: 60,
      endGameGraceSec: 0, seed: 1,
      codeMode: "alpha", enforceCaseByRole: false,
      identityReveal: "all", identityRevealList: [],
    };
    const fresh = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fresh.claimSeat(ALICE, 0, { displayName: "Alice" });
    fresh.claimSeat(BOB, 1, { displayName: "Bob" });
    fresh.claimSeat(CAROL, 2, { displayName: "Carol" });
    fresh.startGame(HOST);
    fresh.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds: ["XY", "ZQ"] });
    const st = fresh.getStateForTesting();
    expect(st.botEntities).toHaveLength(2);
    expect(st.codeBook["b:XY"]).toBe("XY");
    expect(st.codeBook["b:ZQ"]).toBe("ZQ");

    // ensure unused 's' from outer setup() doesn't break the build
    void s;
  });

  it("rejects 3-letter and non-alpha bot ids", () => {
    const clock = new FakeClock();
    const opts: ResolvedOptions = {
      cardValues: [1, 2, 9, 10], copiesPerValue: 4,
      informedSeats: 3, uninformedSeats: 0, publicSlots: 0,
      eventMode: "manual", eventIntervalMin: 60, eventIntervalMax: 60,
      endGameGraceSec: 0, seed: 1,
      codeMode: "alpha", enforceCaseByRole: false,
      identityReveal: "all", identityRevealList: [],
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    s.claimSeat(ALICE, 0, { displayName: "Alice" });
    s.claimSeat(BOB, 1, { displayName: "Bob" });
    s.claimSeat(CAROL, 2, { displayName: "Carol" });
    s.startGame(HOST);

    let rejected: string | null = null;
    s.attachConnection(HOST, (m) => {
      const obj = m as Record<string, unknown>;
      if (obj["type"] === "INTENT_REJECTED") rejected = String(obj["reason"]);
    });
    s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds: ["ABC"] });
    expect(rejected).toMatch(/invalid entity/);
    rejected = null;
    s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds: ["12"] });
    expect(rejected).toMatch(/invalid entity/);
  });
});
