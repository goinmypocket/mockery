// =============================================================================
// Bot strategy API. See docs/bot-author-guide.md for the full guide
// and docs/bot-modularity.md for the architectural contract.
//
// Strategies are server-side TypeScript checked into this repo. They
// receive a BotContext (action calls + immutable MarketSnapshot +
// validated `params` + a `local` scratchpad + timers) and write
// actions back into the engine through the action methods on it. The
// orchestrator (server/bots/runtime.ts) wires events from the engine
// into the strategy's callbacks.
//
// Authoring guarantees we keep:
//   - Strategies never import from `engine/` or `server/` (other than
//     `./helpers`). The orchestrator is the only thing that translates
//     between engine state and the BotContext surface.
//   - Lifecycle hooks fire on a single thread; the orchestrator
//     bounds re-entrancy with a depth cap and a quarantine policy
//     (5 throws → drop instance) so a misbehaving strategy can't
//     wedge the session.
// =============================================================================

import type { ContractId, OrderId, TableId, TradeId } from "../../shared/ids";
import type {
  ContractDef,
  EventQueueEntry,
  GameEvent,
  OpResult,
  Order,
  OrderSide,
  ParticipantCode,
} from "../../shared/types";
import type { TimerHandle } from "../clock";

/** Re-exported so bot authors can keep `import { ... } from "./api"`
 *  without crossing into engine-internal modules. Single definition
 *  lives in `../clock.ts`; this just propagates it through the bot
 *  API surface. Same goes for OpResult. */
export type { OpResult, TimerHandle };

/** Stored / orchestrator-facing strategy type with params erased to
 *  the open shape. Strategy *authors* write `BotStrategy<MyParams>`
 *  for type-safe `ctx.params` access in their handlers; the
 *  registry and orchestrator hold instances as `AnyBotStrategy`
 *  because the generic is invariant in the BotContext position. */
export type AnyBotStrategy = BotStrategy<Params>;

/** Group several engine-level bot entities under a single strategy
 *  instance. Orders the strategy places are routed across the
 *  group's `entityIds` uniformly (seeded RNG). `myPosition`,
 *  `myCash`, `myOpenOrders` aggregate across the group; `onMyFill`
 *  fires for fills against any of the group's entities. See
 *  `docs/bot-spawning-model.md` §6. */
export interface BotGroupConfig {
  readonly groupId: string;
  readonly entityIds: readonly string[];
  /** Provide exactly one of `strategy` (standalone) or `config` (the
   *  orchestrator builds a multiProfileBot from a wire spec). */
  readonly strategy?: AnyBotStrategy;
  readonly params?: Params | null;
  readonly config?: import("./config").WireBotConfigSpec;
  /** Seed for the entity-picker RNG (and the spawner RNG when
   *  `config` is set). If absent, derived deterministically from
   *  `groupId`. */
  readonly seed?: number;
}

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

export interface BotStrategy<P = Params> {
  /** Stable id used in the registry, the host UI, and on the wire.
   *  Must match the filename (e.g. `random-quoter.ts` → `random-quoter`)
   *  so the build-time registry check can verify the link. */
  readonly id: string;
  /** Human-facing name in the host's strategy picker. */
  readonly displayName: string;
  /** One-line description shown in the host UI / strategy catalogue.
   *  Optional, but encouraged — it's the only doc some hosts see. */
  readonly description?: string;
  /** Free-form tags the host UI can use for grouping or filtering
   *  (e.g. ["market-maker", "passive"]). Optional. */
  readonly tags?: readonly string[];
  /** Coarse category for catalogue grouping. Optional. */
  readonly category?: "market-maker" | "directional" | "noise" | "test" | "other";

  /** Declarative schema for per-instance tunables. Each entry maps a
   *  key to a typed spec; the orchestrator validates user-provided
   *  params against the schema at instantiation and exposes the
   *  resolved values through `ctx.params`. Strategies without
   *  parameters can omit this and ignore `ctx.params`. */
  readonly paramsSchema?: ParamsSchema;

  // Lifecycle hooks. All optional; the orchestrator no-ops missing
  // hooks. `ctx` is freshly refreshed before every hook fires.

  onStart?(ctx: BotContext<P>): void;
  /** Fires after *any* engine state change — placements, cancels,
   *  trades, events. Coarse-grained; for narrower triggers prefer
   *  `onBookUpdate` / `onMyFill` / `onPhaseChange`. */
  onMarketData?(ctx: BotContext<P>, snap: MarketSnapshot): void;
  /** Fires once per *every* matched fill (including ones the bot
   *  isn't party to). Use this for tape reading; for "I just got
   *  filled" prefer `onMyFill`. */
  onTrade?(ctx: BotContext<P>, trade: BotTrade): void;
  /** Fires once for each fill where the bot is the buyer or seller.
   *  `side` is the bot's side of the fill. The orchestrator filters,
   *  so authors don't need to compare codes by hand. */
  onMyFill?(ctx: BotContext<P>, trade: BotTrade, side: OrderSide): void;
  /** Fires for each contract whose top-of-book moved (best
   *  bid/offer price, size, or last trade price changed) since the
   *  previous tick. Cheaper to use than `onMarketData` for
   *  market-making cadence. */
  onBookUpdate?(ctx: BotContext<P>, contractId: ContractId): void;
  /** Fires once per engine event (rotate/reveal). */
  onEvent?(ctx: BotContext<P>, event: GameEvent): void;
  /** Fires when `snapshot.phase` advances (after every event).
   *  Convenient if a strategy resets state at phase boundaries. */
  onPhaseChange?(ctx: BotContext<P>, oldPhase: number, newPhase: number): void;
  /** Fires once when settlement completes. Strategies should cancel
   *  long-running timers here — the orchestrator also walks
   *  `ctx.setTimer` handles and cancels them as a safety net. */
  onGameOver?(ctx: BotContext<P>, result: GameResult): void;
}

/** Trade as a bot sees it — counterparties as codes, not internal ids. */
export interface BotTrade {
  readonly id: TradeId;
  readonly ts: number;
  readonly phase: number;
  readonly contractId: ContractId;
  readonly buyerCode: ParticipantCode;
  readonly sellerCode: ParticipantCode;
  readonly price: number;
  readonly qty: number;
  readonly aggressor: "buyer" | "seller";
  /** OrderId of the resting side of this match. If a bot's resting
   *  order was hit, this is that bot's own OrderId. Aggressor-side
   *  fills should be attributed via the synchronous return value of
   *  the placement call instead. */
  readonly restingOrderId: OrderId;
}

// ---------------------------------------------------------------------------
// Params (per-instance tunables)
// ---------------------------------------------------------------------------

/** Resolved, validated parameter bag handed to a strategy via
 *  `ctx.params`. Frozen at the orchestrator boundary. */
export type Params = Readonly<Record<string, unknown>>;

/** Declarative parameter schema. Each entry has a `kind` discriminant
 *  and a `default` that the orchestrator falls back to when the host
 *  doesn't supply a value. Bounds checks live alongside the spec. */
export type ParamsSchema = Readonly<Record<string, ParamSpec>>;

export type ParamSpec =
  | {
      readonly kind: "int";
      readonly default: number;
      readonly min?: number;
      readonly max?: number;
      readonly label?: string;
      readonly description?: string;
    }
  | {
      readonly kind: "number";
      readonly default: number;
      readonly min?: number;
      readonly max?: number;
      readonly label?: string;
      readonly description?: string;
    }
  | {
      readonly kind: "boolean";
      readonly default: boolean;
      readonly label?: string;
      readonly description?: string;
    }
  | {
      readonly kind: "enum";
      readonly choices: readonly string[];
      readonly default: string;
      readonly label?: string;
      readonly description?: string;
    }
  | {
      readonly kind: "string";
      readonly default: string;
      readonly label?: string;
      readonly description?: string;
    };

// ---------------------------------------------------------------------------
// BotContext
// ---------------------------------------------------------------------------

export interface BotContext<P = Params> {
  readonly entityId: string;
  readonly tableId: TableId;
  readonly snapshot: MarketSnapshot;
  /** Primary code for this bot. For normal bots equals the only code;
   *  for grouped bots (multi-code routing), equals the first of
   *  `myCodes`. Strategies that care about "is any code mine?" should
   *  check `myCodes.includes(...)` rather than `=== myCode`. */
  readonly myCode: ParticipantCode;
  /** All codes this bot routes orders through. Length ≥ 1; > 1 only
   *  when the host wired this bot as a `BotGroup`. */
  readonly myCodes: readonly ParticipantCode[];
  /** Validated parameter bag, resolved against the strategy's
   *  `paramsSchema` and the host's `BotEntity.params`. Always present
   *  (the empty object `{}` for strategies without a schema). */
  readonly params: P;

  placeLimit(args: PlaceArgs): OpResult<{ orderId: OrderId | null; fills: BotTrade[] }>;
  placeIoc(args: PlaceArgs): OpResult<{ fills: BotTrade[] }>;
  cancel(orderId: OrderId): OpResult<void>;
  cancelAllMy(): OpResult<{ cancelled: number }>;

  myPosition(contractId: ContractId): number;
  myCash(): number;
  myMtmPnl(): number;
  myOpenOrders(): readonly Order[];

  /** Per-instance scratch space. The orchestrator drops it at game
   *  over; strategies use it for any state that needs to persist
   *  across callbacks. */
  readonly local: Map<string, unknown>;

  /** Schedule `fn` to run after `ms` ms of virtual / wall time. The
   *  callback receives the freshly-refreshed BotContext at fire time
   *  — strategies that just want to act can still write `() => ...`
   *  (the ctx arg is optional and benign to ignore). */
  setTimer(ms: number, fn: (ctx: BotContext<P>) => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface PlaceArgs {
  readonly contractId: ContractId;
  readonly side: OrderSide;
  readonly qty: number;
  readonly price: number;
}

// ---------------------------------------------------------------------------
// MarketSnapshot — what the bot sees of the world
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  readonly ts: number;
  readonly phase: number;
  readonly status: "playing" | "finished";
  /** This bot's own participant code. Mirrored from `BotContext.myCode`
   *  so strategy code can rely on `snap.myCode` without holding the
   *  context. */
  readonly myCode: ParticipantCode;

  readonly cardValues: readonly number[];
  readonly copiesPerValue: number;
  readonly publicCards: ReadonlyArray<number | null>;
  readonly contracts: readonly ContractDef[];
  readonly participants: readonly ParticipantSummary[];
  readonly eventQueue: readonly EventQueueEntry[];
  readonly eventMode: "auto" | "manual";
  readonly msUntilNextEvent: number | null;

  readonly books: Readonly<Record<ContractId, BookSnapshot>>;
  readonly recentTrades: readonly BotTrade[];

  readonly myPositions: Readonly<Record<ContractId, number>>;
  readonly myCash: number;
  readonly myMtmPnl: number;
  readonly myOpenOrders: readonly Order[];
}

export interface ParticipantSummary {
  readonly code: ParticipantCode;
  readonly role: "informed" | "uninformed" | "bot";
  readonly displayName: string | null;   // null when redacted from this viewer
}

export interface BookSnapshot {
  readonly contractId: ContractId;
  readonly bids: readonly LevelSnapshot[];
  readonly offers: readonly LevelSnapshot[];
  readonly lastTradePrice: number | null;
  readonly midPrice: number | null;
}

export interface LevelSnapshot {
  readonly price: number;
  readonly size: number;
  readonly parties: ReadonlyArray<{ readonly code: ParticipantCode; readonly qty: number }>;
}

// ---------------------------------------------------------------------------
// Game result
// ---------------------------------------------------------------------------

export interface GameResult {
  readonly cards: readonly number[];
  readonly settlements: Readonly<Record<ContractId, number>>;
  readonly myFinalPnl: number;
}

// ---------------------------------------------------------------------------
// Params validation — orchestrator-side helper, exported so the host
// UI / wire validation can reuse the same rules.
// ---------------------------------------------------------------------------

/** Resolve a host-supplied params bag against a strategy's schema:
 *  fill in defaults for missing keys, coerce strings → numbers where
 *  the spec is numeric, clamp to declared bounds, reject unknown
 *  keys. Returns a frozen, fully-typed Params object. */
export function resolveParams(
  schema: ParamsSchema | undefined,
  provided: Readonly<Record<string, unknown>> | null | undefined,
): { ok: true; params: Params } | { ok: false; reason: string } {
  const out: Record<string, unknown> = {};
  if (!schema) {
    // No schema = the strategy ignores params; surface an error if the
    // host tried to pass any, so they get told instead of silently
    // discarding.
    if (provided && Object.keys(provided).length > 0) {
      return { ok: false, reason: "strategy declares no paramsSchema" };
    }
    return { ok: true, params: Object.freeze({}) };
  }
  const allowedKeys = new Set(Object.keys(schema));
  for (const k of Object.keys(provided ?? {})) {
    if (!allowedKeys.has(k)) {
      return { ok: false, reason: `unknown param "${k}"` };
    }
  }
  for (const [key, spec] of Object.entries(schema)) {
    const raw = provided?.[key];
    const coerced = coerceParam(key, spec, raw);
    if (!coerced.ok) return coerced;
    out[key] = coerced.value;
  }
  return { ok: true, params: Object.freeze(out) };
}

function coerceParam(
  key: string,
  spec: ParamSpec,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: spec.default };
  }
  switch (spec.kind) {
    case "int": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, reason: `param "${key}" must be an integer` };
      }
      if (spec.min !== undefined && n < spec.min) {
        return { ok: false, reason: `param "${key}" < min ${spec.min}` };
      }
      if (spec.max !== undefined && n > spec.max) {
        return { ok: false, reason: `param "${key}" > max ${spec.max}` };
      }
      return { ok: true, value: n };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        return { ok: false, reason: `param "${key}" must be a finite number` };
      }
      if (spec.min !== undefined && n < spec.min) {
        return { ok: false, reason: `param "${key}" < min ${spec.min}` };
      }
      if (spec.max !== undefined && n > spec.max) {
        return { ok: false, reason: `param "${key}" > max ${spec.max}` };
      }
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw !== "boolean") {
        return { ok: false, reason: `param "${key}" must be a boolean` };
      }
      return { ok: true, value: raw };
    }
    case "enum": {
      if (typeof raw !== "string" || !spec.choices.includes(raw)) {
        return {
          ok: false,
          reason: `param "${key}" must be one of: ${spec.choices.join(", ")}`,
        };
      }
      return { ok: true, value: raw };
    }
    case "string": {
      if (typeof raw !== "string") {
        return { ok: false, reason: `param "${key}" must be a string` };
      }
      return { ok: true, value: raw };
    }
  }
}
