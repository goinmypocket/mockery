// =============================================================================
// PlatformApp — the entry the In My Pocket platform shell mounts when
// `tableMeta.status === "playing"`. Mockery handles its own sub-states
// (`setup`, `playing`, `finished`) inside the shell.
// =============================================================================

import type { ReactNode } from "react";
import type { PlatformGameContext } from "./types";
import { useMockerySession } from "./useMockerySession";
import { SetupScreen } from "./screens/SetupScreen";
import { PlayingScreen } from "./screens/PlayingScreen";
import { FinishedScreen } from "./screens/FinishedScreen";

import "rc-dock/dist/rc-dock-dark.css";
import "./styles/reset.css";
import "./styles/app.css";

export type { PlatformGameContext };

interface Props {
  readonly ctx: PlatformGameContext;
}

export default function PlatformApp({ ctx }: Props): ReactNode {
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
  if (status === "finished") {
    return <FinishedScreen snapshot={session.snapshot} />;
  }
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
