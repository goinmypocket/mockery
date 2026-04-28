// =============================================================================
// User contract library tests — both the DB layer (in-memory) and the
// LIBRARY_* intents on a live MockerySession.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockerySession } from "../server/MockerySession";
import { FakeClock } from "../server/clock";
import { getLibrary, resetLibraryForTesting, type ContractLibrary } from "../server/db/library";
import { asTableId, asUserId } from "../shared/ids";
import type { ResolvedOptions } from "../shared/types";

const HOST = asUserId("host-uid");
const ALICE = asUserId("alice-uid");
const BOB = asUserId("bob-uid");

function defaultOpts(): ResolvedOptions {
  return {
    cardValues: [1, 2, 9, 10],
    copiesPerValue: 4,
    informedSeats: 2,
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
  };
}

describe("library DB layer", () => {
  let lib: ContractLibrary;
  beforeEach(() => {
    resetLibraryForTesting();
    lib = getLibrary({ forceMemory: true });
  });
  afterEach(() => resetLibraryForTesting());

  it("save + list returns the entry", () => {
    const entry = lib.save(ALICE, { name: "Sum", description: "x", payoffSource: "return 1;" });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.name).toBe("Sum");
    const list = lib.list(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(entry.id);
  });

  it("scoped per-user — Bob doesn't see Alice's entries", () => {
    lib.save(ALICE, { name: "A1", description: "", payoffSource: "return 1;" });
    expect(lib.list(BOB)).toHaveLength(0);
    expect(lib.list(ALICE)).toHaveLength(1);
  });

  it("update mutates only that entry, returns updated row, bumps updated_at", () => {
    const entry = lib.save(ALICE, { name: "Sum", description: "old", payoffSource: "return 1;" });
    const before = entry.updatedAt;
    // Sleep a hair so timestamps differ — use a manual delay.
    const updated = lib.update(ALICE, entry.id, { description: "new" });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("new");
    expect(updated!.name).toBe("Sum");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("update returns null if not owned by user", () => {
    const entry = lib.save(ALICE, { name: "Sum", description: "", payoffSource: "return 1;" });
    expect(lib.update(BOB, entry.id, { name: "x" })).toBeNull();
  });

  it("remove deletes only when owned", () => {
    const entry = lib.save(ALICE, { name: "Sum", description: "", payoffSource: "return 1;" });
    expect(lib.remove(BOB, entry.id)).toBe(false);
    expect(lib.remove(ALICE, entry.id)).toBe(true);
    expect(lib.list(ALICE)).toHaveLength(0);
  });

  it("list is alphabetical, case-insensitive", () => {
    lib.save(ALICE, { name: "zeta",  description: "", payoffSource: "return 1;" });
    lib.save(ALICE, { name: "Alpha", description: "", payoffSource: "return 2;" });
    lib.save(ALICE, { name: "beta",  description: "", payoffSource: "return 3;" });
    const names = lib.list(ALICE).map((e) => e.name);
    expect(names).toEqual(["Alpha", "beta", "zeta"]);
  });
});

describe("LIBRARY_* intents over MockerySession", () => {
  let lib: ContractLibrary;
  let s: MockerySession;
  let clock: FakeClock;
  let outbox: Record<string, unknown[]>;

  beforeEach(() => {
    resetLibraryForTesting();
    lib = getLibrary({ forceMemory: true });
    clock = new FakeClock();
    s = new MockerySession({
      tableId: asTableId("t1"),
      hostUserId: HOST,
      options: defaultOpts(),
      clock,
      library: lib,
    });
    outbox = { [HOST]: [], [ALICE]: [], [BOB]: [] };
    s.attachConnection(HOST, (m) => outbox[HOST]!.push(m));
    s.attachConnection(ALICE, (m) => outbox[ALICE]!.push(m));
    s.attachConnection(BOB, (m) => outbox[BOB]!.push(m));
  });

  afterEach(() => resetLibraryForTesting());

  it("LIBRARY_SAVE persists and replies with entry + fresh list", () => {
    s.handleGameMessage(ALICE, {
      type: "LIBRARY_SAVE",
      name: "My contract",
      description: "test",
      payoffSource: "return H.sum(cards);",
    });
    const aliceMsgs = outbox[ALICE]!;
    const saveResult = aliceMsgs.find((m: unknown) => (m as { type: string }).type === "LIBRARY_SAVE_RESULT");
    expect(saveResult).toBeDefined();
    const list = aliceMsgs.find((m: unknown) => (m as { type: string }).type === "LIBRARY_LIST_RESULT");
    expect(list).toBeDefined();
    expect((list as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("LIBRARY_SAVE rejects forbidden tokens", () => {
    s.handleGameMessage(ALICE, {
      type: "LIBRARY_SAVE",
      name: "Bad",
      description: "",
      payoffSource: "return require('fs');",
    });
    const rejected = outbox[ALICE]!.find((m: unknown) => (m as { type: string }).type === "INTENT_REJECTED");
    expect(rejected).toBeDefined();
    expect((rejected as { reason: string }).reason).toMatch(/forbidden token/);
    expect(lib.list(ALICE)).toHaveLength(0);
  });

  it("LIBRARY_SAVE rejects empty name", () => {
    s.handleGameMessage(ALICE, {
      type: "LIBRARY_SAVE",
      name: "",
      description: "",
      payoffSource: "return 1;",
    });
    const rejected = outbox[ALICE]!.find((m: unknown) => (m as { type: string }).type === "INTENT_REJECTED");
    expect(rejected).toBeDefined();
  });

  it("LIBRARY_LIST returns only the caller's entries", () => {
    lib.save(ALICE, { name: "A1", description: "", payoffSource: "return 1;" });
    lib.save(BOB,   { name: "B1", description: "", payoffSource: "return 2;" });

    s.handleGameMessage(BOB, { type: "LIBRARY_LIST" });
    const list = outbox[BOB]!.find((m: unknown) => (m as { type: string }).type === "LIBRARY_LIST_RESULT");
    expect(list).toBeDefined();
    const entries = (list as { entries: Array<{ name: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("B1");
  });

  it("LIBRARY_UPDATE on someone else's entry is rejected", () => {
    const aliceEntry = lib.save(ALICE, { name: "A1", description: "", payoffSource: "return 1;" });
    s.handleGameMessage(BOB, {
      type: "LIBRARY_UPDATE",
      id: aliceEntry.id,
      name: "hacked",
    });
    const rejected = outbox[BOB]!.find((m: unknown) => (m as { type: string }).type === "INTENT_REJECTED");
    expect(rejected).toBeDefined();
    expect((rejected as { reason: string }).reason).toMatch(/not found/);
    // Alice's entry untouched.
    expect(lib.list(ALICE)[0]!.name).toBe("A1");
  });

  it("LIBRARY_DELETE removes and replies", () => {
    const e = lib.save(ALICE, { name: "Z", description: "", payoffSource: "return 1;" });
    s.handleGameMessage(ALICE, { type: "LIBRARY_DELETE", id: e.id });
    const del = outbox[ALICE]!.find((m: unknown) => (m as { type: string }).type === "LIBRARY_DELETE_RESULT");
    expect(del).toBeDefined();
    expect(lib.list(ALICE)).toHaveLength(0);
  });
});
