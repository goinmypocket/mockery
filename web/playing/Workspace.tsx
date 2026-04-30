// =============================================================================
// Workspace — wraps rc-dock with a layout library menu and persistence.
// Replaces PlayingScreen's CSS grid. Spec: docs/game-ui-spec.md §1.
//
// The Order Placer is intentionally OUTSIDE the dock (sticky bottom bar);
// the spec calls it "always visible" and a docked tab would let users
// hide it accidentally.
// =============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import DockLayout from "rc-dock";
import type { LayoutBase, TabBase, TabData } from "rc-dock";
import { ALL_MODULE_IDS, MODULES, type ModuleId } from "../modules";
import type { ProjectedSnapshot } from "../../engine/project";
import {
  BUILTIN_DEFAULT_NAME,
  builtinDefaultLayout,
  clearActiveLayout,
  loadActiveLayout,
  loadFontSizes,
  loadLibrary,
  saveActiveLayout,
  saveFontSizes,
  saveLibrary,
  type FontSizeMap,
  type LayoutLibrary,
} from "./layouts";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  /** The viewer's user id; used as the per-user storage key. */
  readonly userId: string;
  /** The current table id; layouts are persisted per (userId, tableId). */
  readonly tableId: string;
  /** Workspace-wide base font size in px (set by PlayingScreen on the
   *  outer container). Per-panel overrides layer on top of this; the
   *  global control itself lives in TopBar to save real estate, so
   *  Workspace just needs the value as the panel-default fallback. */
  readonly globalFont: number;
}

/** Live snapshot/send pair pushed through React Context so panels
 *  re-render on every snapshot without rc-dock having to recreate the
 *  cached tab elements. We need Context (not a ref) because rc-dock's
 *  DockTabPane is PureComponent — it skips re-rendering when its
 *  cached children element is referentially unchanged, which means
 *  reading from a ref inside the panel would never observe updates. */
interface LiveCtx {
  snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  /** Effective font size in px for a given module instance — the
   *  per-panel override if set, else the workspace-global default. */
  fontSizeFor(moduleId: string): number;
  /** Set a per-panel override. Panel "Reset" sends `null` to clear. */
  setFontSizeFor(moduleId: string, px: number | null): void;
  /** True when this panel has its own override (vs. inheriting global). */
  hasFontSizeOverride(moduleId: string): boolean;
}

const LiveContext = createContext<LiveCtx | null>(null);

function useLive(): LiveCtx {
  const v = useContext(LiveContext);
  if (!v) throw new Error("module rendered outside <LiveContext.Provider>");
  return v;
}

/** Default and clamp range for per-panel font size (px). */
const FONT_SIZE_DEFAULT = 14;
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 32;

export function Workspace({
  snapshot, send, userId, tableId, globalFont,
}: Props): ReactNode {
  const isHost = snapshot.viewer.userId === snapshot.tableHostUserId;

  // Per-panel font size override, persisted per (userId, tableId).
  const [fontSizes, setFontSizes] = useState<FontSizeMap>(() =>
    loadFontSizes(userId, tableId),
  );
  const setFontSizeFor = useCallback(
    (moduleId: string, px: number | null) => {
      setFontSizes((prev) => {
        let next: FontSizeMap;
        if (px === null) {
          // Clear override — fall back to global.
          const { [moduleId]: _drop, ...rest } = prev;
          void _drop;
          next = rest;
        } else {
          const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(px)));
          next = { ...prev, [moduleId]: clamped };
        }
        saveFontSizes(userId, tableId, next);
        return next;
      });
    },
    [userId, tableId],
  );
  const fontSizeFor = useCallback(
    (moduleId: string) => fontSizes[moduleId] ?? globalFont,
    [fontSizes, globalFont],
  );
  const hasFontSizeOverride = useCallback(
    (moduleId: string) => moduleId in fontSizes,
    [fontSizes],
  );

  // The live ctx for the context provider. New object identity on every
  // snapshot change so consumers (the docked panels) re-render.
  const liveCtx = useMemo<LiveCtx>(
    () => ({ snapshot, send, fontSizeFor, setFontSizeFor, hasFontSizeOverride }),
    [snapshot, send, fontSizeFor, setFontSizeFor, hasFontSizeOverride],
  );

  // -----------------------------------------------------------------
  // Layout state
  // -----------------------------------------------------------------
  const dockRef = useRef<DockLayout | null>(null);
  const [library, setLibrary] = useState<LayoutLibrary>(() => loadLibrary());

  // Resolve the initial layout: persisted active → library default → builtin.
  const initialLayout: LayoutBase = useMemo(() => {
    const saved = loadActiveLayout(userId, tableId);
    if (saved) return filterLayout(saved, isHost);
    if (library.defaultName && library.layouts[library.defaultName]) {
      return filterLayout(library.layouts[library.defaultName]!, isHost);
    }
    return builtinDefaultLayout({ isHost });
    // Library/userId/tableId are stable for the life of this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------
  // loadTab — bridge saved tab ids → live React content.
  // -----------------------------------------------------------------
  const loadTab = useCallback((tab: TabBase): TabData => {
    const id = String(tab.id ?? "") as ModuleId;
    const mod = MODULES[id];
    if (!mod) {
      return {
        id: tab.id ?? "missing",
        title: tab.id ?? "?",
        content: <div className="mk-loading">Unknown module: {String(tab.id)}</div>,
        closable: true,
      };
    }
    return {
      id: mod.id,
      title: mod.title,
      content: <ModuleContainer moduleId={mod.id} />,
      closable: true,
      group: "default",
    };
  }, []);

  // -----------------------------------------------------------------
  // Persistence on layout change
  // -----------------------------------------------------------------
  const handleLayoutChange = useCallback((newLayout: LayoutBase) => {
    saveActiveLayout(userId, tableId, newLayout);
  }, [userId, tableId]);

  // -----------------------------------------------------------------
  // Layout-menu actions
  // -----------------------------------------------------------------
  const refreshLibrary = useCallback((next: LayoutLibrary) => {
    saveLibrary(next);
    setLibrary(next);
  }, []);

  const onSaveAs = useCallback(() => {
    if (!dockRef.current) return;
    const name = window.prompt("Save current layout as:");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed === BUILTIN_DEFAULT_NAME) {
      window.alert(`"${BUILTIN_DEFAULT_NAME}" is reserved.`);
      return;
    }
    const current = dockRef.current.saveLayout();
    refreshLibrary({
      ...library,
      layouts: { ...library.layouts, [trimmed]: current },
    });
  }, [library, refreshLibrary]);

  const onLoad = useCallback((name: string) => {
    if (!dockRef.current) return;
    if (name === BUILTIN_DEFAULT_NAME) {
      const next = builtinDefaultLayout({ isHost });
      dockRef.current.loadLayout(next);
      saveActiveLayout(userId, tableId, next);
      return;
    }
    const layout = library.layouts[name];
    if (!layout) return;
    const filtered = filterLayout(layout, isHost);
    dockRef.current.loadLayout(filtered);
    saveActiveLayout(userId, tableId, filtered);
  }, [library, isHost, userId, tableId]);

  const onDelete = useCallback((name: string) => {
    if (!window.confirm(`Delete layout "${name}"?`)) return;
    const { [name]: _drop, ...rest } = library.layouts;
    void _drop;
    refreshLibrary({
      defaultName: library.defaultName === name ? null : library.defaultName,
      layouts: rest,
    });
  }, [library, refreshLibrary]);

  const onSetDefault = useCallback((name: string | null) => {
    refreshLibrary({ ...library, defaultName: name });
  }, [library, refreshLibrary]);

  const onResetToBuiltin = useCallback(() => {
    if (!dockRef.current) return;
    if (!window.confirm("Reset to the built-in default layout for this table?")) return;
    clearActiveLayout(userId, tableId);
    const next = builtinDefaultLayout({ isHost });
    dockRef.current.loadLayout(next);
    saveActiveLayout(userId, tableId, next);
  }, [isHost, userId, tableId]);

  const onAddPanel = useCallback((id: ModuleId) => {
    if (!dockRef.current) return;
    const mod = MODULES[id];
    if (!mod) return;
    const tab: TabData = {
      id: `${id}-${Date.now()}`,
      title: mod.title,
      content: <ModuleContainer moduleId={id} />,
      closable: true,
      group: "default",
    };
    // Drop into the current layout root (rc-dock will pick a sensible spot).
    dockRef.current.dockMove(tab, null, "float");
  }, []);

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------
  return (
    <LiveContext.Provider value={liveCtx}>
      <div className="mk-workspace">
        <LayoutMenu
          library={library}
          onSaveAs={onSaveAs}
          onLoad={onLoad}
          onDelete={onDelete}
          onSetDefault={onSetDefault}
          onResetToBuiltin={onResetToBuiltin}
          onAddPanel={onAddPanel}
        />
        <div className="mk-workspace__dock">
          <DockLayout
            ref={dockRef}
            defaultLayout={initialLayout as never}
            loadTab={loadTab}
            onLayoutChange={handleLayoutChange}
            style={{ position: "absolute", inset: 0 }}
          />
        </div>
      </div>
    </LiveContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// ModuleContainer — reads the live snapshot/send pair from context so
// every snapshot update re-renders this panel even though rc-dock
// caches the React element across renders (its DockTabPane is
// PureComponent and would otherwise short-circuit prop diffs).
// ---------------------------------------------------------------------------

function ModuleContainer(props: { readonly moduleId: ModuleId }): ReactNode {
  const { moduleId } = props;
  const ctx = useLive();
  const mod = MODULES[moduleId];
  if (!mod) return <div className="mk-loading">Unknown module: {moduleId}</div>;
  const px = ctx.fontSizeFor(moduleId);
  const overridden = ctx.hasFontSizeOverride(moduleId);
  return (
    <div className="mk-module" style={{ fontSize: `${px}px` }}>
      <div className="mk-module__toolbar">
        <button
          type="button" className="mk-module__zoom"
          onClick={() => ctx.setFontSizeFor(moduleId, px - 1)}
          title="Smaller"
          aria-label="Decrease font size"
        >A−</button>
        <span className="mk-module__zoom-readout">{px}{overridden ? "" : "*"}</span>
        <button
          type="button" className="mk-module__zoom"
          onClick={() => ctx.setFontSizeFor(moduleId, px + 1)}
          title="Larger"
          aria-label="Increase font size"
        >A+</button>
        {overridden ? (
          <button
            type="button" className="mk-module__zoom"
            onClick={() => ctx.setFontSizeFor(moduleId, null)}
            title="Reset to workspace default"
            aria-label="Reset font size to global"
          >↺</button>
        ) : null}
      </div>
      <div className="mk-module__body">
        {mod.render({ snapshot: ctx.snapshot, send: ctx.send })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LayoutMenu — top-bar menu for the layout library.
// ---------------------------------------------------------------------------

interface LayoutMenuProps {
  readonly library: LayoutLibrary;
  onSaveAs(): void;
  onLoad(name: string): void;
  onDelete(name: string): void;
  onSetDefault(name: string | null): void;
  onResetToBuiltin(): void;
  onAddPanel(id: ModuleId): void;
}

function LayoutMenu(props: LayoutMenuProps): ReactNode {
  const [open, setOpen] = useState<"layout" | "add" | null>(null);
  const names = Object.keys(props.library.layouts).sort();

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="mk-workspace__menubar" onClick={(e) => e.stopPropagation()}>
      <div className="mk-menu">
        <button
          className="mk-button mk-button--small"
          onClick={() => setOpen(open === "layout" ? null : "layout")}
        >
          Layout ▾
        </button>
        {open === "layout" ? (
          <div className="mk-menu__panel">
            <button className="mk-menu__item" onClick={() => { setOpen(null); props.onSaveAs(); }}>
              Save current as…
            </button>
            <div className="mk-menu__sep">Load</div>
            <button
              className="mk-menu__item"
              onClick={() => { setOpen(null); props.onLoad(BUILTIN_DEFAULT_NAME); }}
            >
              {BUILTIN_DEFAULT_NAME}
            </button>
            {names.length === 0 ? (
              <div className="mk-menu__hint">(no saved layouts)</div>
            ) : (
              names.map((name) => (
                <div className="mk-menu__row" key={name}>
                  <button
                    className="mk-menu__item mk-menu__item--grow"
                    onClick={() => { setOpen(null); props.onLoad(name); }}
                  >
                    {name}
                    {props.library.defaultName === name ? " ★" : ""}
                  </button>
                  <button
                    className="mk-menu__icon"
                    title={props.library.defaultName === name ? "Unset as default" : "Set as default"}
                    onClick={() => props.onSetDefault(props.library.defaultName === name ? null : name)}
                  >
                    ★
                  </button>
                  <button
                    className="mk-menu__icon"
                    title="Delete"
                    onClick={() => { setOpen(null); props.onDelete(name); }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
            <div className="mk-menu__sep" />
            <button className="mk-menu__item" onClick={() => { setOpen(null); props.onResetToBuiltin(); }}>
              Reset this table to built-in
            </button>
          </div>
        ) : null}
      </div>

      <div className="mk-menu">
        <button
          className="mk-button mk-button--small"
          onClick={() => setOpen(open === "add" ? null : "add")}
        >
          + Add panel ▾
        </button>
        {open === "add" ? (
          <div className="mk-menu__panel">
            {ALL_MODULE_IDS.map((id) => (
              <button
                key={id}
                className="mk-menu__item"
                onClick={() => { setOpen(null); props.onAddPanel(id); }}
              >
                {MODULES[id].title}
              </button>
            ))}
          </div>
        ) : null}
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// filterLayout — strip host-only modules when the viewer isn't the host.
// Walks the LayoutBase tree, removing tabs whose id is host-only when
// isHost is false. Empty panels and boxes are pruned.
// ---------------------------------------------------------------------------

function filterLayout(layout: LayoutBase, isHost: boolean): LayoutBase {
  if (isHost) return layout;
  const dockbox = pruneNode(layout.dockbox as unknown as PruneNode);
  return { ...layout, dockbox: (dockbox ?? layout.dockbox) as LayoutBase["dockbox"] };
}

/** Loose shape used while walking the saved layout — rc-dock's Box/Panel
 *  union narrows by the presence of `tabs` vs `children`. */
interface PruneNode {
  mode?: string;
  size?: number;
  children?: PruneNode[];
  tabs?: Array<{ id?: string }>;
}

function pruneNode(node: PruneNode | undefined): PruneNode | undefined {
  if (!node) return undefined;
  if (node.tabs) {
    const tabs = node.tabs.filter((t) => {
      const id = String(t.id ?? "");
      const mod = MODULES[id as ModuleId];
      return !mod?.hostOnly;
    });
    if (tabs.length === 0) return undefined;
    return { ...node, tabs };
  }
  if (node.children) {
    const children = node.children.map(pruneNode).filter((c): c is PruneNode => !!c);
    if (children.length === 0) return undefined;
    return { ...node, children };
  }
  return node;
}
