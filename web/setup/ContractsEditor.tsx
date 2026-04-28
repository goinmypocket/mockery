// =============================================================================
// Contracts editor — host adds/removes/replaces table contracts. The
// host can also import from the shared library by id.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { ContractDef } from "../../shared/types";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function ContractsEditor({ snapshot, send }: Props): ReactNode {
  const [editing, setEditing] = useState<ContractDef | "new" | null>(null);

  return (
    <div className="mk-contracts">
      <div className="mk-contracts__library">
        <h4>Shared library</h4>
        <p className="mk-muted">Quick import:</p>
        <SharedImportButtons send={send} />
      </div>

      <div className="mk-contracts__current">
        <h4>This table</h4>
        {snapshot.contracts.length === 0 ? (
          <p className="mk-muted">No contracts yet.</p>
        ) : (
          <ul className="mk-contracts__list">
            {snapshot.contracts.map((c) => (
              <li key={c.id} className="mk-contracts__item">
                <div>
                  <strong>{c.name}</strong>
                  <p className="mk-muted">{c.description}</p>
                </div>
                <div className="mk-contracts__actions">
                  <button type="button" className="mk-button" onClick={() => setEditing(c)}>Edit</button>
                  <button
                    type="button" className="mk-button mk-button--danger"
                    onClick={() => send({ type: "SETUP_REMOVE_CONTRACT", contractId: c.id })}
                  >Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="mk-button" onClick={() => setEditing("new")}>+ New contract</button>
      </div>

      {editing !== null ? (
        <ContractModal
          existing={editing === "new" ? null : editing}
          send={send}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function SharedImportButtons({ send }: { send(msg: unknown): void }): ReactNode {
  const presets = [
    { id: "sum-all",          label: "Sum of all cards" },
    { id: "ten-times-evens",  label: "10 × even count" },
    { id: "evens-minus-odds", label: "Evens − Odds" },
  ];
  return (
    <div className="mk-contracts__shared-row">
      {presets.map((p) => (
        <button
          key={p.id} type="button" className="mk-button"
          onClick={() => send({ type: "SETUP_IMPORT_CONTRACT", source: "shared", refId: p.id })}
        >
          + {p.label}
        </button>
      ))}
    </div>
  );
}

function ContractModal({
  existing, send, onClose,
}: {
  existing: ContractDef | null;
  send(msg: unknown): void;
  onClose(): void;
}): ReactNode {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [payoffSource, setPayoffSource] = useState(
    existing?.payoffSource ?? "  return H.sum(cards);",
  );

  const submit = (): void => {
    if (existing) {
      send({
        type: "SETUP_REPLACE_CONTRACT",
        contractId: existing.id,
        name, description, payoffSource,
      });
    } else {
      send({ type: "SETUP_ADD_CONTRACT", name, description, payoffSource });
    }
    onClose();
  };

  return (
    <div className="mk-modal">
      <div className="mk-modal__panel">
        <h3>{existing ? "Edit contract" : "New contract"}</h3>
        <label className="mk-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="mk-field">
          <span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="mk-field">
          <span>Payoff source — JS body</span>
          <textarea
            rows={8} value={payoffSource} spellCheck={false}
            onChange={(e) => setPayoffSource(e.target.value)}
          />
        </label>
        <p className="mk-muted">
          Function signature: <code>function payoff(cards) {`{ ... }`}</code>.
          Helpers in <code>H</code>: <code>count, sum, sumWhere, where, max,
          min, unique, has</code>, plus <code>H.PUBLIC_START</code>.
        </p>
        <div className="mk-modal__actions">
          <button type="button" className="mk-button" onClick={onClose}>Cancel</button>
          <button type="button" className="mk-button mk-button--primary" onClick={submit}>
            {existing ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
