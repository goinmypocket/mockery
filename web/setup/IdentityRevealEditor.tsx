// =============================================================================
// Identity reveal editor — who sees the code↔name mapping.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { IdentityReveal } from "../../shared/types";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function IdentityRevealEditor({ snapshot, send }: Props): ReactNode {
  const mode = snapshot.identityReveal;
  const set = (m: IdentityReveal): void => send({ type: "SETUP_SET_IDENTITY_REVEAL", mode: m });
  return (
    <div className="mk-identity">
      <div className="mk-identity__radios">
        <label>
          <input type="radio" checked={mode === "all"} onChange={() => set("all")} /> Everyone
        </label>
        <label>
          <input type="radio" checked={mode === "host"} onChange={() => set("host")} /> Host only
        </label>
        <label>
          <input type="radio" checked={mode === "listed"} onChange={() => set("listed")} /> Listed
        </label>
      </div>
      {mode === "listed" ? (
        <p className="mk-muted">List management coming in a follow-up. For now, falls back to host-only behaviour for non-listed viewers.</p>
      ) : null}
    </div>
  );
}
