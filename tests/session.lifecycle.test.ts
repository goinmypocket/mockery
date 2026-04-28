// =============================================================================
// End-to-end lifecycle: lobby → setup → playing → finished.
//
// Uses FakeClock so we can fast-forward through auto-mode timers without
// real wall-clock waits.
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
const DAVE = asUserId("dave-uid");
const EVE = asUserId("eve-uid");

function defaultOpts(): ResolvedOptions {
  return {
    cardValues: [1, 2, 9, 10],
    copiesPerValue: 4,
    informedSeats: 6,
    uninformedSeats: 0,
    publicSlots: 3,
    eventMode: "auto",
    eventIntervalMin: 60,
    eventIntervalMax: 60,    // fixed for testability
    endGameGraceSec: 0,
    seed: 1,
    codeMode: "alpha",
    enforceCaseByRole: false,
    identityReveal: "all",
    identityRevealList: [],
  };
}

function fillSeats(s: MockerySession, users: UserId[], names: string[]) {
  for (let i = 0; i < users.length; i++) {
    expect(s.claimSeat(users[i]!, i, { displayName: names[i]! })).toEqual({ ok: true });
  }
}

describe("MockerySession lifecycle", () => {
  it("rejects start before all seats filled", () => {
    const clock = new FakeClock();
    const s = new MockerySession({
      tableId: asTableId("t1"),
      hostUserId: HOST,
      options: { ...defaultOpts(), informedSeats: 2, uninformedSeats: 0 },
      clock,
    });
    s.claimSeat(ALICE, 0);
    expect(s.startGame(HOST).ok).toBe(false);
  });

  it("rejects start by non-host", () => {
    const clock = new FakeClock();
    const s = new MockerySession({
      tableId: asTableId("t1"),
      hostUserId: HOST,
      options: { ...defaultOpts(), informedSeats: 2, uninformedSeats: 0 },
      clock,
    });
    s.claimSeat(ALICE, 0);
    s.claimSeat(BOB, 1);
    expect(s.startGame(ALICE).ok).toBe(false);
  });

  it("transitions lobby → setup, generates a code book, and reports playing to platform", () => {
    const clock = new FakeClock();
    const opts = { ...defaultOpts(), informedSeats: 3, uninformedSeats: 0 };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);

    expect(s.describe().status).toBe("lobby");
    expect(s.startGame(HOST).ok).toBe(true);
    expect(s.describe().status).toBe("playing");                 // platform-side; engine status is "setup"
    const st = s.getStateForTesting();
    expect(st.status).toBe("setup");
    expect(Object.keys(st.codeBook)).toHaveLength(3);
    expect(st.codeBook[`p:${ALICE}`]).toBe("AL");
    expect(st.codeBook[`p:${BOB}`]).toBe("BO");
    expect(st.codeBook[`p:${CAROL}`]).toBe("CA");
  });

  it("setup phase: add contracts, queue events, start trading", () => {
    const clock = new FakeClock();
    const opts = { ...defaultOpts(), informedSeats: 3, uninformedSeats: 0, publicSlots: 2 };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);
    s.startGame(HOST);

    // Add a contract
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT",
      name: "Sum", description: "sum of cards",
      payoffSource: "return H.sum(cards);",
    });
    // Queue an event
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND",
      event: { type: "REVEAL_PUBLIC", slotIndex: null },
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND",
      event: { type: "ROTATE_INFORMED" },
    });

    // Start trading
    s.handleGameMessage(HOST, { type: "START_TRADING" });
    const st = s.getStateForTesting();
    expect(st.status).toBe("playing");
    expect(st.contracts).toHaveLength(1);
    expect(st.eventQueue).toHaveLength(2);
    expect(st.informedCards).toHaveLength(3);
    expect(st.publicCards).toHaveLength(2);
    expect(st.publicRevealed).toEqual([false, false]);
  });

  it("rejects START_TRADING when contracts list is empty or queue is empty", () => {
    const clock = new FakeClock();
    const opts = { ...defaultOpts(), informedSeats: 3, uninformedSeats: 0, publicSlots: 2 };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);
    s.startGame(HOST);

    // No contract: rejected.
    let rejected: string | null = null;
    s.attachConnection(HOST, (m: unknown) => {
      const obj = m as Record<string, unknown>;
      if (obj["type"] === "INTENT_REJECTED") rejected = String(obj["reason"]);
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });
    expect(rejected).toMatch(/no contracts/);

    // With contract but empty queue: still rejected.
    rejected = null;
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });
    expect(rejected).toMatch(/queue empty/);
  });

  it("auto mode fires queued events on the timer and settles after queue empties", () => {
    const clock = new FakeClock(1000_000);
    const opts = { ...defaultOpts(), informedSeats: 3, uninformedSeats: 0, publicSlots: 2 };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);
    s.startGame(HOST);
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND", event: { type: "REVEAL_PUBLIC", slotIndex: null },
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });

    // 60s in: first event (reveal slot 0) fires.
    clock.advance(60_000);
    let st = s.getStateForTesting();
    expect(st.publicRevealed[0]).toBe(true);
    expect(st.eventQueue).toHaveLength(0);
    expect(st.phase).toBe(1);
    expect(st.status).toBe("playing");

    // Another 60s in: end-of-game timer fires and settles.
    clock.advance(60_000);
    st = s.getStateForTesting();
    expect(st.status).toBe("finished");
    expect(st.settlements).not.toBeNull();
    expect(st.finalPnl).not.toBeNull();
  });

  it("manual mode: FIRE_NEXT_EVENT advances queue; END_GAME settles when queue empty", () => {
    const clock = new FakeClock();
    const opts: ResolvedOptions = {
      ...defaultOpts(),
      informedSeats: 3, uninformedSeats: 0, publicSlots: 2,
      eventMode: "manual",
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);
    s.startGame(HOST);
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND", event: { type: "REVEAL_PUBLIC", slotIndex: null },
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });

    // No timer should be armed in manual mode.
    expect(clock.pendingTaskCount()).toBe(0);

    // FIRE_NEXT_EVENT advances.
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
    let st = s.getStateForTesting();
    expect(st.phase).toBe(1);
    expect(st.eventQueue).toHaveLength(0);

    // END_GAME with empty queue settles.
    let rejected: string | null = null;
    s.attachConnection(HOST, (m: unknown) => {
      const obj = m as Record<string, unknown>;
      if (obj["type"] === "INTENT_REJECTED") rejected = String(obj["reason"]);
    });
    s.handleGameMessage(HOST, { type: "END_GAME" });
    expect(rejected).toBeNull();
    st = s.getStateForTesting();
    expect(st.status).toBe("finished");
  });

  it("manual mode: END_GAME with non-empty queue is rejected", () => {
    const clock = new FakeClock();
    const opts: ResolvedOptions = {
      ...defaultOpts(),
      informedSeats: 3, uninformedSeats: 0, publicSlots: 2,
      eventMode: "manual",
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);
    s.startGame(HOST);
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND", event: { type: "REVEAL_PUBLIC", slotIndex: null },
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });

    let rejected: string | null = null;
    s.attachConnection(HOST, (m: unknown) => {
      const obj = m as Record<string, unknown>;
      if (obj["type"] === "INTENT_REJECTED") rejected = String(obj["reason"]);
    });
    s.handleGameMessage(HOST, { type: "END_GAME" });
    expect(rejected).toMatch(/queue must be empty/);
    expect(s.getStateForTesting().status).toBe("playing");
  });

  it("manual-mode grace timer settles on fire", () => {
    const clock = new FakeClock();
    const opts: ResolvedOptions = {
      ...defaultOpts(),
      informedSeats: 3, uninformedSeats: 0, publicSlots: 0,   // no public slots → all events optional
      eventMode: "manual",
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);
    s.startGame(HOST);
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" },
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });
    s.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });

    s.handleGameMessage(HOST, { type: "START_GRACE_TIMER", seconds: 30 });
    expect(s.getStateForTesting().status).toBe("playing");

    clock.advance(30_000);
    expect(s.getStateForTesting().status).toBe("finished");
  });

  it("auto-mode PREPONE_NEXT_EVENT fires immediately and re-arms", () => {
    const clock = new FakeClock(1000_000);
    const opts: ResolvedOptions = {
      ...defaultOpts(),
      informedSeats: 3, uninformedSeats: 0, publicSlots: 2,
      eventIntervalMin: 60, eventIntervalMax: 60,
    };
    const s = new MockerySession({ tableId: asTableId("t1"), hostUserId: HOST, options: opts, clock });
    fillSeats(s, [ALICE, BOB, CAROL], ["Alice", "Bob", "Carol"]);
    s.startGame(HOST);
    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND", event: { type: "REVEAL_PUBLIC", slotIndex: 0 },
    });
    s.handleGameMessage(HOST, {
      type: "SETUP_QUEUE_APPEND", event: { type: "REVEAL_PUBLIC", slotIndex: 1 },
    });
    s.handleGameMessage(HOST, { type: "START_TRADING" });
    expect(s.getStateForTesting().phase).toBe(0);

    s.handleGameMessage(HOST, { type: "PREPONE_NEXT_EVENT" });
    const st = s.getStateForTesting();
    expect(st.phase).toBe(1);
    expect(st.publicRevealed[0]).toBe(true);
    expect(st.eventQueue).toHaveLength(1);
    expect(st.status).toBe("playing");
    expect(st.nextEventAt).not.toBeNull();
  });
});
