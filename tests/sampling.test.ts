// =============================================================================
// Distribution sampler — basic correctness + replay determinism.
// Statistical assertions use loose tolerances (large N, big slack).
// =============================================================================

import { describe, expect, it } from "vitest";
import { sample, sampleAll, type Distribution } from "../engine/sampling";
import { deriveSeed, makeRng } from "../engine/rng";

function drawMany(d: Distribution, seed: number, n: number): number[] {
  const rng = makeRng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(sample(d, rng));
  return out;
}

describe("sampling", () => {
  it("constant returns its value exactly", () => {
    expect(sample({ kind: "constant", value: 7 }, makeRng(1))).toBe(7);
  });

  it("same seed → same draws (replay determinism)", () => {
    const d: Distribution = { kind: "gaussian", mean: 0, std: 1 };
    expect(drawMany(d, 42, 50)).toEqual(drawMany(d, 42, 50));
  });

  it("uniform stays within bounds", () => {
    const xs = drawMany({ kind: "uniform", min: 2, max: 5 }, 1, 1000);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThan(5);
    }
  });

  it("uniform-int returns integers in [min, max] inclusive", () => {
    const xs = drawMany({ kind: "uniform-int", min: 3, max: 7 }, 1, 1000);
    for (const x of xs) {
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(7);
    }
    // every value in range eventually appears
    expect(new Set(xs).size).toBe(5);
  });

  it("gaussian mean is approximately correct", () => {
    const xs = drawMany({ kind: "gaussian", mean: 10, std: 2 }, 1, 5000);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(m - 10)).toBeLessThan(0.2);
  });

  it("gaussian clamps to bounds", () => {
    const xs = drawMany(
      { kind: "gaussian", mean: 0, std: 10, min: -1, max: 1 },
      1, 1000,
    );
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it("gaussian-int returns integers", () => {
    const xs = drawMany({ kind: "gaussian-int", mean: 5, std: 2 }, 1, 200);
    for (const x of xs) expect(Number.isInteger(x)).toBe(true);
  });

  it("exponential is non-negative and has mean ~ 1/rate", () => {
    const xs = drawMany({ kind: "exponential", rate: 2 }, 1, 5000);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(m - 0.5)).toBeLessThan(0.05);
  });

  it("exponential-int clamped above 0", () => {
    const xs = drawMany(
      { kind: "exponential-int", rate: 0.5, min: 0, max: 10 },
      1, 500,
    );
    for (const x of xs) {
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(10);
    }
  });

  it("categorical respects weights", () => {
    const d: Distribution = {
      kind: "categorical",
      choices: [
        { value: 1, weight: 9 },
        { value: 2, weight: 1 },
      ],
    };
    const xs = drawMany(d, 1, 5000);
    const ones = xs.filter((x) => x === 1).length;
    expect(ones / xs.length).toBeGreaterThan(0.85);
    expect(ones / xs.length).toBeLessThan(0.95);
  });

  it("categorical rejects empty choices and zero total weight", () => {
    const rng = makeRng(1);
    expect(() => sample({ kind: "categorical", choices: [] }, rng)).toThrow();
    expect(() =>
      sample({ kind: "categorical", choices: [{ value: 1, weight: 0 }] }, rng),
    ).toThrow();
  });

  it("deriveSeed is deterministic and keyed-distinct", () => {
    expect(deriveSeed(0, "AB")).toBe(deriveSeed(0, "AB"));
    expect(deriveSeed(0, "AB")).not.toBe(deriveSeed(0, "CD"));
    expect(deriveSeed(1, "AB")).not.toBe(deriveSeed(0, "AB"));
    expect(Number.isInteger(deriveSeed(42, "Bot1"))).toBe(true);
  });

  it("sampleAll draws each schema field exactly once", () => {
    const rng = makeRng(1);
    const out = sampleAll(
      {
        a: { kind: "constant", value: 1 },
        b: { kind: "constant", value: 2 },
      } as const,
      rng,
    );
    expect(out).toEqual({ a: 1, b: 2 });
  });
});
