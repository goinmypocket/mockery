// =============================================================================
// PlatformGameContext — matches the shape the platform's GameMount passes
// (web/platform/GameMount.tsx in `in-my-pocket`). Field names must match
// exactly; the cast at the call site is structural.
// =============================================================================

import type { TableId, UserId } from "../shared/ids";

export interface PlatformGameContext {
  readonly userId: UserId;
  readonly tableId: TableId;
  readonly hostUserId: UserId;
  /** Send a GAME_MSG payload up to the server. */
  send(payload: unknown): void;
  /** Subscribe to GAME_MSG payloads coming back. Returns an unsubscribe. */
  subscribe(cb: (payload: unknown) => void): () => void;
}
