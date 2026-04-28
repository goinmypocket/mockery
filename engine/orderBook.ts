// =============================================================================
// Order book — FIFO levels, price-time priority, in-place mutation.
//
// `placeOrder` does the matching. Self-trade prevention cancels the
// resting opposing-side order(s) of the same participant before
// continuing the cross. `ioc=true` discards any unfilled residual; `ioc=false`
// posts it as a resting order.
//
// The book mutates in place: callers (the reducer) are expected to take a
// fresh state object before calling these functions if immutability is
// desired at the boundary.
// =============================================================================

import type {
  Order,
  OrderBook,
  OrderSide,
  ParticipantId,
  PriceLevel,
  Trade,
} from "../shared/types";
import { participantsEqual } from "../shared/types";
import {
  asContractId,
  asOrderId,
  asTradeId,
  type ContractId,
  type OrderId,
} from "../shared/ids";

export function emptyBook(contractId: ContractId): OrderBook {
  return {
    contractId,
    bids: [],
    offers: [],
    lastTradePrice: null,
    ordersById: {},
  };
}

interface PlaceArgs {
  participant: ParticipantId;
  contractId: ContractId;
  side: OrderSide;
  qty: number;
  price: number;
  ioc: boolean;
  /** Server time of the order; trades inherit this on the print. */
  ts: number;
  phase: number;
  /** Counter source for new ids. The reducer owns these; we mutate. */
  mintOrderId: () => OrderId;
  mintTradeId: () => TradeId;
}

type TradeId = ReturnType<typeof asTradeId>;

export interface PlaceResult {
  /** orderId of the resting residual, if any. Null if fully filled or IOC. */
  residentOrderId: OrderId | null;
  trades: Trade[];
}

export function placeOrder(book: OrderBook, args: PlaceArgs): PlaceResult {
  const trades: Trade[] = [];

  // Validate.
  if (args.qty <= 0 || !Number.isInteger(args.qty)) {
    throw new Error(`invalid qty ${args.qty}`);
  }
  if (!Number.isInteger(args.price)) {
    throw new Error(`invalid price ${args.price}`);
  }

  let remaining = args.qty;

  // Match against the opposite side until exhausted, no longer crossing,
  // or no liquidity.
  const oppositeLevels = args.side === "buy" ? book.offers : book.bids;

  outer: while (remaining > 0 && oppositeLevels.length > 0) {
    const bestLevel = oppositeLevels[0]!;
    if (!crosses(args.side, args.price, bestLevel.price)) break outer;

    while (remaining > 0 && bestLevel.orders.length > 0) {
      const resting = bestLevel.orders[0]!;

      // Self-trade prevention: cancel and retry.
      if (participantsEqual(resting.participant, args.participant)) {
        bestLevel.orders.shift();
        delete book.ordersById[resting.id];
        continue;
      }

      const tradeQty = Math.min(remaining, resting.qty);
      const buyer = args.side === "buy" ? args.participant : resting.participant;
      const seller = args.side === "buy" ? resting.participant : args.participant;

      trades.push({
        id: args.mintTradeId(),
        ts: args.ts,
        phase: args.phase,
        contractId: args.contractId,
        buyer,
        seller,
        price: bestLevel.price,
        qty: tradeQty,
        aggressor: args.side === "buy" ? "buyer" : "seller",
      });

      remaining -= tradeQty;
      resting.qty -= tradeQty;

      if (resting.qty === 0) {
        bestLevel.orders.shift();
        delete book.ordersById[resting.id];
      }
    }

    if (bestLevel.orders.length === 0) {
      oppositeLevels.shift();
    }
  }

  // Update last trade price.
  if (trades.length > 0) {
    book.lastTradePrice = trades[trades.length - 1]!.price;
  }

  // Post residual if not IOC.
  let residentOrderId: OrderId | null = null;
  if (remaining > 0 && !args.ioc) {
    const order: Order = {
      id: args.mintOrderId(),
      participant: args.participant,
      contractId: args.contractId,
      side: args.side,
      price: args.price,
      qty: remaining,
      enteredAt: args.ts,
    };
    insertResting(book, order);
    book.ordersById[order.id] = order;
    residentOrderId = order.id;
  }

  return { residentOrderId, trades };
}

export function cancelOrder(book: OrderBook, orderId: OrderId): boolean {
  const order = book.ordersById[orderId];
  if (!order) return false;
  const sameSide = order.side === "buy" ? book.bids : book.offers;
  const levelIdx = sameSide.findIndex((l) => l.price === order.price);
  if (levelIdx < 0) {
    delete book.ordersById[orderId];
    return false;
  }
  const level = sameSide[levelIdx]!;
  const orderIdx = level.orders.findIndex((o) => o.id === orderId);
  if (orderIdx < 0) {
    delete book.ordersById[orderId];
    return false;
  }
  level.orders.splice(orderIdx, 1);
  if (level.orders.length === 0) sameSide.splice(levelIdx, 1);
  delete book.ordersById[orderId];
  return true;
}

export function bestBid(book: OrderBook): PriceLevel | null {
  return book.bids[0] ?? null;
}

export function bestOffer(book: OrderBook): PriceLevel | null {
  return book.offers[0] ?? null;
}

export function midPrice(book: OrderBook): number | null {
  const bb = bestBid(book);
  const bo = bestOffer(book);
  if (!bb || !bo) return null;
  return (bb.price + bo.price) / 2;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function crosses(takerSide: OrderSide, takerPrice: number, restingPrice: number): boolean {
  return takerSide === "buy" ? takerPrice >= restingPrice : takerPrice <= restingPrice;
}

function insertResting(book: OrderBook, order: Order): void {
  const sameSide = order.side === "buy" ? book.bids : book.offers;
  const cmp = order.side === "buy"
    ? (a: number, b: number) => b - a   // bids: descending
    : (a: number, b: number) => a - b;  // offers: ascending

  // Linear search; books are short.
  for (let i = 0; i < sameSide.length; i++) {
    const level = sameSide[i]!;
    if (level.price === order.price) {
      level.orders.push(order);
      return;
    }
    if (cmp(order.price, level.price) < 0) {
      sameSide.splice(i, 0, { price: order.price, orders: [order] });
      return;
    }
  }
  sameSide.push({ price: order.price, orders: [order] });
}

// re-export for users that don't want to re-import branded id helpers.
export { asContractId, asOrderId };
