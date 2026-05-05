// =============================================================================
// Module registry — the catalogue of dockable panels available on the
// playing screen. Each entry knows its title and how to render itself
// from the current snapshot. The Workspace uses this to (a) hydrate
// `loadTab` calls from saved layouts (which carry only ids), and (b)
// populate the "+" picker for adding new panels.
//
// Spec: docs/game-ui-spec.md §1.4.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import { CardDisplay } from "../playing/CardDisplay";
import { OrderBookPanel } from "../playing/OrderBookPanel";
import { TnsPanel } from "../playing/TnsPanel";
import { PositionPnlPanel } from "../playing/PositionPnlPanel";
import { HostControlsPanel } from "../playing/HostControlsPanel";
import { MyOrdersPanel } from "../playing/MyOrdersPanel";
import { OrderPlacer } from "../playing/OrderPlacer";

export type ModuleId =
  | "cards"
  | "orderBook"
  | "tns"
  | "positions"
  | "myOrders"
  | "placer"
  | "host";

export interface ModuleContext {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export interface ModuleDef {
  readonly id: ModuleId;
  readonly title: string;
  /** True if the module is only meaningful for the host (it still
   *  renders for non-hosts but at reduced capability). The Workspace
   *  uses this to filter the default layout for non-host viewers. */
  readonly hostOnly?: boolean;
  render(ctx: ModuleContext): ReactNode;
}

export const MODULES: Readonly<Record<ModuleId, ModuleDef>> = {
  cards: {
    id: "cards",
    title: "Cards",
    render: ({ snapshot }) => <CardDisplay snapshot={snapshot} />,
  },
  orderBook: {
    id: "orderBook",
    title: "Order Book",
    render: ({ snapshot, send }) => <OrderBookPanel snapshot={snapshot} send={send} />,
  },
  tns: {
    id: "tns",
    title: "Trades",
    render: ({ snapshot }) => <TnsPanel snapshot={snapshot} />,
  },
  positions: {
    id: "positions",
    title: "Positions & PnL",
    render: ({ snapshot }) => <PositionPnlPanel snapshot={snapshot} />,
  },
  myOrders: {
    id: "myOrders",
    title: "My Orders",
    render: ({ snapshot, send }) => <MyOrdersPanel snapshot={snapshot} send={send} />,
  },
  placer: {
    id: "placer",
    title: "Order Placer",
    render: ({ snapshot, send }) => <OrderPlacer snapshot={snapshot} send={send} />,
  },
  host: {
    id: "host",
    title: "Host",
    hostOnly: true,
    render: ({ snapshot, send }) => <HostControlsPanel snapshot={snapshot} send={send} />,
  },
};

export const ALL_MODULE_IDS: readonly ModuleId[] = Object.keys(MODULES) as ModuleId[];
