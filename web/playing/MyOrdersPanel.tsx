// =============================================================================
// MyOrdersPanel — your resting orders, with a per-row Cancel.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function MyOrdersPanel({ snapshot, send }: Props): ReactNode {
  const orders = snapshot.myOpenOrders;
  const contractName = (id: string) => snapshot.contracts.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="mk-myorders">
      {orders.length === 0 ? (
        <p className="mk-muted">No resting orders.</p>
      ) : (
        <table className="mk-table">
          <thead>
            <tr><th>Contract</th><th>Side</th><th>Price</th><th>Qty</th><th></th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{contractName(o.contractId)}</td>
                <td className={o.side === "buy" ? "mk-bid" : "mk-offer"}>{o.side}</td>
                <td className="mk-num">{o.price}</td>
                <td className="mk-num">{o.qty}</td>
                <td>
                  <button
                    type="button" className="mk-button mk-button--small mk-button--danger"
                    onClick={() => send({ type: "CANCEL_ORDER", orderId: o.id })}
                  >Cancel</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
