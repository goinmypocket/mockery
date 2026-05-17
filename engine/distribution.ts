// =============================================================================
// Contract distribution — enumerate (informedMultiset, publicMultiset)
// partitions of the remaining deck, evaluate the payoff on each, weight
// by hypergeometric probability. Avoids redundant orderings.
//
// Assumes payoffs are symmetric within the informed group and within
// the public group (true for sum/count/max/has/…). Order-sensitive
// payoffs would need full sequence enumeration.
// =============================================================================

import { evaluatePayoff } from "./settlement";

export interface DistributionArgs {
  readonly cardValues: readonly number[];
  readonly copiesPerValue: number;
  readonly informedSeats: number;
  readonly publicSlots: number;
  readonly payoffSource: string;
  readonly knownInformed?: Readonly<Record<number, number>>;
  readonly knownPublic?: Readonly<Record<number, number>>;
  readonly removedFromDeck?: readonly number[];
  readonly payoffTimeoutMs?: number;
}

export interface ContractDistribution {
  readonly pmf: ReadonlyMap<number, number>;
  /** E[payoff]. `NaN` when no configurations evaluated successfully. */
  readonly mean: number;
  /** Var[payoff]. `NaN` when no configurations evaluated successfully. */
  readonly variance: number;
  /** Support extremes; `null` when no configurations evaluated successfully. */
  readonly min: number | null;
  readonly max: number | null;
  readonly configurations: number;
  readonly failures: number;
}

export function contractDistribution(args: DistributionArgs): ContractDistribution {
  const { distinctValues, deckCounts, unknownInformed, unknownPublic, buildTuple } = prepare(args);

  const pmf = new Map<number, number>();
  let sumW = 0, sumWx = 0, sumWxx = 0;
  let configurations = 0, failures = 0;
  let minV = +Infinity, maxV = -Infinity;

  enumeratePartition(distinctValues, deckCounts, unknownInformed, unknownPublic,
    (infPicks, pubPicks, weight) => {
      configurations++;
      const cards = buildTuple(infPicks, pubPicks);
      const r = evaluatePayoff(args.payoffTimeoutMs === undefined
        ? { source: args.payoffSource, cards, informedSeats: args.informedSeats }
        : { source: args.payoffSource, cards, informedSeats: args.informedSeats, timeoutMs: args.payoffTimeoutMs });
      if (!r.ok) { failures++; return; }
      const v = r.value!;
      sumW += weight; sumWx += weight * v; sumWxx += weight * v * v;
      pmf.set(v, (pmf.get(v) ?? 0) + weight);
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    });

  if (sumW > 0) for (const [k, v] of pmf) pmf.set(k, v / sumW);
  const mean = sumW > 0 ? sumWx / sumW : NaN;
  const variance = sumW > 0 ? Math.max(sumWxx / sumW - mean * mean, 0) : NaN;
  return {
    pmf, mean, variance,
    min: sumW > 0 ? minV : null,
    max: sumW > 0 ? maxV : null,
    configurations, failures,
  };
}

// ---------------------------------------------------------------------------

function prepare(args: DistributionArgs) {
  const distinctValues = [...args.cardValues];
  const valueIndex = new Map<number, number>();
  for (let i = 0; i < distinctValues.length; i++) valueIndex.set(distinctValues[i]!, i);
  const deckCounts = new Array<number>(distinctValues.length).fill(args.copiesPerValue);

  const removeOne = (value: number, ctx: string): void => {
    const i = valueIndex.get(value);
    if (i === undefined) throw new Error(`${ctx}: value ${value} not in cardValues`);
    if (deckCounts[i]! <= 0) throw new Error(`${ctx}: value ${value} exhausted`);
    deckCounts[i]!--;
  };

  const knownInformed = { ...(args.knownInformed ?? {}) };
  const knownPublic = { ...(args.knownPublic ?? {}) };
  for (const [seat, v] of Object.entries(knownInformed)) {
    const s = Number(seat);
    if (!Number.isInteger(s) || s < 0 || s >= args.informedSeats) throw new Error(`knownInformed: seat ${seat} out of range`);
    removeOne(v, "knownInformed");
  }
  for (const [slot, v] of Object.entries(knownPublic)) {
    const s = Number(slot);
    if (!Number.isInteger(s) || s < 0 || s >= args.publicSlots) throw new Error(`knownPublic: slot ${slot} out of range`);
    removeOne(v, "knownPublic");
  }
  for (const v of args.removedFromDeck ?? []) removeOne(v, "removedFromDeck");

  const unknownInformedSeats: number[] = [];
  for (let i = 0; i < args.informedSeats; i++) if (!(i in knownInformed)) unknownInformedSeats.push(i);
  const unknownPublicSlots: number[] = [];
  for (let i = 0; i < args.publicSlots; i++) if (!(i in knownPublic)) unknownPublicSlots.push(i);

  if (deckCounts.reduce((a, b) => a + b, 0) < unknownInformedSeats.length + unknownPublicSlots.length) {
    throw new Error("not enough cards left to fill unknown positions");
  }

  const totalLen = args.informedSeats + args.publicSlots;
  const buildTuple = (infPicks: readonly number[], pubPicks: readonly number[]): number[] => {
    const tuple = new Array<number>(totalLen);
    for (const [seat, v] of Object.entries(knownInformed)) tuple[Number(seat)] = v;
    for (const [slot, v] of Object.entries(knownPublic)) tuple[args.informedSeats + Number(slot)] = v;
    let c = 0;
    for (let k = 0; k < distinctValues.length; k++)
      for (let n = 0; n < infPicks[k]!; n++) tuple[unknownInformedSeats[c++]!] = distinctValues[k]!;
    c = 0;
    for (let k = 0; k < distinctValues.length; k++)
      for (let n = 0; n < pubPicks[k]!; n++) tuple[args.informedSeats + unknownPublicSlots[c++]!] = distinctValues[k]!;
    return tuple;
  };

  return {
    distinctValues, deckCounts,
    unknownInformed: unknownInformedSeats.length,
    unknownPublic: unknownPublicSlots.length,
    buildTuple,
  };
}

function enumeratePartition(
  values: readonly number[],
  deckCounts: readonly number[],
  unknownInformed: number,
  unknownPublic: number,
  visit: (infPicks: readonly number[], pubPicks: readonly number[], weight: number) => void,
): void {
  const total = deckCounts.reduce((a, b) => a + b, 0);
  const denom = binom(total, unknownInformed) * binom(total - unknownInformed, unknownPublic);
  if (denom === 0) {
    if (unknownInformed === 0 && unknownPublic === 0) {
      visit(new Array(values.length).fill(0), new Array(values.length).fill(0), 1);
    }
    return;
  }
  const infPicks = new Array<number>(values.length).fill(0);
  const pubPicks = new Array<number>(values.length).fill(0);

  const walkInf = (i: number, remaining: number, w: number): void => {
    if (remaining === 0) { walkPub(0, unknownPublic, w); return; }
    if (i === values.length) return;
    const maxPick = Math.min(deckCounts[i]!, remaining);
    for (let take = 0; take <= maxPick; take++) {
      infPicks[i] = take;
      walkInf(i + 1, remaining - take, w * binom(deckCounts[i]!, take));
    }
    infPicks[i] = 0;
  };
  const walkPub = (i: number, remaining: number, w: number): void => {
    if (remaining === 0) { visit(infPicks, pubPicks, w / denom); return; }
    if (i === values.length) return;
    const residual = deckCounts[i]! - infPicks[i]!;
    const maxPick = Math.min(residual, remaining);
    for (let take = 0; take <= maxPick; take++) {
      pubPicks[i] = take;
      walkPub(i + 1, remaining - take, w * binom(residual, take));
    }
    pubPicks[i] = 0;
  };
  walkInf(0, unknownInformed, 1);
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < kk; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
