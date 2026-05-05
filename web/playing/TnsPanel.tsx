// =============================================================================
// TnsPanel — time and sales. Most recent first. Phase-coloured rows.
// =============================================================================

import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";

interface Props {
  readonly snapshot: ProjectedSnapshot;
}

export function TnsPanel({ snapshot }: Props): ReactNode {
  const [filterCode, setFilterCode] = useState<string>("");
  const [filterContract, setFilterContract] = useState<string>("");
  const [aggressorOnly, setAggressorOnly] = useState(false);

  const rows = useMemo(() => {
    const list = snapshot.recentTrades.slice().reverse();
    return list.filter((t) => {
      if (filterContract && t.contractId !== filterContract) return false;
      if (filterCode) {
        const matches = t.buyerCode === filterCode || t.sellerCode === filterCode;
        if (!matches) return false;
        if (aggressorOnly) {
          const aggressorCode = t.aggressor === "buyer" ? t.buyerCode : t.sellerCode;
          if (aggressorCode !== filterCode) return false;
        }
      }
      return true;
    });
  }, [snapshot.recentTrades, filterCode, filterContract, aggressorOnly]);

  const codes = Array.from(new Set(snapshot.participants.map((p) => p.code))).sort();
  const contractName = (id: string) => snapshot.contracts.find((c) => c.id === id)?.name ?? id;
  // Stable contract ordinal so we can hand each one a distinct color.
  const contractIndex: Record<string, number> = {};
  snapshot.contracts.forEach((c, i) => { contractIndex[c.id] = i; });

  return (
    <div className="mk-tns">
      <div className="mk-tns__filters">
        <select value={filterCode} onChange={(e) => setFilterCode(e.target.value)}>
          <option value="">All participants</option>
          {codes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filterContract} onChange={(e) => setFilterContract(e.target.value)}>
          <option value="">All contracts</option>
          {snapshot.contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {filterCode ? (
          <label className="mk-checkbox">
            <input type="checkbox" checked={aggressorOnly}
              onChange={(e) => setAggressorOnly(e.target.checked)} />
            Aggressor only
          </label>
        ) : null}
      </div>

      <table className="mk-table mk-tns__table">
        <thead>
          <tr>
            <th>Time</th>
            <th>P</th>
            <th>Buyer</th>
            <th>Seller</th>
            <th>Contract</th>
            <th>Price</th>
            <th>Qty</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
            const cidx = contractIndex[t.contractId] ?? 0;
            // Insert a divider BETWEEN rows when phase differs from
            // the newer (i-1) neighbour. Rows are newest-first, so the
            // divider visually separates the newer phase block (above)
            // from the older block (below) and labels the boundary
            // itself with the phase that just began.
            const newer = i > 0 ? rows[i - 1] : null;
            const divider =
              newer && newer.phase !== t.phase ? (
                <tr className="mk-tns__divider">
                  <td colSpan={7}>Phase {newer.phase}</td>
                </tr>
              ) : null;
            return (
              <Fragment key={t.id}>
                {divider}
                <tr
                  className={`mk-tns__row mk-phase-${t.phase % 6} mk-contract-${cidx % 6}`}
                >
                  <td>{formatTime(t.ts)}</td>
                  <td className="mk-tns__phase">{t.phase}</td>
                  <td className={`mk-code mk-tns__buyer ${t.aggressor === "buyer" ? "mk-tns__aggressor" : ""}`}>{t.buyerCode}</td>
                  <td className={`mk-code mk-tns__seller ${t.aggressor === "seller" ? "mk-tns__aggressor" : ""}`}>{t.sellerCode}</td>
                  <td>{contractName(t.contractId)}</td>
                  <td className="mk-num">{t.price}</td>
                  <td className="mk-num">{t.qty}</td>
                </tr>
              </Fragment>
            );
          })}
          {rows.length === 0 ? (
            <tr><td colSpan={7} className="mk-muted">No trades yet.</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}
