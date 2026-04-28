// =============================================================================
// React hook that turns the PlatformGameContext stream into a
// `ProjectedSnapshot`. Every STATE_SNAPSHOT message replaces the cached
// snapshot; INTENT_REJECTED is exposed as an inline error string with a
// dismiss action; LIBRARY_LIST_RESULT updates the user library.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import type { PlatformGameContext } from "./types";
import type { ProjectedSnapshot } from "../engine/project";

export interface LibraryEntryView {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly payoffSource: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MockerySessionView {
  readonly snapshot: ProjectedSnapshot | null;
  readonly lastRejection: string | null;
  /** User's saved-contract library. Null until the first
   *  LIBRARY_LIST_RESULT arrives. */
  readonly library: readonly LibraryEntryView[] | null;
  send(msg: unknown): void;
  clearRejection(): void;
}

export function useMockerySession(ctx: PlatformGameContext): MockerySessionView {
  const [snapshot, setSnapshot] = useState<ProjectedSnapshot | null>(null);
  const [lastRejection, setLastRejection] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryEntryView[] | null>(null);

  useEffect(() => {
    const unsub = ctx.subscribe((raw) => {
      const msg = raw as { type?: string };
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "STATE_SNAPSHOT": {
          const snap = (msg as { snap: ProjectedSnapshot }).snap;
          setSnapshot(snap);
          break;
        }
        case "INTENT_REJECTED": {
          const reason = (msg as { reason: string }).reason;
          setLastRejection(reason);
          break;
        }
        case "LIBRARY_LIST_RESULT": {
          const entries = (msg as { entries: LibraryEntryView[] }).entries ?? [];
          setLibrary(entries);
          break;
        }
        case "HELLO":
        case "LIBRARY_SAVE_RESULT":
        case "LIBRARY_UPDATE_RESULT":
        case "LIBRARY_DELETE_RESULT":
          // server follows up these with a LIBRARY_LIST_RESULT
          break;
        default:
          break;
      }
    });
    // Pull the library once the subscription is live.
    ctx.send({ type: "LIBRARY_LIST" });
    return unsub;
  }, [ctx]);

  const send = useCallback((m: unknown) => ctx.send(m), [ctx]);
  const clearRejection = useCallback(() => setLastRejection(null), []);

  return { snapshot, lastRejection, library, send, clearRejection };
}
