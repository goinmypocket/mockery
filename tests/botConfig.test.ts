// =============================================================================
// drawProfiles — turning BotConfigSpec (distributions) into concrete
// Profiles. End-to-end test wires the drawn profiles through
// multiProfileBot and the orchestrator to confirm they're runnable.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  drawProfiles, drawProfilesFromWire, resolveWireSpec,
  type BotConfigSpec, type WireBotConfigSpec,
} from "../server/bots/config";
import { multiProfileBot } from "../server/bots/spawning";
import { BotOrchestrator } from "../server/bots/runtime";
import { MockerySession } from "../server/MockerySession";
import { FakeClock } from "../server/clock";
import naturalPlayer from "../server/bots/strategies/natural-player";
import { makeRng } from "../engine/rng";
import { asTableId, asUserId } from "../shared/ids";
import { participantKey, type ResolvedOptions } from "../shared/types";
import type { BotStrategy } from "../server/bots/api";

const HOST = asUserId("host");
const ALICE = asUserId("alice");
const BOB = asUserId("bob");
const CAROL = asUserId("carol");

const noop: BotStrategy = { id: "noop-cfg", displayName: "noop" };

describe("drawProfiles", () => {
  it("draws `count` profiles per StrategySpec", () => {
    const spec: BotConfigSpec = {
      strategies: [
        { strategy: noop, count: { kind: "constant", value: 3 },
          spawn: { mode: "permanent" }, lagMs: { kind: "constant", value: 0 },
          scope: "instance", params: {} },
        { strategy: noop, count: { kind: "constant", value: 2 },
          spawn: { mode: "poisson", ratePerSec: { kind: "constant", value: 1 } },
          lagMs: { kind: "constant", value: 0 },
          scope: "shared", params: {} },
      ],
    };
    const profiles = drawProfiles(spec, makeRng(1));
    expect(profiles).toHaveLength(5);
    expect(profiles.slice(0, 3).every((p) => p.spawn.mode === "permanent")).toBe(true);
    expect(profiles.slice(3).every((p) => p.spawn.mode === "poisson")).toBe(true);
  });

  it("count of 0 emits no profiles", () => {
    const spec: BotConfigSpec = {
      strategies: [{ strategy: noop, count: { kind: "constant", value: 0 },
        spawn: { mode: "permanent" }, lagMs: { kind: "constant", value: 0 },
        scope: "instance", params: {} }],
    };
    expect(drawProfiles(spec, makeRng(1))).toHaveLength(0);
  });

  it("draws per-profile params independently", () => {
    const spec: BotConfigSpec = {
      strategies: [{
        strategy: noop, count: { kind: "constant", value: 4 },
        spawn: { mode: "permanent" }, lagMs: { kind: "constant", value: 100 },
        scope: "instance",
        params: { targetQty: { kind: "uniform-int", min: 1, max: 100 } },
      }],
    };
    const profiles = drawProfiles(spec, makeRng(42));
    const targets = profiles.map((p) => p.params.targetQty as number);
    // 4 draws from a 100-wide uniform; collisions are unlikely on most seeds.
    expect(new Set(targets).size).toBeGreaterThan(1);
  });

  it("same seed → identical Profile[] (replay determinism)", () => {
    const spec: BotConfigSpec = {
      strategies: [{
        strategy: noop,
        count: { kind: "uniform-int", min: 2, max: 6 },
        spawn: { mode: "poisson", ratePerSec: { kind: "exponential", rate: 1 } },
        lagMs: { kind: "uniform-int", min: 0, max: 500 },
        scope: "instance",
        params: { x: { kind: "gaussian", mean: 0, std: 1 } },
      }],
    };
    const a = drawProfiles(spec, makeRng(123));
    const b = drawProfiles(spec, makeRng(123));
    expect(a).toEqual(b);
  });

  it("Poisson rate is non-negative even with skewed distributions", () => {
    const spec: BotConfigSpec = {
      strategies: [{
        strategy: noop, count: { kind: "constant", value: 5 },
        spawn: { mode: "poisson", ratePerSec: { kind: "gaussian", mean: 0, std: 5 } },
        lagMs: { kind: "constant", value: 0 },
        scope: "instance", params: {},
      }],
    };
    const profiles = drawProfiles(spec, makeRng(1));
    for (const p of profiles) {
      if (p.spawn.mode !== "poisson") throw new Error("expected poisson");
      expect(p.spawn.ratePerSec).toBeGreaterThanOrEqual(0);
    }
  });

  it("end-to-end: drawn profiles run under multiProfileBot in a real session", () => {
    const spec: BotConfigSpec = {
      strategies: [{
        strategy: naturalPlayer,
        count: { kind: "constant", value: 2 },
        spawn: { mode: "permanent" },
        lagMs: { kind: "constant", value: 0 },
        scope: "instance",
        params: {
          targetQty: { kind: "categorical", choices: [
            { value: 3, weight: 1 }, { value: 4, weight: 1 },
          ]},
          tightSpreadFrac: { kind: "constant", value: 0.5 },
          widthInitTicks: { kind: "constant", value: 3 },
          historicMedianGuard: { kind: "constant", value: 1.5 },
          urgencyDecayPerSec: { kind: "constant", value: 0 },
          idleSecondsBeforeDecay: { kind: "constant", value: 1 },
          urgentPennyIntervalMs: { kind: "constant", value: 1000 },
          panicThreshold: { kind: "constant", value: 1.5 },
          panicEmaHalfLifeSec: { kind: "constant", value: 5 },
        },
      }],
    };

    const clock = new FakeClock(1_000_000);
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
    s.claimSeat(BOB,   1, { displayName: "Bob" });
    s.claimSeat(CAROL, 2, { displayName: "Carol" });
    s.startGame(HOST);

    const profiles = drawProfiles(spec, makeRng(7));
    expect(profiles).toHaveLength(2);
    const bot = multiProfileBot({ seed: 1, profiles });
    new BotOrchestrator(s, clock, { "multi-profile": bot });

    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, { type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } });
    s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds: ["XY"] });
    s.handleGameMessage(HOST, { type: "SETUP_BIND_BOT_STRATEGY", entityId: "XY", strategyId: "multi-profile" });
    s.handleGameMessage(HOST, { type: "START_TRADING" });

    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy", qty: 10, price: 95 });
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 20, price: 105 });
    clock.advance(100);

    // Both drawn profiles should have filled their (concrete) targetQty,
    // summing into the bot's position. With categorical choices {3, 4},
    // total is 3+3, 3+4, 4+3, or 4+4 = 6, 7, 7, 8.
    const botKey = participantKey({ kind: "bot", entityId: "XY" });
    const pos = s.getEngineState().positions[botKey]?.[cid] ?? 0;
    expect([6, 7, 8]).toContain(pos);
  });
});

describe("WireBotConfigSpec / resolveWireSpec", () => {
  const wire: WireBotConfigSpec = {
    strategies: [{
      strategyId: "noop-cfg",
      count: { kind: "constant", value: 2 },
      spawn: { mode: "permanent" },
      lagMs: { kind: "constant", value: 0 },
      scope: "instance",
      params: {},
    }],
  };

  it("resolves strategyId via registry", () => {
    const resolved = resolveWireSpec(wire, { "noop-cfg": noop });
    expect(resolved.strategies[0]!.strategy).toBe(noop);
  });

  it("throws on unknown strategyId", () => {
    expect(() => resolveWireSpec(wire, {})).toThrow(/unknown strategyId/);
  });

  it("drawProfilesFromWire mirrors drawProfiles(resolved, ...)", () => {
    const a = drawProfilesFromWire(wire, { "noop-cfg": noop }, makeRng(1));
    const b = drawProfiles(resolveWireSpec(wire, { "noop-cfg": noop }), makeRng(1));
    expect(a).toEqual(b);
  });

  it("WireBotConfigSpec round-trips through JSON.stringify", () => {
    const json = JSON.stringify(wire);
    const back = JSON.parse(json) as WireBotConfigSpec;
    expect(back).toEqual(wire);
    // and still draws.
    expect(drawProfilesFromWire(back, { "noop-cfg": noop }, makeRng(1))).toHaveLength(2);
  });
});

describe("SETUP_SET_BOT_CONFIG + orchestrator auto-build", () => {
  function setup() {
    const clock = new FakeClock(1_000_000);
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
    s.claimSeat(BOB,   1, { displayName: "Bob" });
    s.claimSeat(CAROL, 2, { displayName: "Carol" });
    s.startGame(HOST);
    return { s, clock };
  }

  const wire = {
    strategies: [{
      strategyId: "natural-player",
      count: { kind: "constant", value: 1 },
      spawn: { mode: "permanent" },
      lagMs: { kind: "constant", value: 0 },
      scope: "instance",
      params: {
        targetQty: { kind: "constant", value: 3 },
        tightSpreadFrac: { kind: "constant", value: 0.5 },
        widthInitTicks: { kind: "constant", value: 3 },
        historicMedianGuard: { kind: "constant", value: 1.5 },
        urgencyDecayPerSec: { kind: "constant", value: 0 },
        idleSecondsBeforeDecay: { kind: "constant", value: 1 },
        urgentPennyIntervalMs: { kind: "constant", value: 1000 },
        panicThreshold: { kind: "constant", value: 1.5 },
        panicEmaHalfLifeSec: { kind: "constant", value: 5 },
      },
    }],
  };

  it("orchestrator builds a spawner from the entity's config and runs it", async () => {
    const { s, clock } = setup();
    const { STRATEGIES } = await import("../server/bots/registry");
    new BotOrchestrator(s, clock, STRATEGIES);

    s.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
      payoffSource: "return H.sum(cards);",
    });
    s.handleGameMessage(HOST, { type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } });
    s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds: ["XY"] });
    s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_CONFIG", entityId: "XY", config: wire });
    s.handleGameMessage(HOST, { type: "START_TRADING" });

    const cid = s.getEngineState().contracts[0]!.id;
    s.handleGameMessage(ALICE, { type: "PLACE_LIMIT", contractId: cid, side: "buy",  qty: 10, price: 95  });
    s.handleGameMessage(BOB,   { type: "PLACE_LIMIT", contractId: cid, side: "sell", qty: 10, price: 105 });
    clock.advance(100);

    const botKey = participantKey({ kind: "bot", entityId: "XY" });
    expect(s.getEngineState().positions[botKey]?.[cid] ?? 0).toBe(3);
  });

  it("invalid strategyId in config is logged-and-skipped, not thrown", async () => {
    const { s, clock } = setup();
    const { STRATEGIES } = await import("../server/bots/registry");
    new BotOrchestrator(s, clock, STRATEGIES);
    const origWarn = console.warn; const warns: string[] = []; console.warn = (m: string) => warns.push(m);
    try {
      s.handleGameMessage(HOST, {
        type: "SETUP_ADD_CONTRACT", name: "Sum", description: "",
        payoffSource: "return H.sum(cards);",
      });
      s.handleGameMessage(HOST, { type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } });
      s.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds: ["XY"] });
      s.handleGameMessage(HOST, {
        type: "SETUP_SET_BOT_CONFIG", entityId: "XY",
        config: { strategies: [{ ...wire.strategies[0], strategyId: "does-not-exist" }] },
      });
      s.handleGameMessage(HOST, { type: "START_TRADING" });
      clock.advance(100);
    } finally {
      console.warn = origWarn;
    }
    expect(warns.some((w) => w.includes("unknown strategyId"))).toBe(true);
  });
});
