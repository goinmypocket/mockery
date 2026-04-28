// =============================================================================
// FinishedScreen — game-over summary.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";

interface Props {
  readonly snapshot: ProjectedSnapshot;
}

export function FinishedScreen({ snapshot }: Props): ReactNode {
  const settled = snapshot.settlements ?? {};
  return (
    <div className="mk-finished">
      <h1>Game over</h1>
      <h2>Final cards</h2>
      <ul className="mk-finished__cards">
        {snapshot.publicCards.map((v, i) => (
          <li key={i}>Public {i}: {v ?? "?"}</li>
        ))}
      </ul>

      <h2>Contract settlements</h2>
      <table className="mk-table">
        <thead><tr><th>Contract</th><th>Settle</th></tr></thead>
        <tbody>
          {snapshot.contracts.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className="mk-num">{settled[c.id] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Final PnL</h2>
      <table className="mk-table">
        <thead><tr><th>Code</th><th>Name</th><th>PnL</th></tr></thead>
        <tbody>
          {snapshot.participants.map((p) => (
            <tr key={p.code}>
              <td className="mk-code">{p.code}</td>
              <td>{p.displayName ?? "—"}</td>
              <td className="mk-num">{(snapshot.pnlByCode[p.code] ?? 0).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
