// =============================================================================
// PlayingScreen — the live trading workspace.
//
// v0.1 uses a simple grid layout. The spec calls for an `rc-dock`-based
// docking workspace with persisted layouts (UI spec §1); that's a
// follow-up swap-out — module components stay the same.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import { TopBar } from "../components/TopBar";
import { CardDisplay } from "../playing/CardDisplay";
import { OrderBookPanel } from "../playing/OrderBookPanel";
import { OrderPlacer } from "../playing/OrderPlacer";
import { TnsPanel } from "../playing/TnsPanel";
import { PositionPnlPanel } from "../playing/PositionPnlPanel";
import { HostControlsPanel } from "../playing/HostControlsPanel";
import { MyOrdersPanel } from "../playing/MyOrdersPanel";
import { RejectionChip } from "../components/RejectionChip";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  readonly lastRejection: string | null;
  clearRejection(): void;
}

export function PlayingScreen(props: Props): ReactNode {
  const { snapshot, send, lastRejection, clearRejection } = props;
  const isHost = snapshot.viewer.userId === snapshot.tableHostUserId;

  return (
    <div className="mk-playing">
      <TopBar snapshot={snapshot} />

      {lastRejection ? (
        <div className="mk-playing__rejection">
          <RejectionChip text={lastRejection} onDismiss={clearRejection} />
        </div>
      ) : null}

      <div className="mk-playing__grid">
        <section className="mk-panel mk-panel--cards">
          <h3 className="mk-panel__title">Cards</h3>
          <CardDisplay snapshot={snapshot} />
        </section>

        <section className="mk-panel mk-panel--book">
          <h3 className="mk-panel__title">Order Book</h3>
          <OrderBookPanel snapshot={snapshot} send={send} />
        </section>

        <section className="mk-panel mk-panel--positions">
          <h3 className="mk-panel__title">Positions &amp; PnL</h3>
          <PositionPnlPanel snapshot={snapshot} />
        </section>

        <section className="mk-panel mk-panel--tns">
          <h3 className="mk-panel__title">Trades</h3>
          <TnsPanel snapshot={snapshot} />
        </section>

        <section className="mk-panel mk-panel--my-orders">
          <h3 className="mk-panel__title">My Orders</h3>
          <MyOrdersPanel snapshot={snapshot} send={send} />
        </section>

        {isHost ? (
          <section className="mk-panel mk-panel--host">
            <h3 className="mk-panel__title">Host</h3>
            <HostControlsPanel snapshot={snapshot} send={send} />
          </section>
        ) : null}
      </div>

      <footer className="mk-playing__placer">
        <OrderPlacer snapshot={snapshot} send={send} />
      </footer>
    </div>
  );
}
