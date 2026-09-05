// =============================================================================
// VENDORED from the In My Pocket platform — keep in sync with
// ../in-my-pocket/shared/GameDefinition.ts. Once the platform
// publishes its `shared/` types as an npm package, swap this folder
// for a dependency on that package.
// =============================================================================

import type { GameId, TableId, UserId } from "./ids";

export interface GameDefinition<Save = unknown> {
  readonly id: GameId;
  readonly displayName: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly supportsSpectators: boolean;
  readonly optionsSchema: OptionsSchema;
  createSession(opts: CreateOpts): GameSession<Save>;
  loadSession(blob: Save, opts: LoadOpts): GameSession<Save>;
  savedParticipants?(blob: Save): readonly { seatIndex: number; userId: UserId; displayName: string }[];
  normalizeOptions?(options: Record<string, unknown>): Record<string, unknown>;
}

export interface GameSession<Save = unknown> {
  attachConnection(userId: UserId, send: (msg: unknown) => void): void;
  detachConnection(userId: UserId): void;
  claimSeat(userId: UserId, seatIndex: number, options?: SeatOptions): Result;
  releaseSeat(userId: UserId, seatIndex: number): Result;
  kickSeat(callerUserId: UserId, seatIndex: number): Result;
  startGame(callerUserId: UserId): Result;
  handleGameMessage(userId: UserId, payload: unknown): void;
  serialize(): Save;
  describe(): SessionDescription;
}

export interface CreateOpts {
  /** Stable table family for auxiliary participant-owned data. */
  readonly scopeId?: string;
  readonly tableId: TableId;
  readonly hostUserId: UserId;
  readonly options: Record<string, unknown>;
}

export interface LoadOpts extends CreateOpts {}

export interface SeatOptions {
  readonly displayName?: string;
  readonly metadata?: Record<string, unknown>;
}

export type OptionsSchema = ReadonlyArray<OptionField>;

export type OptionField =
  | { kind: "boolean"; key: string; label: string; default: boolean }
  | { kind: "number"; key: string; label: string; default: number; min?: number; max?: number }
  | { kind: "enum"; key: string; label: string; default: string; choices: readonly string[] }
  | { kind: "string"; key: string; label: string; default: string };

export type Result = { ok: true } | { ok: false; reason: string };

export interface SessionDescription {
  readonly status: "lobby" | "playing" | "finished";
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly spectatorCount: number;
  readonly lastActivityAt: number;
  readonly headline?: string;
  readonly playableSeatIndices?: readonly number[];
}
