// =============================================================================
// PositionPnlPanel — combined positions + PnL with a tab toggle.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";

interface Props {
  readonly snapshot: ProjectedSnapshot;
}

export function PositionPnlPanel({ snapshot }: Props): ReactNode {
  const [tab, setTab] = useState<"positions" | "pnl">("positions");
  const [hideUninformed, setHideUninformed] = useState(false);
  const [hideFlat, setHideFlat] = useState(false);

  const visibleParticipants = snapshot.participants.filter((p) => {
    if (hideUninformed && p.role === "uninformed") return false;
    if (hideFlat) {
      const positions = snapshot.positionsByCode[p.code] ?? {};
      const anyOpen = Object.values(positions).some((v) => v !== 0);
      if (!anyOpen && (snapshot.pnlByCode[p.code] ?? 0) === 0) return false;
    }
    return true;
  });

  const contracts = snapshot.contracts;

  return (
    <div className="mk-positions">
      <div className="mk-positions__tabs">
        <button
          type="button"
          className={`mk-button ${tab === "positions" ? "mk-button--primary" : ""}`}
          onClick={() => setTab("positions")}
        >Positions</button>
        <button
          type="button"
          className={`mk-button ${tab === "pnl" ? "mk-button--primary" : ""}`}
          onClick={() => setTab("pnl")}
        >PnL</button>
        <span className="mk-positions__filters">
          <label className="mk-checkbox">
            <input type="checkbox" checked={hideUninformed}
              onChange={(e) => setHideUninformed(e.target.checked)} /> Hide uninformed
          </label>
          <label className="mk-checkbox">
            <input type="checkbox" checked={hideFlat}
              onChange={(e) => setHideFlat(e.target.checked)} /> Hide flat
          </label>
        </span>
      </div>

      <table className="mk-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Role</th>
            {contracts.map((c) => <th key={c.id}>{c.name}</th>)}
            {tab === "pnl" ? <th>Total</th> : null}
          </tr>
        </thead>
        <tbody>
          {visibleParticipants.map((p) => {
            const positions = snapshot.positionsByCode[p.code] ?? {};
            const contractPnl = snapshot.contractPnlByCode[p.code] ?? {};
            const pnl = snapshot.pnlByCode[p.code] ?? 0;
            return (
              <tr key={p.code}>
                <td className="mk-code">{p.code}{p.role === "bot" ? " 🤖" : ""}</td>
                <td className="mk-muted">{p.role}</td>
                {contracts.map((c) => {
                  if (tab === "pnl") {
                    const cp = contractPnl[c.id] ?? 0;
                    return (
                      <td key={c.id} className={`mk-num ${cp < 0 ? "mk-neg" : ""}`}>
                        {cp === 0 ? "—" : cp.toFixed(2)}
                      </td>
                    );
                  }
                  const v = positions[c.id] ?? 0;
                  return (
                    <td key={c.id} className={`mk-num ${v < 0 ? "mk-neg" : ""}`}>
                      {v === 0 ? "—" : v}
                    </td>
                  );
                })}
                {tab === "pnl" ? (
                  <td className={`mk-num ${pnl < 0 ? "mk-neg" : ""}`}>{pnl.toFixed(2)}</td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
