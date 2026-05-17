// =============================================================================
// Bot spawner modal — opens from BotEntitiesEditor when the host
// wants to configure a multi-profile spawner for one bot entity.
// Pre-populates with the strategy's `defaultProfileDistributions`,
// optionally overridden by what the user previously saved to
// localStorage. Edits are submitted as a `WireBotConfigSpec` via
// `SETUP_SET_BOT_CONFIG`.
// =============================================================================

import { useMemo, useState, type ReactNode } from "react";
import type {
  Distribution,
} from "../../engine/sampling";
import type {
  WireBotConfigSpec, WireStrategySpec,
} from "../../server/bots/config";
import type { StrategyInfo } from "../../server/bots/registry";

interface Props {
  readonly entityId: string;
  readonly strategy: StrategyInfo;       // must have defaultProfileDistributions
  readonly initial?: WireStrategySpec | null;  // currently-saved spec, if any
  send(msg: unknown): void;
  onClose(): void;
}

// ---------------------------------------------------------------------------
// Persistence: per-strategy user overrides in localStorage.
// ---------------------------------------------------------------------------

const LS_KEY = (strategyId: string): string => `mk:bot-defaults:${strategyId}`;

export function loadUserDefaults(strategyId: string): Omit<WireStrategySpec, "strategyId"> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY(strategyId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveUserDefaults(
  strategyId: string,
  spec: Omit<WireStrategySpec, "strategyId">,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY(strategyId), JSON.stringify(spec));
  } catch { /* swallow quota errors */ }
}

export function clearUserDefaults(strategyId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LS_KEY(strategyId));
  } catch { /* */ }
}

// ---------------------------------------------------------------------------

export function BotSpawnerEditor({
  entityId, strategy, initial, send, onClose,
}: Props): ReactNode {
  const builtIn = strategy.defaultProfileDistributions;
  const baseDefaults = useMemo(
    () => loadUserDefaults(strategy.id) ?? builtIn,
    [strategy.id, builtIn],
  );

  // initial: existing config from server > localStorage overrides > built-in.
  const seed: Omit<WireStrategySpec, "strategyId"> = useMemo(() => {
    if (initial) {
      const { strategyId: _id, ...rest } = initial;
      return rest;
    }
    return baseDefaults ?? {
      count: { kind: "constant", value: 1 },
      spawn: { mode: "permanent" },
      lagMs: { kind: "constant", value: 0 },
      scope: "instance",
      params: {},
    };
  }, [initial, baseDefaults]);

  const [spec, setSpec] = useState<Omit<WireStrategySpec, "strategyId">>(seed);

  const apply = (): void => {
    const wire: WireBotConfigSpec = {
      strategies: [{ strategyId: strategy.id, ...spec }],
    };
    send({ type: "SETUP_SET_BOT_CONFIG", entityId, config: wire });
    onClose();
  };

  const saveAsMyDefaults = (): void => { saveUserDefaults(strategy.id, spec); };
  const resetToBuiltIn = (): void => {
    clearUserDefaults(strategy.id);
    if (builtIn) setSpec(builtIn);
  };

  const paramKeys = strategy.paramsSchema ? Object.keys(strategy.paramsSchema) : [];

  return (
    <div className="mk-modal">
      <div className="mk-modal__panel" style={{ minWidth: 520, maxHeight: "90vh", overflowY: "auto" }}>
        <h3>Configure spawner — entity {entityId} ({strategy.displayName})</h3>
        <p className="mk-muted">
          Distributions drawn once at game start to produce concrete profiles.
          Same engine seed + entityId → same draws (replayable).
        </p>

        <DistField label="count (how many profiles to draw)"
          value={spec.count} onChange={(d) => setSpec({ ...spec, count: d })} />

        <SpawnField value={spec.spawn} onChange={(s) => setSpec({ ...spec, spawn: s })} />

        <DistField label="lagMs (per-action delay in ms)"
          value={spec.lagMs} onChange={(d) => setSpec({ ...spec, lagMs: d })} />

        <label className="mk-field">
          <span>scope</span>
          <select
            value={spec.scope}
            onChange={(e) => setSpec({ ...spec, scope: e.target.value as "instance" | "shared" })}
          >
            <option value="instance">instance — independent per spawn</option>
            <option value="shared">shared — uses bot's whole position</option>
          </select>
        </label>

        {paramKeys.length > 0 && (
          <>
            <h4 style={{ marginTop: 16, marginBottom: 4 }}>Strategy params</h4>
            {paramKeys.map((k) => (
              <DistField key={k} label={k}
                value={spec.params[k] ?? { kind: "constant", value: 0 }}
                onChange={(d) => setSpec({ ...spec, params: { ...spec.params, [k]: d } })} />
            ))}
          </>
        )}

        <div className="mk-modal__actions">
          <button type="button" className="mk-button" onClick={onClose}>Cancel</button>
          <button type="button" className="mk-button" onClick={resetToBuiltIn}
            disabled={!builtIn}>Reset to built-in</button>
          <button type="button" className="mk-button" onClick={saveAsMyDefaults}>
            Save as my defaults
          </button>
          <button type="button" className="mk-button mk-button--primary" onClick={apply}>
            Apply to this entity
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spawn-mode toggle (permanent vs poisson)
// ---------------------------------------------------------------------------

function SpawnField({
  value, onChange,
}: {
  value: WireStrategySpec["spawn"];
  onChange(v: WireStrategySpec["spawn"]): void;
}): ReactNode {
  return (
    <div className="mk-field">
      <span>spawn mode</span>
      <select
        value={value.mode}
        onChange={(e) => onChange(
          e.target.value === "permanent"
            ? { mode: "permanent" }
            : { mode: "poisson", ratePerSec: { kind: "constant", value: 0.05 } },
        )}
      >
        <option value="permanent">permanent (1 instance at game start)</option>
        <option value="poisson">poisson (arrivals over time)</option>
      </select>
      {value.mode === "poisson" && (
        <div style={{ marginTop: 8 }}>
          <DistField label="ratePerSec" value={value.ratePerSec}
            onChange={(d) => onChange({ mode: "poisson", ratePerSec: d })} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Distribution editor — one row per param.
// ---------------------------------------------------------------------------

type Kind = Distribution["kind"];
const KINDS: readonly Kind[] = [
  "constant", "uniform", "uniform-int", "gaussian", "gaussian-int",
  "exponential", "exponential-int", "categorical",
];

function DistField({
  label, value, onChange,
}: {
  label: string;
  value: Distribution;
  onChange(d: Distribution): void;
}): ReactNode {
  const setKind = (k: Kind): void => onChange(zeroFor(k));
  return (
    <div className="mk-field">
      <span>{label}</span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={value.kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <DistFields value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function DistFields({
  value, onChange,
}: { value: Distribution; onChange(d: Distribution): void }): ReactNode {
  switch (value.kind) {
    case "constant":
      return <NumField label="value" value={value.value}
        onChange={(v) => onChange({ kind: "constant", value: v })} />;
    case "uniform":
    case "uniform-int":
      return <>
        <NumField label="min" value={value.min}
          onChange={(v) => onChange({ ...value, min: v })} />
        <NumField label="max" value={value.max}
          onChange={(v) => onChange({ ...value, max: v })} />
      </>;
    case "gaussian":
    case "gaussian-int":
      return <>
        <NumField label="mean" value={value.mean}
          onChange={(v) => onChange({ ...value, mean: v })} />
        <NumField label="std" value={value.std}
          onChange={(v) => onChange({ ...value, std: v })} />
        <NumField label="min" value={value.min ?? NaN} optional
          onChange={(v) => onChange(withOptional(value, "min", v))} />
        <NumField label="max" value={value.max ?? NaN} optional
          onChange={(v) => onChange(withOptional(value, "max", v))} />
      </>;
    case "exponential":
    case "exponential-int":
      return <>
        <NumField label="rate" value={value.rate}
          onChange={(v) => onChange({ ...value, rate: v })} />
        <NumField label="min" value={value.min ?? NaN} optional
          onChange={(v) => onChange(withOptional(value, "min", v))} />
        <NumField label="max" value={value.max ?? NaN} optional
          onChange={(v) => onChange(withOptional(value, "max", v))} />
      </>;
    case "categorical":
      return <CategoricalEditor value={value} onChange={onChange} />;
  }
}

function NumField({
  label, value, onChange, optional = false,
}: { label: string; value: number; onChange(n: number): void; optional?: boolean }): ReactNode {
  const displayed = Number.isFinite(value) ? String(value) : "";
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", fontSize: "0.85em", color: "var(--mk-muted)" }}>
      {label}
      <input
        type="number" step="any" value={displayed}
        placeholder={optional ? "(unset)" : ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? NaN : Number(v));
        }}
        style={{ width: 80 }}
      />
    </label>
  );
}

function CategoricalEditor({
  value, onChange,
}: {
  value: Extract<Distribution, { kind: "categorical" }>;
  onChange(d: Distribution): void;
}): ReactNode {
  const set = (choices: typeof value.choices): void => onChange({ kind: "categorical", choices });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {value.choices.map((c, i) => (
        <div key={i} style={{ display: "flex", gap: 4 }}>
          <NumField label="value" value={c.value}
            onChange={(v) => set(value.choices.map((x, j) => j === i ? { ...x, value: v } : x))} />
          <NumField label="weight" value={c.weight}
            onChange={(w) => set(value.choices.map((x, j) => j === i ? { ...x, weight: w } : x))} />
          <button type="button" className="mk-button mk-button--small mk-button--danger"
            onClick={() => set(value.choices.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="mk-button mk-button--small"
        onClick={() => set([...value.choices, { value: 0, weight: 1 }])}>+ choice</button>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Set or delete an optional numeric field without leaving an
 *  explicit `undefined` (exactOptionalPropertyTypes rejects that). */
function withOptional<T extends Distribution, K extends string>(
  d: T, key: K, v: number,
): Distribution {
  if (Number.isFinite(v)) return { ...d, [key]: v } as Distribution;
  const { [key]: _omit, ...rest } = d as Record<string, unknown>;
  return rest as unknown as Distribution;
}

function zeroFor(k: Kind): Distribution {
  switch (k) {
    case "constant": return { kind: "constant", value: 0 };
    case "uniform": return { kind: "uniform", min: 0, max: 1 };
    case "uniform-int": return { kind: "uniform-int", min: 0, max: 1 };
    case "gaussian": return { kind: "gaussian", mean: 0, std: 1 };
    case "gaussian-int": return { kind: "gaussian-int", mean: 0, std: 1 };
    case "exponential": return { kind: "exponential", rate: 1 };
    case "exponential-int": return { kind: "exponential-int", rate: 1 };
    case "categorical": return { kind: "categorical", choices: [{ value: 0, weight: 1 }] };
  }
}
