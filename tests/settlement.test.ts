import { describe, expect, it } from "vitest";
import {
  evaluatePayoff,
  validatePayoffSource,
  settleAll,
} from "../engine/settlement";
import { asContractId } from "../shared/ids";
import type { ContractDef } from "../shared/types";

describe("settlement.validatePayoffSource", () => {
  it("accepts a benign payoff", () => {
    expect(validatePayoffSource("return H.sum(cards);").ok).toBe(true);
  });

  it("rejects forbidden tokens", () => {
    expect(validatePayoffSource("return require('fs');").ok).toBe(false);
    expect(validatePayoffSource("return process.env.HOME;").ok).toBe(false);
    expect(validatePayoffSource("return eval('1+1');").ok).toBe(false);
    expect(validatePayoffSource("return globalThis;").ok).toBe(false);
    expect(validatePayoffSource("return ({}).constructor;").ok).toBe(false);
  });

  it("rejects ill-formed JS", () => {
    expect(validatePayoffSource("return ).;").ok).toBe(false);
  });
});

describe("settlement.evaluatePayoff — starter contracts", () => {
  it("sum of all cards", () => {
    const r = evaluatePayoff({
      source: "  return H.sum(cards);",
      cards: [1, 2, 9, 10, 1, 2],
      informedSeats: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(25);
  });

  it("10 × number of even cards", () => {
    const r = evaluatePayoff({
      source: "  return 10 * H.count(cards, function (c) { return c % 2 === 0; });",
      cards: [1, 2, 9, 10, 1, 2],
      informedSeats: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(30);   // even cards: 2, 10, 2 → 3 × 10
  });

  it("sum of evens minus sum of odds", () => {
    const r = evaluatePayoff({
      source:
        "  return H.sumWhere(cards, function (c) { return c % 2 === 0; }) - H.sumWhere(cards, function (c) { return c % 2 === 1; });",
      cards: [1, 2, 9, 10, 1, 2],
      informedSeats: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(3);    // (2+10+2) - (1+9+1) = 14 - 11 = 3
  });
});

describe("settlement.evaluatePayoff — sandbox", () => {
  it("blocks process and require", () => {
    const r = evaluatePayoff({
      source: "return require('fs');",
      cards: [1],
      informedSeats: 1,
    });
    expect(r.ok).toBe(false);
  });

  it("times out an infinite loop", () => {
    const r = evaluatePayoff({
      source: "while (true) { } return 0;",
      cards: [1],
      informedSeats: 1,
      timeoutMs: 25,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-finite return", () => {
    const r = evaluatePayoff({
      source: "return 1 / 0;",
      cards: [1],
      informedSeats: 1,
    });
    expect(r.ok).toBe(false);
  });
});

describe("settlement.settleAll", () => {
  it("settles every contract; bad ones default to 0", () => {
    const contracts: ContractDef[] = [
      {
        id: asContractId("a"),
        name: "good",
        description: "",
        payoffSource: "return H.sum(cards);",
        payoffHash: "",
      },
      {
        id: asContractId("b"),
        name: "bad",
        description: "",
        payoffSource: "throw new Error('boom');",
        payoffHash: "",
      },
    ];
    const r = settleAll(contracts, [1, 2, 3], 2);
    expect(r.settlements["a"]).toBe(6);
    expect(r.settlements["b"]).toBe(0);
    expect(r.errors["b"]).toMatch(/boom/);
  });
});
