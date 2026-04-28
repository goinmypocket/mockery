// =============================================================================
// Settlement — evaluate contract `payoffSource` in a sandboxed VM.
//
// See docs/game-spec.md §5.2 (helpers exposed as `H`), §5.3 (validation),
// and §13 (security).
//
// Implementation uses Node's built-in `vm` module. This is sufficient
// for our trust model — players are running their own server, not
// strangers' code — but we still apply:
//   - a syntactic denylist before compilation
//   - empty sandbox: no globals, no require/process/timers
//   - a wall-clock timeout per call (default 50 ms)
//
// `isolated-vm` would be a stricter boundary; we'd switch if the threat
// model changes (e.g. multi-tenant hosting where users can submit
// hostile sources).
// =============================================================================

import { Script, createContext } from "node:vm";
import type { ContractDef } from "../shared/types";

export const FORBIDDEN_TOKENS: readonly string[] = [
  "require",
  "import",
  "eval",
  "Function",
  "process",
  "globalThis",
  "__proto__",
  "constructor",
];

const DEFAULT_TIMEOUT_MS = 50;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validatePayoffSource(source: string): ValidationResult {
  for (const token of FORBIDDEN_TOKENS) {
    // word-boundary-ish: forbid the token surrounded by non-identifier chars
    const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegex(token)}([^A-Za-z0-9_$]|$)`);
    if (re.test(source)) {
      return { ok: false, reason: `forbidden token: ${token}` };
    }
  }
  // Try to compile — syntax errors caught here.
  try {
    compile(source);
  } catch (err) {
    return { ok: false, reason: `compile error: ${(err as Error).message}` };
  }
  return { ok: true };
}

/** Build the H namespace exposed to user code. */
export function buildHelpers(informedSeats: number) {
  return {
    PUBLIC_START: informedSeats,
    count: (cards: readonly number[], pred: (c: number) => boolean) =>
      cards.reduce((acc, c) => (pred(c) ? acc + 1 : acc), 0),
    sum: (cards: readonly number[]) => cards.reduce((a, b) => a + b, 0),
    sumWhere: (cards: readonly number[], pred: (c: number) => boolean) =>
      cards.reduce((a, c) => (pred(c) ? a + c : a), 0),
    where: (cards: readonly number[], pred: (c: number) => boolean) =>
      cards.filter(pred),
    max: (cards: readonly number[]) =>
      cards.length === 0 ? 0 : cards.reduce((a, b) => (a > b ? a : b), -Infinity),
    min: (cards: readonly number[]) =>
      cards.length === 0 ? 0 : cards.reduce((a, b) => (a < b ? a : b), Infinity),
    unique: (cards: readonly number[]) => new Set(cards).size,
    has: (cards: readonly number[], value: number) => cards.includes(value),
  };
}

export interface EvalArgs {
  readonly source: string;
  readonly cards: readonly number[];
  readonly informedSeats: number;
  readonly timeoutMs?: number;
}

export interface EvalResult {
  readonly ok: boolean;
  readonly value?: number;
  readonly reason?: string;
}

/** Evaluate a single payoffSource. Returns the numeric result, or
 *  ok=false if the source is forbidden, fails to compile, throws,
 *  times out, or returns a non-finite number. */
export function evaluatePayoff(args: EvalArgs): EvalResult {
  const v = validatePayoffSource(args.source);
  if (!v.ok) return { ok: false, reason: v.reason ?? "validation failed" };

  let script: Script;
  try {
    script = compile(args.source);
  } catch (err) {
    return { ok: false, reason: `compile error: ${(err as Error).message}` };
  }

  const sandbox = {
    H: buildHelpers(args.informedSeats),
    cards: Object.freeze([...args.cards]),
    __result: undefined as unknown,
  };
  const ctx = createContext(sandbox, { name: "mockery-payoff" });

  try {
    script.runInContext(ctx, {
      timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, reason: `runtime error: ${(err as Error).message}` };
  }

  const out = sandbox.__result;
  if (typeof out !== "number" || !Number.isFinite(out)) {
    return { ok: false, reason: `payoff returned non-finite value: ${String(out)}` };
  }
  return { ok: true, value: out };
}

/** Settle every contract against the supplied final card tuple. Errors
 *  are coerced to 0 with a per-contract `errors` map for the caller to
 *  surface in TNS. */
export function settleAll(
  contracts: readonly ContractDef[],
  cards: readonly number[],
  informedSeats: number,
): { settlements: Record<string, number>; errors: Record<string, string> } {
  const settlements: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const c of contracts) {
    const r = evaluatePayoff({
      source: c.payoffSource,
      cards,
      informedSeats,
    });
    if (r.ok) {
      settlements[c.id] = r.value!;
    } else {
      settlements[c.id] = 0;
      errors[c.id] = r.reason!;
    }
  }
  return { settlements, errors };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function compile(source: string): Script {
  // Wrap user source: define `function payoff(cards) { <source> }` and
  // invoke it. The sandbox provides `cards` and the helper namespace
  // `H`; the wrapper assigns the return value to `__result`.
  const wrapped = `__result = (function payoff(cards) {\n${source}\n}).call(undefined, cards);`;
  return new Script(wrapped);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
