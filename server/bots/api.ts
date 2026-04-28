// =============================================================================
// Bot strategy API. See docs/bot-author-guide.md for the full guide
// and a worked example.
//
// Strategies are server-side TypeScript checked into this repo. They
// receive a BotContext and write actions back into the engine through
// the action methods on it. The orchestrator (server/bots/runtime.ts,
// to be implemented) wires events from the engine into the strategy's
// callbacks.
// =============================================================================

import type { ContractId, OrderId, TableId, TradeId } from "../../shared/ids";
import type {
  ContractDef,
  EventQueueEntry,
  GameEvent,
  Order,
  OrderSide,
  ParticipantCode,
} from "../../shared/types";

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

export interface BotStrategy {
  readonly id: string;
  readonly displayName: string;
  onStart?(ctx: BotContext): void;
  onMarketData?(ctx: BotContext, snap: MarketSnapshot): void;
  onTrade?(ctx: BotContext, trade: BotTrade): void;
  onEvent?(ctx: BotContext, event: GameEvent): void;
  onGameOver?(ctx: BotContext, result: GameResult): void;
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
}

// ---------------------------------------------------------------------------
// BotContext
// ---------------------------------------------------------------------------

export interface BotContext {
  readonly entityId: string;
  readonly tableId: TableId;
  readonly snapshot: MarketSnapshot;

  placeLimit(args: PlaceArgs): OpResult<{ orderId: OrderId | null; fills: BotTrade[] }>;
  placeIoc(args: PlaceArgs): OpResult<{ fills: BotTrade[] }>;
  cancel(orderId: OrderId): OpResult<void>;
  cancelAllMy(): OpResult<{ cancelled: number }>;

  myPosition(contractId: ContractId): number;
  myCash(): number;
  myMtmPnl(): number;
  myOpenOrders(): readonly Order[];

  readonly local: Map<string, unknown>;

  setTimer(ms: number, fn: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface PlaceArgs {
  readonly contractId: ContractId;
  readonly side: OrderSide;
  readonly qty: number;
  readonly price: number;
}

export type OpResult<T> =
  | (T extends void ? { ok: true } : { ok: true; value: T })
  | { ok: false; reason: string };

export type TimerHandle = symbol;

// ---------------------------------------------------------------------------
// MarketSnapshot — what the bot sees of the world
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  readonly ts: number;
  readonly phase: number;
  readonly status: "playing" | "finished";

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
