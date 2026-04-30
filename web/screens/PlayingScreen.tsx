// =============================================================================
// PlayingScreen — the live trading workspace.
//
// Top bar (phase + countdown + layout menu) → docking workspace via
// rc-dock → sticky Order Placer at the bottom.
// Spec: docs/game-ui-spec.md §1.
// =============================================================================

import { useCallback, useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { TableId, UserId } from "../../shared/ids";
import { TopBar } from "../components/TopBar";
import { OrderPlacer } from "../playing/OrderPlacer";
import { RejectionChip } from "../components/RejectionChip";
import { Workspace } from "../playing/Workspace";
import {
  loadGlobalFontSize,
  saveGlobalFontSize,
} from "../playing/layouts";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  readonly userId: UserId;
  readonly tableId: TableId;
  readonly lastRejection: string | null;
  clearRejection(): void;
}

const DEFAULT_GLOBAL_PX = 14;
const GLOBAL_MIN_PX = 6;
const GLOBAL_MAX_PX = 32;

export function PlayingScreen(props: Props): ReactNode {
  const { snapshot, send, userId, tableId, lastRejection, clearRejection } = props;

  // Global font size lives at the screen root so EVERY descendant —
  // top bar, layout menubar, docked panels, order placer — scales
  // together. Per-panel overrides (in Workspace) layer on top of this.
  const [globalFont, setGlobalFont] = useState<number>(
    () => loadGlobalFontSize(userId) ?? DEFAULT_GLOBAL_PX,
  );
  const adjustGlobal = useCallback((delta: number) => {
    setGlobalFont((prev) => {
      const next = Math.max(GLOBAL_MIN_PX, Math.min(GLOBAL_MAX_PX, prev + delta));
      saveGlobalFontSize(userId, next);
      return next;
    });
  }, [userId]);

  return (
    <div className="mk-playing" style={{ fontSize: `${globalFont}px` }}>
      <TopBar
        snapshot={snapshot}
        globalFont={globalFont}
        onGlobalFontDelta={adjustGlobal}
      />

      {lastRejection ? (
        <div className="mk-playing__rejection">
          <RejectionChip text={lastRejection} onDismiss={clearRejection} />
        </div>
      ) : null}

      <div className="mk-playing__workspace">
        <Workspace
          snapshot={snapshot}
          send={send}
          userId={userId}
          tableId={tableId}
          globalFont={globalFont}
        />
      </div>

      <footer className="mk-playing__placer">
        <OrderPlacer snapshot={snapshot} send={send} />
      </footer>
    </div>
  );
}
