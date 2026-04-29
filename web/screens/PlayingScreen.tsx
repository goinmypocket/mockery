// =============================================================================
// PlayingScreen — the live trading workspace.
//
// Top bar (phase + countdown + layout menu) → docking workspace via
// rc-dock → sticky Order Placer at the bottom.
// Spec: docs/game-ui-spec.md §1.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { TableId, UserId } from "../../shared/ids";
import { TopBar } from "../components/TopBar";
import { OrderPlacer } from "../playing/OrderPlacer";
import { RejectionChip } from "../components/RejectionChip";
import { Workspace } from "../playing/Workspace";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  readonly userId: UserId;
  readonly tableId: TableId;
  readonly lastRejection: string | null;
  clearRejection(): void;
}

export function PlayingScreen(props: Props): ReactNode {
  const { snapshot, send, userId, tableId, lastRejection, clearRejection } = props;

  return (
    <div className="mk-playing">
      <TopBar snapshot={snapshot} />

      {lastRejection ? (
        <div className="mk-playing__rejection">
          <RejectionChip text={lastRejection} onDismiss={clearRejection} />
        </div>
      ) : null}

      <div className="mk-playing__workspace">
        <Workspace snapshot={snapshot} send={send} userId={userId} tableId={tableId} />
      </div>

      <footer className="mk-playing__placer">
        <OrderPlacer snapshot={snapshot} send={send} />
      </footer>
    </div>
  );
}
