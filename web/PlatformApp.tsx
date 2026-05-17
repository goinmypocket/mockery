// =============================================================================
// PlatformApp — the entry the In My Pocket platform shell mounts when
// `tableMeta.status === "playing"`. Mockery handles its own sub-states
// (`setup`, `playing`, `finished`) inside the shell.
//
// `finished` reuses the playing workspace rather than swapping to a
// dedicated screen, so the trades panel, revealed cards, and final
// PnL stay visible in the same dock the players were trading in.
// =============================================================================

import { useEffect, type ReactNode } from "react";
import type { PlatformGameContext } from "./types";
import { useMockerySession } from "./useMockerySession";
import { SetupScreen } from "./screens/SetupScreen";
import { PlayingScreen } from "./screens/PlayingScreen";

// rc-dock ships separate light/dark sheets. Import them as URLs and
// inject as media-gated <link>s below so the browser activates only
// the one matching the user's prefers-color-scheme.
import rcDockLightUrl from "rc-dock/dist/rc-dock.css?url";
import rcDockDarkUrl from "rc-dock/dist/rc-dock-dark.css?url";

import "./styles/reset.css";
import "./styles/app.css";

export type { PlatformGameContext };

interface Props {
  readonly ctx: PlatformGameContext;
}

export default function PlatformApp({ ctx }: Props): ReactNode {
  useRcDockThemedStylesheet();
  const session = useMockerySession(ctx);

  if (!session.snapshot) {
    return (
      <div className="mk-loading">
        <p>Loading game state…</p>
      </div>
    );
  }

  const status = session.snapshot.status;
  if (status === "lobby") {
    // Platform owns the lobby UI; this branch shouldn't normally render
    // but we surface a fallback in case the shell mounted us early.
    return <div className="mk-loading"><p>Waiting for lobby…</p></div>;
  }
  if (status === "setup") {
    return (
      <SetupScreen
        snapshot={session.snapshot}
        send={session.send}
        library={session.library}
        lastRejection={session.lastRejection}
        clearRejection={session.clearRejection}
      />
    );
  }
  // `playing` and `finished` both render the workspace — the engine
  // already rejects orders post-finish, and the panels self-reveal
  // (cards, settled PnL) when status flips to finished.
  return (
    <PlayingScreen
      snapshot={session.snapshot}
      send={session.send}
      userId={ctx.userId}
      tableId={ctx.tableId}
      lastRejection={session.lastRejection}
      clearRejection={session.clearRejection}
    />
  );
}

/** Mount both rc-dock stylesheets, each gated to its color-scheme via
 *  the `media` attribute — the browser activates only the matching
 *  one and re-evaluates automatically when the user flips theme. */
function useRcDockThemedStylesheet(): void {
  useEffect(() => {
    const make = (href: string, media: string): HTMLLinkElement => {
      const el = document.createElement("link");
      el.rel = "stylesheet";
      el.href = href;
      el.media = media;
      el.dataset["mkRcDock"] = "1";
      document.head.appendChild(el);
      return el;
    };
    const light = make(rcDockLightUrl, "(prefers-color-scheme: light)");
    const dark = make(rcDockDarkUrl, "(prefers-color-scheme: dark)");
    return () => { light.remove(); dark.remove(); };
  }, []);
}
