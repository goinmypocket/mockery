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

/** Module ids that, if missing from a saved layout, should be added on
 *  load. Newly-introduced modules go here so existing saved layouts
 *  pick them up automatically without forcing the user to reset. The
 *  injection appends the id as a sibling tab in the dockbox root. */
const REQUIRED_MODULE_IDS: readonly ModuleId[] = ["placer"];

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
 *    │ My Orders│ TNS              ├───────────┤
 *    │          │                  │ Host*     │
 *    │ Placer   │                  │           │
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
            { tabs: [{ id: "placer" }] },
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
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LayoutBase;
    return ensureRequiredModules(parsed);
  } catch {
    return null;
  }
}

/** Walk a saved layout and append any `REQUIRED_MODULE_IDS` whose tab
 *  isn't already present anywhere in the tree. Each missing module is
 *  added as a new bottom-pinned panel in the dockbox so it's
 *  immediately visible. Layouts already containing the module are
 *  returned unchanged.
 *
 *  This lets us roll out new modules without forcing a hard reset for
 *  users with old saved layouts. */
export function ensureRequiredModules(layout: LayoutBase): LayoutBase {
  const present = new Set<string>();
  collectTabIds(layout.dockbox as unknown, present);
  const missing = REQUIRED_MODULE_IDS.filter((id) => !present.has(id));
  if (missing.length === 0) return layout;
  // Append a vertical row of single-tab panels for the missing modules.
  // rc-dock dockbox root must be horizontal/vertical; preserve whatever
  // mode it has by wrapping in a vertical box if needed.
  const dockbox = layout.dockbox as unknown as { mode?: string; children?: unknown[] };
  const newPanels = missing.map((id) => ({ tabs: [{ id }] }));
  let nextDockbox: unknown;
  if (dockbox.mode === "vertical" && Array.isArray(dockbox.children)) {
    nextDockbox = { ...dockbox, children: [...dockbox.children, ...newPanels] };
  } else {
    // Wrap the existing dockbox in a vertical box and append the new
    // panel(s) below it.
    nextDockbox = {
      mode: "vertical",
      children: [dockbox, ...newPanels],
    };
  }
  return { ...layout, dockbox: nextDockbox as LayoutBase["dockbox"] };
}

function collectTabIds(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const n = node as { tabs?: Array<{ id?: unknown }>; children?: unknown[] };
  if (n.tabs) {
    for (const t of n.tabs) {
      if (typeof t.id === "string") out.add(t.id);
    }
  }
  if (n.children) {
    for (const child of n.children) collectTabIds(child, out);
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

// ---------------------------------------------------------------------------
// Per-panel font size (per moduleId, scoped to (userId, tableId))
// ---------------------------------------------------------------------------

export type FontSizeMap = Record<string, number>;

function fontSizeKey(userId: string, tableId: string): string {
  return `mockery.fontsize.${userId}.${tableId}`;
}

export function loadFontSizes(userId: string, tableId: string): FontSizeMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(fontSizeKey(userId, tableId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: FontSizeMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveFontSizes(userId: string, tableId: string, sizes: FontSizeMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(fontSizeKey(userId, tableId), JSON.stringify(sizes));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Global workspace font size (per user, applies across all tables)
// ---------------------------------------------------------------------------

const GLOBAL_FONT_KEY = "mockery.global-fontsize";

export function loadGlobalFontSize(userId: string): number | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${GLOBAL_FONT_KEY}.${userId}`);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveGlobalFontSize(userId: string, px: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${GLOBAL_FONT_KEY}.${userId}`, String(px));
  } catch { /* ignore */ }
}
