// =============================================================================
// Contracts editor — three columns: shared library (read-only built-ins),
// my library (per-user CRUD), and the contracts pinned to this table.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { ContractDef } from "../../shared/types";
import type { LibraryEntryView } from "../useMockerySession";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  readonly library: readonly LibraryEntryView[] | null;
}

type EditTarget =
  | { kind: "new" }
  | { kind: "table"; entry: ContractDef }
  | { kind: "library"; entry: LibraryEntryView };

export function ContractsEditor({ snapshot, send, library }: Props): ReactNode {
  const [editing, setEditing] = useState<EditTarget | null>(null);

  return (
    <div className="mk-contracts">
      <div className="mk-contracts__library">
        <h4>Shared library</h4>
        <p className="mk-muted">Built-ins, quick import:</p>
        <SharedImportButtons send={send} />
      </div>

      <div className="mk-contracts__library">
        <h4>My library</h4>
        {library === null ? (
          <p className="mk-muted">Loading…</p>
        ) : library.length === 0 ? (
          <p className="mk-muted">Empty. Save a contract to reuse it later.</p>
        ) : (
          <ul className="mk-contracts__list">
            {library.map((e) => (
              <li key={e.id} className="mk-contracts__item">
                <div>
                  <strong>{e.name}</strong>
                  <p className="mk-muted">{e.description}</p>
                </div>
                <div className="mk-contracts__actions">
                  <button
                    type="button" className="mk-button"
                    onClick={() => send({
                      type: "SETUP_ADD_CONTRACT",
                      name: e.name, description: e.description,
                      payoffSource: e.payoffSource,
                    })}
                    title="Copy into this table"
                  >→ Table</button>
                  <button
                    type="button" className="mk-button"
                    onClick={() => setEditing({ kind: "library", entry: e })}
                  >Edit</button>
                  <button
                    type="button" className="mk-button mk-button--danger"
                    onClick={() => {
                      if (window.confirm(`Delete "${e.name}" from your library?`)) {
                        send({ type: "LIBRARY_DELETE", id: e.id });
                      }
                    }}
                  >Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
                  <button type="button" className="mk-button" onClick={() => setEditing({ kind: "table", entry: c })}>Edit</button>
                  <button
                    type="button" className="mk-button"
                    onClick={() => send({
                      type: "LIBRARY_SAVE",
                      name: c.name, description: c.description,
                      payoffSource: c.payoffSource,
                    })}
                    title="Save to my library"
                  >Save → Library</button>
                  <button
                    type="button" className="mk-button mk-button--danger"
                    onClick={() => send({ type: "SETUP_REMOVE_CONTRACT", contractId: c.id })}
                  >Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="mk-button" onClick={() => setEditing({ kind: "new" })}>+ New contract</button>
      </div>

      {editing !== null ? (
        <ContractModal target={editing} send={send} onClose={() => setEditing(null)} />
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
  target, send, onClose,
}: {
  target: EditTarget;
  send(msg: unknown): void;
  onClose(): void;
}): ReactNode {
  const initial = target.kind === "new"
    ? { name: "", description: "", payoffSource: "  return H.sum(cards);" }
    : target.entry;
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [payoffSource, setPayoffSource] = useState(initial.payoffSource);

  const submit = (): void => {
    if (target.kind === "table") {
      send({
        type: "SETUP_REPLACE_CONTRACT",
        contractId: target.entry.id,
        name, description, payoffSource,
      });
    } else if (target.kind === "library") {
      send({
        type: "LIBRARY_UPDATE",
        id: target.entry.id,
        name, description, payoffSource,
      });
    } else {
      send({ type: "SETUP_ADD_CONTRACT", name, description, payoffSource });
    }
    onClose();
  };

  const submitAlt = (): void => {
    // Secondary action: from "new" → save to library too; from "table" →
    // save current edits to library; from "library" → no-op.
    if (target.kind === "new" || target.kind === "table") {
      send({ type: "LIBRARY_SAVE", name, description, payoffSource });
    }
  };

  const heading =
    target.kind === "new"     ? "New contract"
  : target.kind === "table"   ? "Edit table contract"
  :                             "Edit library contract";

  return (
    <div className="mk-modal">
      <div className="mk-modal__panel">
        <h3>{heading}</h3>
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
          {(target.kind === "new" || target.kind === "table") ? (
            <button type="button" className="mk-button" onClick={submitAlt}>
              Save to library
            </button>
          ) : null}
          <button type="button" className="mk-button mk-button--primary" onClick={submit}>
            {target.kind === "new" ? "Add to table" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
