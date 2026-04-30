// =============================================================================
// SetupScreen — host-controlled configuration before the market opens.
// Non-host viewers see a read-only summary.
// =============================================================================

import { useMemo, useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { LibraryEntryView } from "../useMockerySession";
import { ContractsEditor } from "../setup/ContractsEditor";
import { EventQueueEditor } from "../setup/EventQueueEditor";
import { BotEntitiesEditor } from "../setup/BotEntitiesEditor";
import { CodeBookEditor } from "../setup/CodeBookEditor";
import { GameOptionsEditor } from "../setup/GameOptionsEditor";
import { IdentityRevealEditor } from "../setup/IdentityRevealEditor";
import { RejectionChip } from "../components/RejectionChip";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  readonly library: readonly LibraryEntryView[] | null;
  readonly lastRejection: string | null;
  clearRejection(): void;
}

export function SetupScreen(props: Props): ReactNode {
  const { snapshot, send, library, lastRejection, clearRejection } = props;
  const isHost = snapshot.viewer.userId === snapshot.tableHostUserId;

  if (!isHost) return <NonHostSetup snapshot={snapshot} />;
  return <HostSetup snapshot={snapshot} send={send} library={library} lastRejection={lastRejection} clearRejection={clearRejection} />;
}

function HostSetup({
  snapshot, send, library, lastRejection, clearRejection,
}: Props): ReactNode {
  const opts = snapshot.options;
  const ready =
    snapshot.contracts.length > 0 &&
    snapshot.eventQueue.length > 0;

  return (
    <div className="mk-setup">
      <header className="mk-setup__header">
        <h1>Mockery — table setup</h1>
        <p className="mk-setup__subtitle">
          {opts.informedSeats} informed · {opts.uninformedSeats} uninformed ·
          {" "}{opts.publicSlots} public · deck {opts.cardValues.join(",")} × {opts.copiesPerValue}
        </p>
        {lastRejection ? (
          <RejectionChip text={lastRejection} onDismiss={clearRejection} />
        ) : null}
      </header>

      <section className="mk-setup__section">
        <h2>Game options</h2>
        <GameOptionsEditor snapshot={snapshot} send={send} />
      </section>

      <section className="mk-setup__section">
        <h2>Contracts</h2>
        <ContractsEditor snapshot={snapshot} send={send} library={library} />
      </section>

      <section className="mk-setup__section">
        <h2>Event mode &amp; queue</h2>
        <EventModePicker snapshot={snapshot} send={send} />
        <EventQueueEditor snapshot={snapshot} send={send} setupPhase />
      </section>

      <section className="mk-setup__section">
        <h2>Bot entities</h2>
        <BotEntitiesEditor snapshot={snapshot} send={send} />
      </section>

      <section className="mk-setup__section">
        <h2>Participant codes</h2>
        <CodeBookEditor snapshot={snapshot} send={send} />
      </section>

      <section className="mk-setup__section">
        <h2>Identity reveal</h2>
        <IdentityRevealEditor snapshot={snapshot} send={send} />
      </section>

      <footer className="mk-setup__footer">
        <button
          type="button"
          className="mk-button mk-button--primary mk-button--large"
          disabled={!ready}
          onClick={() => send({ type: "START_TRADING" })}
        >
          Start Trading
        </button>
        {!ready ? (
          <p className="mk-setup__hint">
            {snapshot.contracts.length === 0 ? "Add at least one contract. " : ""}
            {snapshot.eventQueue.length === 0 ? "Queue at least one event. " : ""}
          </p>
        ) : null}
      </footer>
    </div>
  );
}

function NonHostSetup({ snapshot }: { snapshot: ProjectedSnapshot }): ReactNode {
  const hostName = useMemo(() => {
    const hostKey = `p:${snapshot.tableHostUserId}`;
    return snapshot.participants.find((p) => snapshot.options.identityRevealList.length === 0)?.code ?? hostKey;
  }, [snapshot]);
  void hostName;
  return (
    <div className="mk-setup mk-setup--readonly">
      <h1>Waiting for the host to start trading</h1>
      <p>Mode: <strong>{snapshot.eventMode}</strong></p>
      <p>Contracts queued: <strong>{snapshot.contracts.length}</strong></p>
      <p>Events in the queue: <strong>{snapshot.eventQueue.length}</strong></p>
      <p>Bot entities: <strong>{snapshot.botEntities.length}</strong></p>
      <ul className="mk-setup__contracts">
        {snapshot.contracts.map((c) => (
          <li key={c.id}>
            <strong>{c.name}</strong> — {c.description}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventModePicker({
  snapshot, send,
}: {
  snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}): ReactNode {
  const [mode, setMode] = useState(snapshot.eventMode);
  return (
    <div className="mk-mode-picker">
      <label>
        <input
          type="radio" name="mk-mode" value="auto" checked={mode === "auto"}
          onChange={() => { setMode("auto"); send({ type: "SETUP_SET_EVENT_MODE", mode: "auto" }); }}
        />
        Auto (timer fires events)
      </label>
      <label>
        <input
          type="radio" name="mk-mode" value="manual" checked={mode === "manual"}
          onChange={() => { setMode("manual"); send({ type: "SETUP_SET_EVENT_MODE", mode: "manual" }); }}
        />
        Manual (host fires events)
      </label>
    </div>
  );
}
