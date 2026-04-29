// =============================================================================
// Layout library — named rc-dock layouts persisted to localStorage.
// Spec: docs/game-ui-spec.md §1.2.
//
// Two storage keys:
//   - "mockery.layouts"      — the user's saved layout library + default
//   - "mockery.layout.<userId>.<tableId>" — the active layout for one table
//
// All layouts are stored as rc-dock's `LayoutBase` (tab ids only — the
// Workspace's `loadTab` rehydrates ids → live TabData).
// =============================================================================

import type { LayoutBase } from "rc-dock";
import type { ModuleId } from "../modules";

export interface LayoutLibrary {
  /** Name of the layout used when a new table opens, or null to use the
   *  built-in default. */
  defaultName: string | null;
  /** name → saved layout. */
  layouts: Record<string, LayoutBase>;
}

const LIBRARY_KEY = "mockery.layouts";

export const BUILTIN_DEFAULT_NAME = "Built-in default";

/** The factory-default layout. Spec §1.3:
 *
 *    ┌──────────┬──────────────────┬───────────┐
 *    │ Cards    │ Order Book       │ Positions │
 *    │          ├──────────────────┤ & PnL     │
 *    │          │ TNS              │           │
 *    │          │                  ├───────────┤
 *    │ My Orders│                  │ Host*     │
 *    └──────────┴──────────────────┴───────────┘
 *
 *    *Host panel only included for the host viewer.
 */
export function builtinDefaultLayout(opts: { isHost: boolean }): LayoutBase {
  const rightChildren: Array<{ tabs: Array<{ id: ModuleId }> }> = [
    { tabs: [{ id: "positions" }] },
  ];
  if (opts.isHost) rightChildren.push({ tabs: [{ id: "host" }] });
  return {
    dockbox: {
      mode: "horizontal",
      children: [
        {
          mode: "vertical",
          size: 280,
          children: [
            { tabs: [{ id: "cards" }] },
            { tabs: [{ id: "myOrders" }] },
          ],
        },
        {
          mode: "vertical",
          size: 600,
          children: [
            { tabs: [{ id: "orderBook" }] },
            { tabs: [{ id: "tns" }] },
          ],
        },
        {
          mode: "vertical",
          size: 320,
          children: rightChildren,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function loadLibrary(): LayoutLibrary {
  if (typeof localStorage === "undefined") return { defaultName: null, layouts: {} };
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return { defaultName: null, layouts: {} };
    const parsed = JSON.parse(raw) as Partial<LayoutLibrary>;
    return {
      defaultName: typeof parsed.defaultName === "string" ? parsed.defaultName : null,
      layouts: parsed.layouts && typeof parsed.layouts === "object" ? parsed.layouts as Record<string, LayoutBase> : {},
    };
  } catch {
    return { defaultName: null, layouts: {} };
  }
}

export function saveLibrary(lib: LayoutLibrary): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
  } catch {
    // Quota / disabled storage — the user keeps their session-local
    // layout but it won't survive a reload.
  }
}

// ---------------------------------------------------------------------------
// Per-table active layout
// ---------------------------------------------------------------------------

function activeKey(userId: string, tableId: string): string {
  return `mockery.layout.${userId}.${tableId}`;
}

export function loadActiveLayout(userId: string, tableId: string): LayoutBase | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(activeKey(userId, tableId));
    return raw ? (JSON.parse(raw) as LayoutBase) : null;
  } catch {
    return null;
  }
}

export function saveActiveLayout(userId: string, tableId: string, layout: LayoutBase): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(activeKey(userId, tableId), JSON.stringify(layout));
  } catch { /* see saveLibrary */ }
}

export function clearActiveLayout(userId: string, tableId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(activeKey(userId, tableId));
  } catch { /* ignore */ }
}
