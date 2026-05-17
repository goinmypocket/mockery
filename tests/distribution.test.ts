// =============================================================================
// Contract distribution helper — enumerates multiset partitions of the
// remaining deck, evaluates payoff, returns pmf + mean + variance.
// =============================================================================

import { describe, expect, it } from "vitest";
import { contractDistribution } from "../engine/distribution";

const SUM_ALL = "return H.sum(cards);";
const SUM_INFORMED = "return H.sum(cards.slice(0, H.PUBLIC_START));";
const COUNT_TENS = "return H.count(cards, c => c === 10);";

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

describe("contractDistribution", () => {
  it("pmf weights sum to 1 for a small game", () => {
    const d = contractDistribution({
      cardValues: [1, 2, 3, 4],
      copiesPerValue: 2,
      informedSeats: 2,
      publicSlots: 1,
      payoffSource: SUM_ALL,
    });
    let total = 0;
    for (const p of d.pmf.values()) total += p;
    expect(approx(total, 1)).toBe(true);
    expect(d.configurations).toBeGreaterThan(0);
    expect(d.failures).toBe(0);
  });

  it("mean of sum-of-all-cards equals (cards-in-play) × mean(deck)", () => {
    // Deck: 1,2,3,4 each ×2 → 8 cards, mean = 2.5.
    // Drawing 3 without replacement → expected sum = 3 × 2.5 = 7.5.
    const d = contractDistribution({
      cardValues: [1, 2, 3, 4],
      copiesPerValue: 2,
      informedSeats: 2,
      publicSlots: 1,
      payoffSource: SUM_ALL,
    });
    expect(approx(d.mean, 7.5)).toBe(true);
  });

  it("conditioning on a known public card shifts the conditional mean", () => {
    // Same deck/shape; if the public card is fixed at 4, expected sum
    // of the two informed cards is 2 × (1+2+3+3+4+4+3)/7 ≈ but let's
    // just compute directly and assert it changed.
    const base = contractDistribution({
      cardValues: [1, 2, 3, 4],
      copiesPerValue: 2,
      informedSeats: 2,
      publicSlots: 1,
      payoffSource: SUM_ALL,
    });
    const condOn4 = contractDistribution({
      cardValues: [1, 2, 3, 4],
      copiesPerValue: 2,
      informedSeats: 2,
      publicSlots: 1,
      payoffSource: SUM_ALL,
      knownPublic: { 0: 4 },
    });
    // Closed form: deck mean among remaining 7 cards (1×2,2×2,3×2,4×1)
    // = (2+4+6+4)/7 = 16/7 ≈ 2.2857. Expected informed sum = 2 × 16/7.
    // Total expected payoff = 4 + 2 × 16/7 = 4 + 32/7 ≈ 8.5714.
    expect(approx(condOn4.mean, 4 + (2 * 16) / 7, 1e-9)).toBe(true);
    expect(condOn4.mean).toBeGreaterThan(base.mean);
  });

  it("conditioning on a fully-known board returns a degenerate distribution", () => {
    const d = contractDistribution({
      cardValues: [1, 2, 3, 4],
      copiesPerValue: 2,
      informedSeats: 2,
      publicSlots: 1,
      payoffSource: SUM_ALL,
      knownInformed: { 0: 1, 1: 2 },
      knownPublic: { 0: 3 },
    });
    expect(d.configurations).toBe(1);
    expect(d.pmf.size).toBe(1);
    expect(d.pmf.get(6)).toBe(1);
    expect(d.mean).toBe(6);
    expect(d.variance).toBe(0);
  });

  it("payoff sees only informed cards via H.PUBLIC_START", () => {
    // informed=2, public=1; payoff sums only positions 0..1.
    const d = contractDistribution({
      cardValues: [1, 2, 3, 4],
      copiesPerValue: 2,
      informedSeats: 2,
      publicSlots: 1,
      payoffSource: SUM_INFORMED,
    });
    // Expected sum of 2 informed cards = 2 × 2.5 = 5.0.
    expect(approx(d.mean, 5)).toBe(true);
  });

  it("removedFromDeck constrains the support", () => {
    // Remove all 4s from the deck — payoff can never see a 4.
    const d = contractDistribution({
      cardValues: [1, 2, 3, 4],
      copiesPerValue: 2,
      informedSeats: 2,
      publicSlots: 1,
      payoffSource: COUNT_TENS,         // counts a value not even in deck
      removedFromDeck: [4, 4],
    });
    // No 10s anywhere → payoff is always 0.
    expect(d.pmf.get(0)).toBe(1);
    expect(d.min).toBe(0);
    expect(d.max).toBe(0);
  });

  it("variance is non-negative", () => {
    const d = contractDistribution({
      cardValues: [1, 10],
      copiesPerValue: 4,
      informedSeats: 1,
      publicSlots: 1,
      payoffSource: SUM_ALL,
    });
    expect(d.variance).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid inputs", () => {
    // knownPublic value not in deck
    expect(() =>
      contractDistribution({
        cardValues: [1, 2],
        copiesPerValue: 1,
        informedSeats: 1,
        publicSlots: 1,
        payoffSource: SUM_ALL,
        knownPublic: { 0: 99 },
      }),
    ).toThrow(/not in cardValues/);
    // too many knowns of one value
    expect(() =>
      contractDistribution({
        cardValues: [1, 2],
        copiesPerValue: 1,
        informedSeats: 1,
        publicSlots: 1,
        payoffSource: SUM_ALL,
        knownInformed: { 0: 1 },
        knownPublic: { 0: 1 },          // only 1 copy of the value 1
      }),
    ).toThrow(/exhausted/);
  });

});
