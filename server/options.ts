// =============================================================================
// Option normalisation — called by the platform on createTable BEFORE
// createSession. Fills in defaults, fixes types, and rejects obviously
// invalid combinations.
// =============================================================================

import { asUserId, type UserId } from "../shared/ids";
import type {
  CodeMode,
  EventMode,
  IdentityReveal,
  ResolvedOptions,
} from "../shared/types";

/** Upper bound on `informedSeats + uninformedSeats`. Must match
 *  `definition.ts`'s `maxPlayers`. */
export const MAX_SEAT_COUNT = 8;

export function normalizeMockeryOptions(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const informedSeats = posInt(raw["informedSeats"], 6);
  const uninformedSeats = nonNegInt(raw["uninformedSeats"], 0);
  const publicSlots = nonNegInt(raw["publicSlots"], 3);
  const copiesPerValue = posInt(raw["copiesPerValue"], 4);
  const cardValues = parseCardValues(raw["cardValuesCsv"], [1, 2, 9, 10]);
  const eventMode = enumOr<EventMode>(raw["eventMode"], "auto", ["auto", "manual"]);
  const eventIntervalMin = posInt(raw["eventIntervalMin"], 300);
  const eventIntervalMax = posInt(raw["eventIntervalMax"], 480);
  const endGameGraceSec = nonNegInt(raw["endGameGraceSec"], 0);
  const codeMode = enumOr<CodeMode>(raw["codeMode"], "alpha", ["alpha", "random"]);
  const enforceCaseByRole = !!raw["enforceCaseByRole"];
  const identityReveal = enumOr<IdentityReveal>(
    raw["identityReveal"],
    "all",
    ["all", "host", "listed"],
  );
  const identityRevealList = parseUserIdList(raw["identityRevealList"]);

  let seed = posIntOr0(raw["seed"]);
  if (seed === 0) seed = Math.floor(Math.random() * 0x7fffffff) + 1;

  // Cross-field checks
  if (informedSeats + uninformedSeats < 2) {
    throw new Error("informedSeats + uninformedSeats must be >= 2");
  }
  if (informedSeats + uninformedSeats > MAX_SEAT_COUNT) {
    throw new Error(`informedSeats + uninformedSeats must be <= ${MAX_SEAT_COUNT}`);
  }
  if (eventIntervalMin > eventIntervalMax) {
    throw new Error("eventIntervalMin must be <= eventIntervalMax");
  }
  const deckSize = cardValues.length * copiesPerValue;
  const cardsInPlay = informedSeats + publicSlots;
  if (cardsInPlay > deckSize) {
    throw new Error(
      `cardsInPlay (${cardsInPlay}) exceeds deckSize (${deckSize})`,
    );
  }
  const seen = new Set<number>();
  for (const v of cardValues) {
    if (seen.has(v)) throw new Error(`duplicate card value ${v}`);
    seen.add(v);
  }

  // Persist as the resolved object the session expects.
  const resolved: ResolvedOptions = {
    cardValues,
    copiesPerValue,
    informedSeats,
    uninformedSeats,
    publicSlots,
    eventMode,
    eventIntervalMin,
    eventIntervalMax,
    endGameGraceSec,
    seed,
    codeMode,
    enforceCaseByRole,
    identityReveal,
    identityRevealList,
  };
  return { ...raw, _resolved: resolved };
}

export function readResolved(options: Record<string, unknown>): ResolvedOptions {
  const r = options["_resolved"];
  if (r && typeof r === "object") return r as ResolvedOptions;
  // Tolerate options that were never normalized (e.g. test direct input).
  return normalizeMockeryOptions(options)["_resolved"] as ResolvedOptions;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function posInt(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
function posIntOr0(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
function nonNegInt(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
function enumOr<T extends string>(v: unknown, dflt: T, choices: readonly T[]): T {
  return typeof v === "string" && (choices as readonly string[]).includes(v) ? (v as T) : dflt;
}
function parseCardValues(v: unknown, dflt: number[]): number[] {
  if (Array.isArray(v)) {
    const out = v
      .map((x) => (typeof x === "number" ? x : Number(x)))
      .filter((n) => Number.isFinite(n));
    return out.length > 0 ? out : dflt;
  }
  if (typeof v === "string") {
    const out = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    return out.length > 0 ? out : dflt;
  }
  return dflt;
}
function parseUserIdList(v: unknown): UserId[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map(asUserId);
}
