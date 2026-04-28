// =============================================================================
// Branded id types. Same convention as the In My Pocket platform.
// =============================================================================

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type UserId = Brand<string, "UserId">;
export type TableId = Brand<string, "TableId">;
export type GameId = Brand<string, "GameId">;
export type SaveId = Brand<string, "SaveId">;

export type ContractId = Brand<string, "ContractId">;
export type OrderId = Brand<string, "OrderId">;
export type TradeId = Brand<string, "TradeId">;

export const asUserId = (s: string): UserId => s as UserId;
export const asTableId = (s: string): TableId => s as TableId;
export const asGameId = (s: string): GameId => s as GameId;
export const asSaveId = (s: string): SaveId => s as SaveId;
export const asContractId = (s: string): ContractId => s as ContractId;
export const asOrderId = (s: string): OrderId => s as OrderId;
export const asTradeId = (s: string): TradeId => s as TradeId;
