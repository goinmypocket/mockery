// =============================================================================
// React hook that turns the PlatformGameContext stream into a
// `ProjectedSnapshot`. Every STATE_SNAPSHOT message replaces the cached
// snapshot; INTENT_REJECTED is exposed as an inline error string with a
// dismiss action.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import type { PlatformGameContext } from "./types";
import type { ProjectedSnapshot } from "../engine/project";

export interface MockerySessionView {
  readonly snapshot: ProjectedSnapshot | null;
  readonly lastRejection: string | null;
  send(msg: unknown): void;
  clearRejection(): void;
}

export function useMockerySession(ctx: PlatformGameContext): MockerySessionView {
  const [snapshot, setSnapshot] = useState<ProjectedSnapshot | null>(null);
  const [lastRejection, setLastRejection] = useState<string | null>(null);

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
        case "HELLO":
          // ignore
          break;
        default:
          break;
      }
    });
    return unsub;
  }, [ctx]);

  const send = useCallback((m: unknown) => ctx.send(m), [ctx]);
  const clearRejection = useCallback(() => setLastRejection(null), []);

  return { snapshot, lastRejection, send, clearRejection };
}
