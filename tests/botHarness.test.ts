// =============================================================================
// Bot test harness — end-to-end smoke tests that prove the headless
// harness lets an author assert on a strategy's behaviour without
// hand-wiring a session.
// =============================================================================

import { describe, expect, it } from "vitest";
import { runHeadless } from "../server/bots/testing/harness";
import randomQuoter from "../server/bots/strategies/random-quoter";
import noop from "../server/bots/strategies/noop";
import { resolveParams } from "../server/bots/api";

describe("runHeadless", () => {
  it("runs the random-quoter through a full session and reports results", () => {
    const result = runHeadless({
      strategy: randomQuoter,
      params: { spread: 2, size: 1, requoteMs: 1000, fallbackMid: 25 },
      durationMs: 30_000,
      contracts: [
        { name: "Sum", payoffSource: "return H.sum(cards);" },
      ],
    });
    expect(result.status).toBe("finished");
    // The quoter places on both sides every tick, so by the end of
    // the duration it should have *some* resting/cancelled history.
    // We don't assert fills (counterparty behaviour is variable) —
    // just that the strategy reached game-over alive.
    expect(result.finalPnl).not.toBeNull();
  });

  it("two random-quoters with different params can run in the same session", () => {
    const result = runHeadless({
      strategy: randomQuoter,
      params: { spread: 1, size: 1, requoteMs: 500, fallbackMid: 25 },
      durationMs: 15_000,
      contracts: [
        { name: "Sum", payoffSource: "return H.sum(cards);" },
      ],
      opponentBots: [
        { strategy: randomQuoter, count: 1, params: { spread: 5, size: 1, requoteMs: 500, fallbackMid: 25 } },
        { strategy: noop, count: 1 },
      ],
    });
    expect(result.status).toBe("finished");
  });
});

describe("resolveParams", () => {
  it("fills in defaults and rejects unknown keys", () => {
    const schema = {
      spread: { kind: "int", default: 2, min: 1, max: 10 },
      mode: { kind: "enum", choices: ["a", "b"], default: "a" },
    } as const;
    const ok = resolveParams(schema, { spread: 5 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.params).toEqual({ spread: 5, mode: "a" });

    const bad = resolveParams(schema, { spread: 99 });
    expect(bad.ok).toBe(false);

    const unknown = resolveParams(schema, { spread: 2, nope: true });
    expect(unknown.ok).toBe(false);
  });

  it("rejects params when the strategy declares no schema", () => {
    const ok = resolveParams(undefined, null);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.params).toEqual({});
    const bad = resolveParams(undefined, { unexpected: 1 });
    expect(bad.ok).toBe(false);
  });
});
