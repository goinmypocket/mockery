// =============================================================================
// GameOptionsEditor — host-only editor for game options that don't
// affect player count. Bound to SETUP_SET_GAME_OPTIONS, which mirrors
// the validation in normalizeMockeryOptions.
// =============================================================================

import { useEffect, useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { CodeMode } from "../../shared/types";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function GameOptionsEditor({ snapshot, send }: Props): ReactNode {
  const opts = snapshot.options;
  const [publicSlots, setPublicSlots] = useState(opts.publicSlots);
  const [copiesPerValue, setCopiesPerValue] = useState(opts.copiesPerValue);
  const [cardValuesCsv, setCardValuesCsv] = useState(opts.cardValues.join(","));
  const [eventIntervalMin, setEventIntervalMin] = useState(opts.eventIntervalMin);
  const [eventIntervalMax, setEventIntervalMax] = useState(opts.eventIntervalMax);
  const [endGameGraceSec, setEndGameGraceSec] = useState(opts.endGameGraceSec);
  const [codeMode, setCodeMode] = useState<CodeMode>(opts.codeMode);
  const [enforceCaseByRole, setEnforceCaseByRole] = useState(opts.enforceCaseByRole);

  // Re-sync when the server pushes new options (e.g. another host action
  // updated something we don't show, or the snapshot rehydrates).
  useEffect(() => {
    setPublicSlots(opts.publicSlots);
    setCopiesPerValue(opts.copiesPerValue);
    setCardValuesCsv(opts.cardValues.join(","));
    setEventIntervalMin(opts.eventIntervalMin);
    setEventIntervalMax(opts.eventIntervalMax);
    setEndGameGraceSec(opts.endGameGraceSec);
    setCodeMode(opts.codeMode);
    setEnforceCaseByRole(opts.enforceCaseByRole);
  }, [opts]);

  function commit(patch: Record<string, unknown>): void {
    send({ type: "SETUP_SET_GAME_OPTIONS", ...patch });
  }

  return (
    <div className="mk-options">
      <div className="mk-options__row">
        <label>
          Public hidden cards
          <input
            type="number" min={0}
            value={publicSlots}
            onChange={(e) => setPublicSlots(Number(e.target.value))}
            onBlur={() => commit({ publicSlots })}
          />
        </label>
        <label>
          Copies per card value
          <input
            type="number" min={1}
            value={copiesPerValue}
            onChange={(e) => setCopiesPerValue(Number(e.target.value))}
            onBlur={() => commit({ copiesPerValue })}
          />
        </label>
      </div>

      <div className="mk-options__row">
        <label className="mk-options__wide">
          Card values (CSV)
          <input
            type="text"
            value={cardValuesCsv}
            onChange={(e) => setCardValuesCsv(e.target.value)}
            onBlur={() => commit({ cardValuesCsv })}
            placeholder="1,2,9,10"
          />
        </label>
      </div>

      {snapshot.eventMode === "auto" ? (
        <div className="mk-options__row">
          <label>
            Auto interval min (sec)
            <input
              type="number" min={1}
              value={eventIntervalMin}
              onChange={(e) => setEventIntervalMin(Number(e.target.value))}
              onBlur={() => commit({ eventIntervalMin })}
            />
          </label>
          <label>
            Auto interval max (sec)
            <input
              type="number" min={1}
              value={eventIntervalMax}
              onChange={(e) => setEventIntervalMax(Number(e.target.value))}
              onBlur={() => commit({ eventIntervalMax })}
            />
          </label>
        </div>
      ) : (
        <div className="mk-options__row">
          <label>
            End-game grace (sec, manual)
            <input
              type="number" min={0}
              value={endGameGraceSec}
              onChange={(e) => setEndGameGraceSec(Number(e.target.value))}
              onBlur={() => commit({ endGameGraceSec })}
            />
          </label>
        </div>
      )}

      <div className="mk-options__row">
        <label>
          Participant code mode
          <select
            value={codeMode}
            onChange={(e) => {
              const v = e.target.value as CodeMode;
              setCodeMode(v);
              commit({ codeMode: v });
            }}
          >
            <option value="alpha">alpha (initials)</option>
            <option value="random">random</option>
          </select>
        </label>
        <label className="mk-options__check">
          <input
            type="checkbox"
            checked={enforceCaseByRole}
            onChange={(e) => {
              const v = e.target.checked;
              setEnforceCaseByRole(v);
              commit({ enforceCaseByRole: v });
            }}
          />
          Enforce case (uppercase = informed)
        </label>
      </div>
    </div>
  );
}
