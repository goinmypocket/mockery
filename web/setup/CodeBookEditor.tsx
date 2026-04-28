// =============================================================================
// Participant codes editor. Per-participant 2-letter input with
// validation feedback. Plus a Reshuffle button.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import { isValidCode } from "../../shared/types";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function CodeBookEditor({ snapshot, send }: Props): ReactNode {
  return (
    <div className="mk-codes">
      <div className="mk-codes__topline">
        <button
          type="button" className="mk-button"
          onClick={() => send({ type: "SETUP_RESHUFFLE_CODES" })}
        >Reshuffle</button>
        <p className="mk-muted">
          Codes follow <strong>{snapshot.options.codeMode}</strong> mode
          {snapshot.options.enforceCaseByRole ? " (enforced case by role)" : ""}.
        </p>
      </div>

      <table className="mk-table">
        <thead><tr><th>Display name</th><th>Role</th><th>Code</th></tr></thead>
        <tbody>
          {snapshot.participants.map((p) => (
            <CodeRow key={p.code} code={p.code} role={p.role}
              displayName={p.displayName ?? "(redacted)"}
              participantKey={p.participantKey}
              send={send}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeRow({
  code, role, displayName, participantKey, send,
}: {
  code: string;
  role: "informed" | "uninformed" | "bot";
  displayName: string;
  participantKey: string | null;
  send(msg: unknown): void;
}): ReactNode {
  const [draft, setDraft] = useState(code);
  const valid = isValidCode(draft);
  const dirty = draft !== code;

  return (
    <tr>
      <td>{displayName}</td>
      <td>{role}</td>
      <td>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 2))}
          maxLength={2}
          className={`mk-code-input ${!valid ? "mk-code-input--invalid" : ""}`}
        />
        {dirty && valid && participantKey ? (
          <button
            type="button" className="mk-button mk-button--small"
            onClick={() => send({ type: "SETUP_SET_CODE", participantKey, code: draft })}
          >save</button>
        ) : null}
      </td>
    </tr>
  );
}

