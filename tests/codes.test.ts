import { describe, expect, it } from "vitest";
import { generateCodeBook, validateCode, type ParticipantInfo } from "../engine/codes";
import { makeRng } from "../engine/rng";
import { asUserId } from "../shared/ids";
import { participantKey } from "../shared/types";

function p(name: string, informed: boolean, isBot = false): ParticipantInfo {
  return {
    id: isBot ? { kind: "bot", entityId: name } : { kind: "player", userId: asUserId(name) },
    displayName: name,
    informed,
  };
}

describe("codes.generateCodeBook (alpha)", () => {
  it("derives codes from initials", () => {
    const ps = [p("Alice", true), p("Bob", true), p("Carol", true)];
    const book = generateCodeBook(ps, {
      mode: "alpha",
      enforceCaseByRole: false,
      rng: makeRng(1),
    });
    expect(book[participantKey(ps[0]!.id)]).toBe("AL");
    expect(book[participantKey(ps[1]!.id)]).toBe("BO");
    expect(book[participantKey(ps[2]!.id)]).toBe("CA");
  });

  it("enforces case by role", () => {
    const ps = [p("Alice", true), p("bob", false)];
    const book = generateCodeBook(ps, {
      mode: "alpha",
      enforceCaseByRole: true,
      rng: makeRng(1),
    });
    expect(book[participantKey(ps[0]!.id)]).toBe("AL");
    expect(book[participantKey(ps[1]!.id)]).toBe("bo");
  });

  it("assigns the next free code when player initials collide", () => {
    const ps = [p("Alex", true), p("Alice", true)];   // both want AL
    const book = generateCodeBook(ps, { mode: "alpha", enforceCaseByRole: false, rng: makeRng(1) });
    expect(Object.values(book)).toEqual(["AL", "AM"]);
  });

  it("supports identical guest names and wraps codes while preserving role case", () => {
    const ps = Array.from({ length: 8 }, (_, i) => ({
      ...p(`user-${i}`, i < 2), displayName: "ZZ Guest",
    }));
    const options = { mode: "alpha" as const, enforceCaseByRole: true, rng: makeRng(1) };
    const book = generateCodeBook(ps, options);
    expect(Object.values(book)).toEqual(["ZZ", "AA", "ab", "ac", "ad", "ae", "af", "ag"]);
    expect(generateCodeBook(ps, { ...options, rng: makeRng(1) })).toEqual(book);
  });

  it("bumps bot codes when they collide", () => {
    const ps = [p("Alex", true), p("Alice", false, true)];   // bot also wants AL
    const book = generateCodeBook(ps, {
      mode: "alpha",
      enforceCaseByRole: false,
      rng: makeRng(1),
    });
    const codes = Object.values(book);
    expect(new Set(codes.map((c) => c.toLowerCase())).size).toBe(2);
  });

  it("pads single-letter names with X", () => {
    const ps = [p("a", false)];
    const book = generateCodeBook(ps, {
      mode: "alpha",
      enforceCaseByRole: false,
      rng: makeRng(1),
    });
    expect(book[participantKey(ps[0]!.id)]).toBe("AX");
  });
});

describe("codes.generateCodeBook (random)", () => {
  it("is deterministic for a given seed", () => {
    const ps = [p("Alice", true), p("Bob", true), p("Carol", true)];
    const a = generateCodeBook(ps, { mode: "random", enforceCaseByRole: false, rng: makeRng(42) });
    const b = generateCodeBook(ps, { mode: "random", enforceCaseByRole: false, rng: makeRng(42) });
    expect(a).toEqual(b);
  });

  it("produces unique 2-letter codes", () => {
    const ps = Array.from({ length: 10 }, (_, i) => p(`P${i}`, true));
    const book = generateCodeBook(ps, { mode: "random", enforceCaseByRole: false, rng: makeRng(7) });
    const codes = Object.values(book);
    expect(codes).toHaveLength(10);
    expect(new Set(codes.map((c) => c.toLowerCase())).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Za-z]{2}$/);
    }
  });
});

describe("codes.validateCode", () => {
  const subject = p("Alice", true);

  it("accepts a unique 2-letter code", () => {
    const r = validateCode("ZZ", subject, false, {});
    expect(r.ok).toBe(true);
  });

  it("rejects bad shape", () => {
    expect(validateCode("Z", subject, false, {}).ok).toBe(false);
    expect(validateCode("ZZZ", subject, false, {}).ok).toBe(false);
    expect(validateCode("12", subject, false, {}).ok).toBe(false);
    expect(validateCode("", subject, false, {}).ok).toBe(false);
  });

  it("enforces case-by-role when on", () => {
    expect(validateCode("ab", p("Alice", true), true, {}).ok).toBe(false);
    expect(validateCode("AB", p("Alice", true), true, {}).ok).toBe(true);
    expect(validateCode("AB", p("bob", false), true, {}).ok).toBe(false);
    expect(validateCode("ab", p("bob", false), true, {}).ok).toBe(true);
  });

  it("rejects collision", () => {
    const existing = { "p:other": "AB" };
    expect(validateCode("AB", subject, false, existing).ok).toBe(false);
    expect(validateCode("ab", subject, false, existing).ok).toBe(false);   // case insensitive
    expect(validateCode("CD", subject, false, existing).ok).toBe(true);
  });
});
