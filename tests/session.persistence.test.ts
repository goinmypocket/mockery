// =============================================================================
// Save/load round-trip — serialize() must capture enough state that a
// freshly hydrated session resumes the same trades, books, timers, and
// final settlement.
// =============================================================================

import { describe, expect, it } from "vitest";
import { MockerySession, type MockerySave } from "../server/MockerySession";
import { FakeClock } from "../server/clock";
import { def } from "../definition";
import { asTableId, asUserId } from "../shared/ids";
import type { ResolvedOptions } from "../shared/types";

const HOST = asUserId("host-uid");
const ALICE = asUserId("alice-uid");
const BOB = asUserId("bob-uid");
const CAROL = asUserId("carol-uid");

it("exposes exact saved participant IDs for table access migration", () => {
  const session = new MockerySession({ tableId: asTableId("table"), hostUserId: HOST, options: makeOpts(), clock: new FakeClock() });
  session.claimSeat(ALICE, 0, { displayName: "Same name" });
  session.claimSeat(BOB, 1, { displayName: "Same name" });
  expect(def.savedParticipants!(session.serialize())).toEqual([
    { seatIndex: 0, userId: ALICE, displayName: "Same name" },
    { seatIndex: 1, userId: BOB, displayName: "Same name" },
  ]);
});

function makeOpts(overrides: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    cardValues: [1, 2, 9, 10],
    copiesPerValue: 4,
    informedSeats: 3,
    uninformedSeats: 0,
    publicSlots: 0,
    eventMode: "manual",
    eventIntervalMin: 60,
    eventIntervalMax: 60,
    endGameGraceSec: 0,
    seed: 42,
    codeMode: "alpha",
    enforceCaseByRole: false,
    identityReveal: "all",
    identityRevealList: [],
    ...overrides,
  };
}

function bringUpToPlaying(opts: ResolvedOptions, clock: FakeClock): MockerySession {
  const s = new MockerySession({
    tableId: asTableId("t1"),
    hostUserId: HOST,
    options: opts,
    clock,
  });
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
  return s;
}

/** Round-trip a save through JSON to mirror what disk persistence does. */
function roundTrip(s: MockerySession): MockerySave {
  return JSON.parse(JSON.stringify(s.serialize())) as MockerySave;
}

function rebuildAt(blob: MockerySave, clock: FakeClock): MockerySession {
  const s = new MockerySession({
    tableId: asTableId("t1"),
    hostUserId: blob.hostUserId,
    options: blob.options,
    clock,
  });
  s.hydrate(blob);
  return s;
}

describe("save/load — lobby phase", () => {
  it("preserves seats and display names", () => {
    const clock = new FakeClock(1000);
    const s = new MockerySession({
      tableId: asTableId("t1"), hostUserId: HOST,
      options: makeOpts(), clock,
    });
    s.claimSeat(ALICE, 0, { displayName: "Alice" });
    s.claimSeat(BOB, 1, { displayName: "Bob" });

    const blob = roundTrip(s);
    expect(blob.status).toBe("lobby");

    const s2 = rebuildAt(blob, new FakeClock(1000));
    const desc = s2.describe();
    expect(desc.status).toBe("lobby");
    expect(desc.playerCount).toBe(2);
    // Re-claim from saved blob — must match what we set up.
    const st = s2.getEngineState();
    expect(st.seats[0]).toBe(ALICE);
    expect(st.seats[1]).toBe(BOB);
  });
});

describe("save/load — playing phase", () => {
  it("preserves trades, books, positions, and cash", () => {
    const clock = new FakeClock(1_000_000);
    const s = bringUpToPlaying(makeOpts(), clock);
    const cid = s.getEngineState().contracts[0]!.id;

    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 5, price: 12 });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 3, price: 14 });
    // Leave a resting bid so we can verify cancel works post-load.
    s.handleGameMessage(CAROL, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 1, price:  9 });

    const before = s.getEngineState();
    const tradesBefore = before.trades.length;
    const cashBefore = { ...before.cash };
    const positionsBefore = JSON.parse(JSON.stringify(before.positions));
    const restingOrderId = before.books[cid]!.bids[0]!.orders[0]!.id;

    const blob = roundTrip(s);
    expect(blob.status).toBe("playing");

    const s2 = rebuildAt(blob, new FakeClock(1_000_000));
    const after = s2.getEngineState();
    expect(after.trades.length).toBe(tradesBefore);
    expect(after.trades[0]!.price).toBe(12);
    expect(after.cash).toEqual(cashBefore);
    expect(after.positions).toEqual(positionsBefore);
    expect(after.books[cid]!.lastTradePrice).toBe(12);

    // The restored book's ordersById must point at the SAME order
    // reference as the price-level entry — otherwise cancel() can't
    // find/mutate the resting order and qty changes diverge.
    const restored = after.books[cid]!;
    const fromMap = restored.ordersById[restingOrderId];
    const fromLevel = restored.bids[0]!.orders[0]!;
    expect(fromMap).toBe(fromLevel);

    // Cancellation of a pre-load order must work.
    s2.handleGameMessage(CAROL, { type: "CANCEL_ORDER", orderId: restingOrderId });
    expect(s2.getEngineState().books[cid]!.bids).toHaveLength(0);
    expect(s2.getEngineState().books[cid]!.offers).toHaveLength(1); // Bob's leftover
  });

  it("preserves rng state — same seed continues identical random draws", () => {
    const clock = new FakeClock(0);
    const s = bringUpToPlaying(makeOpts({ eventMode: "auto" }), clock);
    // After START_TRADING auto-mode armed a timer using the rng. Now
    // burn one more rng draw on the original by fast-forwarding to the
    // event firing.
    const beforeBlob = roundTrip(s);

    const a = rebuildAt(beforeBlob, new FakeClock(clock.now()));
    const b = rebuildAt(beforeBlob, new FakeClock(clock.now()));

    // Forcing a queue change on auto causes armNextEventTimer → randomInt
    // to consume rng state. Both clones should produce the same target.
    a.handleGameMessage(HOST, { type: "QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } });
    b.handleGameMessage(HOST, { type: "QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } });
    expect(a.getEngineState().nextEventAt).toBe(b.getEngineState().nextEventAt);
  });

  it("re-arms the auto-mode event timer with the saved wallclock target", () => {
    const clock = new FakeClock(1_000_000);
    const s = bringUpToPlaying(makeOpts({ eventMode: "auto" }), clock);
    // Auto mode armed a timer at startedAt + 60s = 1_060_000.
    const blob = roundTrip(s);
    expect(blob.nextEventAt).toBe(1_060_000);

    // Re-hydrate at t=1_030_000 — 30s into the original interval.
    const lateClock = new FakeClock(1_030_000);
    const s2 = rebuildAt(blob, lateClock);
    expect(s2.getEngineState().nextEventAt).toBe(1_060_000);

    // Advancing 30s more must fire the queued event.
    lateClock.advance(30_000);
    // After firing, queue is empty so endTimer arms; the rotate-informed
    // event has incremented phase and consumed the queue head.
    expect(s2.getEngineState().eventQueue).toHaveLength(0);
    expect(s2.getEngineState().phase).toBeGreaterThan(0);
  });

  it("re-arms the manual-mode grace timer", () => {
    const clock = new FakeClock(1_000_000);
    const s = bringUpToPlaying(makeOpts({ eventMode: "manual" }), clock);
    // Drain the queue so END_GAME / grace timer is meaningful.
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    s.handleGameMessage(HOST, { type: "START_GRACE_TIMER", seconds: 30 });
    expect(s.getEngineState().graceTimerEndsAt).toBe(1_030_000);

    const blob = roundTrip(s);
    const lateClock = new FakeClock(1_010_000);
    const s2 = rebuildAt(blob, lateClock);
    expect(s2.getEngineState().graceTimerEndsAt).toBe(1_030_000);
    expect(s2.getEngineState().status).toBe("playing");

    lateClock.advance(20_000);
    expect(s2.getEngineState().status).toBe("finished");
    expect(s2.getEngineState().settlements).not.toBeNull();
  });
});

describe("save/load — finished phase", () => {
  it("preserves settlements and final pnl", () => {
    const clock = new FakeClock(1_000_000);
    const s = bringUpToPlaying(makeOpts({ eventMode: "manual" }), clock);
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" }); // drain queue
    s.handleGameMessage(HOST, { type: "END_GAME" });

    const before = s.getEngineState();
    expect(before.status).toBe("finished");
    const settlementsBefore = before.settlements;
    const pnlBefore = before.finalPnl;

    const blob = roundTrip(s);
    const s2 = rebuildAt(blob, new FakeClock(2_000_000));
    const after = s2.getEngineState();
    expect(after.status).toBe("finished");
    expect(after.settlements).toEqual(settlementsBefore);
    expect(after.finalPnl).toEqual(pnlBefore);
  });
});

describe("save/load — round-trip is idempotent", () => {
  it("serialize → load → serialize yields the same blob", () => {
    const clock = new FakeClock(1_000_000);
    const s = bringUpToPlaying(makeOpts(), clock);
    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 5, price: 12 });
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 3, price: 14 });

    const blob1 = roundTrip(s);
    const s2 = rebuildAt(blob1, new FakeClock(1_000_000));
    const blob2 = roundTrip(s2);
    expect(blob2).toEqual(blob1);
  });
});
