// =============================================================================
// Bot entities editor. Each entity is a 2-letter code; the host
// optionally binds a server-registered strategy id.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import { listStrategies } from "../../server/bots/registry";
import type { WireStrategySpec } from "../../server/bots/config";
import { BotSpawnerEditor } from "./BotSpawnerEditor";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function BotEntitiesEditor({ snapshot, send }: Props): ReactNode {
  const [draftId, setDraftId] = useState("");
  const [spawnerFor, setSpawnerFor] = useState<string | null>(null);
  const strategies = listStrategies();
  const entities = snapshot.botEntities;
  const ids = entities.map((e) => e.entityId);
  const strategyById = new Map(strategies.map((s) => [s.id, s]));

  const submit = (): void => {
    const next = ids.includes(draftId.toUpperCase())
      ? ids
      : [...ids, draftId.toUpperCase()];
    send({ type: "SETUP_SET_BOT_ENTITIES", entityIds: next });
    setDraftId("");
  };

  const remove = (entityId: string): void => {
    const next = ids.filter((id) => id !== entityId);
    send({ type: "SETUP_SET_BOT_ENTITIES", entityIds: next });
  };

  return (
    <div className="mk-bots">
      {entities.length === 0 ? (
        <p className="mk-muted">No bots configured.</p>
      ) : (
        <table className="mk-table">
          <thead>
            <tr><th>Entity</th><th>Strategy</th><th></th><th></th></tr>
          </thead>
          <tbody>
            {entities.map((e) => (
              <tr key={e.entityId}>
                <td className="mk-code">{e.entityId}</td>
                <td>
                  <select
                    value={e.strategyId ?? ""}
                    onChange={(ev) => send({
                      type: "SETUP_BIND_BOT_STRATEGY",
                      entityId: e.entityId,
                      strategyId: ev.target.value || null,
                    })}
                  >
                    <option value="">(none)</option>
                    {strategies.map((s) => (
                      <option key={s.id} value={s.id}>{s.displayName}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button" className="mk-button mk-button--small"
                    title="Configure as multi-profile spawner (overrides strategy binding)"
                    onClick={() => setSpawnerFor(e.entityId)}
                    disabled={!e.strategyId || !strategyById.get(e.strategyId)?.defaultProfileDistributions}
                  >Configure…</button>
                </td>
                <td>
                  <button
                    type="button" className="mk-button mk-button--small mk-button--danger"
                    onClick={() => remove(e.entityId)}
                  >×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {spawnerFor !== null && (() => {
        const entity = entities.find((e) => e.entityId === spawnerFor);
        const strat = entity?.strategyId ? strategyById.get(entity.strategyId) : undefined;
        if (!entity || !strat) { setSpawnerFor(null); return null; }
        const currentConfig = (entity.config as { strategies?: WireStrategySpec[] } | null | undefined)
          ?.strategies?.[0] ?? null;
        return (
          <BotSpawnerEditor
            entityId={entity.entityId}
            strategy={strat}
            initial={currentConfig}
            send={send}
            onClose={() => setSpawnerFor(null)}
          />
        );
      })()}

      <div className="mk-bots__add">
        <input
          value={draftId}
          onChange={(e) => setDraftId(e.target.value.slice(0, 2).toUpperCase())}
          placeholder="2-letter id"
          maxLength={2}
        />
        <button
          type="button" className="mk-button"
          onClick={submit}
          disabled={draftId.length !== 2}
        >Add bot entity</button>
      </div>
    </div>
  );
}
