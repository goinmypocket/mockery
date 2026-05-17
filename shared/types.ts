// =============================================================================
// Mockery-specific shared types. Used by engine, server, and web. Wire
// envelopes the platform sees are opaque; these are the shapes we
// project to clients per recipient.
//
// See docs/game-spec.md for vocabulary and §1 for named parameters.
// =============================================================================

import type { ContractId, OrderId, TradeId, UserId } from "./ids";

/** A 2-letter participant code shown publicly (engine spec §11). */
export type ParticipantCode = string;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type EventMode = "auto" | "manual";

export type CodeMode = "alpha" | "random";

export type IdentityReveal = "all" | "host" | "listed";

/** Engine-internal result type used by operations that may return a
 *  value on success (e.g. orderId + fills from a place op). When
 *  `T extends void` the success arm carries no `value` field —
 *  forces void operations to be plain `{ ok: true }` rather than
 *  `{ ok: true; value: undefined }`. The seam's `Result` (in
 *  GameDefinition.ts) stays match-exactly with the platform — no
 *  value payload there. */
export type OpResult<T> =
  | (T extends void
      ? { readonly ok: true }
      : { readonly ok: true; readonly value: T })
  | { readonly ok: false; readonly reason: string };

export interface ResolvedOptions {
  readonly cardValues: readonly number[];
  readonly copiesPerValue: number;
  readonly informedSeats: number;
  readonly uninformedSeats: number;
  readonly publicSlots: number;
  readonly eventMode: EventMode;
  readonly eventIntervalMin: number;       // sec, auto only
  readonly eventIntervalMax: number;       // sec, auto only
  readonly endGameGraceSec: number;        // sec, manual only; 0 = explicit
  readonly seed: number;
  readonly codeMode: CodeMode;
  readonly enforceCaseByRole: boolean;
  readonly identityReveal: IdentityReveal;
  readonly identityRevealList: readonly UserId[];
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export type ParticipantId =
  | { readonly kind: "player"; readonly userId: UserId }
  | { readonly kind: "bot"; readonly entityId: string };

/** Stable string key suitable for use as a Record key. */
export function participantKey(p: ParticipantId): string {
  return p.kind === "player" ? `p:${p.userId}` : `b:${p.entityId}`;
}

export function participantsEqual(a: ParticipantId, b: ParticipantId): boolean {
  return a.kind === b.kind && participantKey(a) === participantKey(b);
}

// ---------------------------------------------------------------------------
// Codes (engine spec §11)
// ---------------------------------------------------------------------------

/** participantKey -> 2-letter code (case sensitive in storage; the case
 *  carries semantic meaning when enforceCaseByRole is on). */
export type CodeBook = Record<string, ParticipantCode>;

/** Whether `code` is a syntactically valid 2-letter ASCII code. */
export function isValidCode(code: string): boolean {
  return /^[A-Za-z]{2}$/.test(code);
}

/** Case-insensitive equality used for uniqueness checks. */
export function codesCollide(a: ParticipantCode, b: ParticipantCode): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface ContractDef {
  readonly id: ContractId;
  readonly name: string;
  readonly description: string;
  readonly payoffSource: string;   // body of `function payoff(cards) {...}`
  readonly payoffHash: string;     // sha256 of payoffSource (informational)
}

// ---------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------

export type OrderSide = "buy" | "sell";

export interface Order {
  readonly id: OrderId;
  readonly participant: ParticipantId;
  readonly contractId: ContractId;
  readonly side: OrderSide;
  readonly price: number;
  qty: number;                     // remaining
  readonly enteredAt: number;      // server ms
}

export interface PriceLevel {
  readonly price: number;
  readonly orders: Order[];        // FIFO, head fills first
}

export interface OrderBook {
  readonly contractId: ContractId;
  bids: PriceLevel[];              // descending by price
  offers: PriceLevel[];            // ascending by price
  lastTradePrice: number | null;
  ordersById: Record<OrderId, Order>;
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface Trade {
  readonly id: TradeId;
  readonly ts: number;
  readonly phase: number;
  readonly contractId: ContractId;
  readonly buyer: ParticipantId;
  readonly seller: ParticipantId;
  readonly price: number;
  readonly qty: number;
  readonly aggressor: "buyer" | "seller";
  /** OrderId of the resting order this trade hit. The aggressor's
   *  fills come back synchronously from `placeLimit` / `placeIoc`, so
   *  only the resting side needs to be tagged here for later
   *  attribution via `onMyFill`. Legacy saves that predate this field
   *  hydrate with a synthetic sentinel id. */
  readonly restingOrderId: OrderId;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventQueueEntry =
  | { readonly type: "ROTATE_INFORMED" }
  | { readonly type: "REVEAL_PUBLIC"; readonly slotIndex: number | null };

export type GameEvent =
  | { readonly type: "ROTATED" }
  | { readonly type: "REVEALED"; readonly slotIndex: number; readonly value: number };

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export interface BotEntity {
  readonly entityId: string;
  readonly strategyId: string | null;
  /** Per-instance tunable parameters, validated against the
   *  strategy's `paramsSchema` at instantiation time. Null means
   *  "use the strategy's schema defaults". The host sets this when
   *  binding a strategy; multiple bot entities can share the same
   *  strategy with different params. */
  readonly params?: Readonly<Record<string, unknown>> | null;
  /** Multi-profile spawner config (a `WireBotConfigSpec` from
   *  `server/bots/config.ts`, stored opaquely here to avoid pulling
   *  bot types into shared/). When set, the orchestrator builds a
   *  `multiProfileBot` for this entity at game start and ignores
   *  `strategyId` / `params`. */
  readonly config?: Readonly<Record<string, unknown>> | null;
}

/** Multi-code routing group. References engine entities by id; the
 *  orchestrator builds one strategy instance per group at game start.
 *  Either `strategyId` (standalone) or `config` (multi-profile spawner)
 *  must be set. See `docs/bot-spawning-model.md` §6. */
export interface BotGroup {
  readonly groupId: string;
  readonly entityIds: readonly string[];
  readonly strategyId?: string | null;
  readonly params?: Readonly<Record<string, unknown>> | null;
  readonly config?: Readonly<Record<string, unknown>> | null;
  readonly seed?: number;
}

// ---------------------------------------------------------------------------
// Action log — every play-phase action with the bot state snapshot taken
// right after it ran. Lets a replay viewer see what each bot "knew" /
// was about to do at the moment of each action.
// ---------------------------------------------------------------------------

/** Bot scratchpad + tunables captured at the moment an action was logged.
 *  `local` is the strategy's `ctx.local` Map projected to a plain object
 *  (non-JSON values are stringified). */
export interface BotStateSnapshot {
  readonly entityId: string;
  readonly strategyId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly local: Readonly<Record<string, unknown>>;
}

export type ActionActor =
  | { readonly kind: "player"; readonly userId: UserId }
  | { readonly kind: "bot"; readonly entityId: string }
  | { readonly kind: "system" };

export interface ActionLogEntry {
  readonly seq: number;
  readonly ts: number;
  readonly phase: number;
  readonly actor: ActionActor;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly outcome:
    | { readonly ok: true; readonly value?: Readonly<Record<string, unknown>> }
    | { readonly ok: false; readonly reason: string };
  readonly botStates: readonly BotStateSnapshot[];
}
