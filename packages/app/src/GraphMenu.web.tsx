import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, colors, font, radius } from "@companion/design-system";
import type { Graph, GraphNode } from "@companion/core-bridge";
import {
  DEFAULT_FILTERS,
  DEFAULT_PHYSICS,
  PHYSICS_SLIDERS,
  isDefaultFilters,
  isDefaultPhysics,
  sanitizeFilters,
  sanitizePhysics,
  typeColor,
  type GraphFilters,
  type GraphPhysics,
} from "./graphModel";

// The graph view's settings menu: a gear button in the canvas corner that opens a floating
// panel with "Forces" sliders (live-tuning the d3 simulation) and "Show" toggles (which node
// types and projects are in the graph). Plain DOM with inline styles — like GraphView it
// also runs inside the isolated mobile WebView bundle, which has no providers and no
// react-native-web layout, so nothing here may depend on the RN design-system components.

// ── Persistence ──────────────────────────────────────────────────────────────────────────
// Settings are per-device preferences, stored in localStorage (unavailable inside some
// WebViews — every access is guarded, and the menu simply forgets between opens there).
const STORAGE_KEY = "companion.graph.settings";

interface Stored {
  physics: GraphPhysics;
  filters: GraphFilters;
}

function load(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { physics: DEFAULT_PHYSICS, filters: DEFAULT_FILTERS };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return { physics: sanitizePhysics(parsed.physics), filters: sanitizeFilters(parsed.filters) };
  } catch {
    return { physics: DEFAULT_PHYSICS, filters: DEFAULT_FILTERS };
  }
}

function save(value: Stored): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export interface GraphSettings {
  physics: GraphPhysics;
  filters: GraphFilters;
  setPhysics: (patch: Partial<GraphPhysics>) => void;
  setFilters: (patch: Partial<GraphFilters>) => void;
  resetPhysics: () => void;
  resetFilters: () => void;
}

/** The menu's state: physics + filters, loaded from and mirrored to localStorage. */
export function useGraphSettings(): GraphSettings {
  const [state, setState] = useState<Stored>(load);
  useEffect(() => save(state), [state]);

  const setPhysics = useCallback((patch: Partial<GraphPhysics>) => {
    setState((s) => ({ ...s, physics: { ...s.physics, ...patch } }));
  }, []);
  const setFilters = useCallback((patch: Partial<GraphFilters>) => {
    setState((s) => ({ ...s, filters: { ...s.filters, ...patch } }));
  }, []);
  const resetPhysics = useCallback(() => setState((s) => ({ ...s, physics: DEFAULT_PHYSICS })), []);
  const resetFilters = useCallback(() => setState((s) => ({ ...s, filters: DEFAULT_FILTERS })), []);

  return { physics: state.physics, filters: state.filters, setPhysics, setFilters, resetPhysics, resetFilters };
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────
// Declared before the components (see the TDZ note in GraphView.web.tsx).
const rootStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  bottom: 12,
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 8,
  // The column itself must not swallow canvas gestures — only its children are targets.
  pointerEvents: "none",
  fontFamily: font.sans,
  color: colors.textPrimary,
};

const toggleStyle: CSSProperties = {
  pointerEvents: "auto",
  width: 32,
  height: 32,
  padding: 0,
  borderRadius: radius.md,
  border: `1px solid ${colors.borderSubtle}`,
  background: colors.surfaceCard,
  boxShadow: "0 1px 3px rgba(17,17,16,0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const toggleActiveStyle: CSSProperties = {
  ...toggleStyle,
  background: colors.surfaceActive,
  borderColor: colors.borderDefault,
};

const panelStyle: CSSProperties = {
  pointerEvents: "auto",
  width: 252,
  minHeight: 0,
  overflowY: "auto",
  boxSizing: "border-box",
  padding: "10px 12px 12px",
  borderRadius: radius.lg,
  border: `1px solid ${colors.borderSubtle}`,
  background: colors.surfaceCard,
  boxShadow: "0 6px 20px rgba(17,17,16,0.12)",
  fontSize: font.size.xs,
  lineHeight: 1.3,
};

const sectionHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  margin: "8px 0 6px",
  fontSize: font.size["2xs"],
  fontWeight: font.weight.semibold,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: colors.textTertiary,
};

const linkButtonStyle: CSSProperties = {
  padding: 0,
  border: "none",
  background: "none",
  font: "inherit",
  fontSize: font.size["2xs"],
  letterSpacing: 0,
  textTransform: "none",
  color: colors.textAccent,
  cursor: "pointer",
};

const linkButtonDisabledStyle: CSSProperties = {
  ...linkButtonStyle,
  color: colors.textDisabled,
  cursor: "default",
};

const sliderRowStyle: CSSProperties = {
  display: "block",
  margin: "0 0 6px",
};

const sliderHeadStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  marginBottom: 2,
  color: colors.textSecondary,
};

const sliderValueStyle: CSSProperties = {
  fontFamily: font.mono,
  fontSize: font.size["2xs"],
  color: colors.textTertiary,
};

const sliderInputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  margin: 0,
  accentColor: colors.accent,
  cursor: "pointer",
};

const checkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minHeight: 24,
  cursor: "pointer",
  color: colors.textPrimary,
  userSelect: "none",
};

const checkInputStyle: CSSProperties = {
  margin: 0,
  width: 14,
  height: 14,
  flexShrink: 0,
  accentColor: colors.accent,
  cursor: "pointer",
};

const swatchStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
};

const checkLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const dividerStyle: CSSProperties = {
  height: 1,
  margin: "8px 0 2px",
  background: colors.borderSubtle,
};

// ── Pieces ───────────────────────────────────────────────────────────────────────────────

function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div style={sectionHeadStyle}>
      <span>{title}</span>
      {action}
    </div>
  );
}

function LinkButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" style={disabled ? linkButtonDisabledStyle : linkButtonStyle} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

// Sliders with a fractional step show two decimals; whole-number sliders show integers.
const formatValue = (v: number, step: number) => (step < 1 ? v.toFixed(2) : String(Math.round(v)));

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={sliderRowStyle}>
      <div style={sliderHeadStyle}>
        <span>{label}</span>
        <span style={sliderValueStyle}>{formatValue(value, step)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={sliderInputStyle}
      />
    </label>
  );
}

function CheckRow({
  label,
  checked,
  indeterminate = false,
  onChange,
  color,
  indent = 0,
}: {
  label: string;
  checked: boolean;
  /** Mixed state for a parent whose children disagree; rendered via the DOM property since
   * React has no attribute for it. */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** Swatch dot matching the node color in the canvas. */
  color?: string;
  indent?: number;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label style={indent ? { ...checkRowStyle, paddingLeft: indent } : checkRowStyle}>
      <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} style={checkInputStyle} />
      {color ? <span style={{ ...swatchStyle, background: color }} /> : null}
      <span style={checkLabelStyle}>{label}</span>
    </label>
  );
}

// ── Menu ─────────────────────────────────────────────────────────────────────────────────

export interface GraphMenuProps extends GraphSettings {
  /** The unfiltered graph — the project list is built from it, so a hidden project can
   * still be found and turned back on. */
  graph: Graph;
}

export function GraphMenu({ graph, physics, filters, setPhysics, setFilters, resetPhysics, resetFilters }: GraphMenuProps) {
  const [open, setOpen] = useState(false);

  const projects = useMemo(
    () =>
      graph.nodes
        .filter((n): n is GraphNode => n.type === "project")
        .sort((a, b) => (a.title || "").localeCompare(b.title || "")),
    [graph],
  );
  const hidden = useMemo(() => new Set(filters.hiddenProjects), [filters.hiddenProjects]);

  const setProjectVisible = (id: string, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    setFilters({ hiddenProjects: [...next] });
  };

  // "Tasks" is a parent of Complete / Incomplete: checked when both are, mixed when they
  // disagree; toggling it sets both.
  const tasksAll = filters.tasksOpen && filters.tasksDone;
  const tasksMixed = filters.tasksOpen !== filters.tasksDone;

  // Anything is customized → offer a way back.
  const filtersDirty = !isDefaultFilters(filters);
  const physicsDirty = !isDefaultPhysics(physics);

  return (
    <div style={rootStyle}>
      <button
        type="button"
        style={open ? toggleActiveStyle : toggleStyle}
        onClick={() => setOpen((o) => !o)}
        aria-label="Graph settings"
        aria-expanded={open}
        title="Graph settings"
      >
        <Icon name="settings" size={16} color={open ? colors.textPrimary : colors.textSecondary} />
      </button>

      {open ? (
        <div style={panelStyle} role="group" aria-label="Graph settings">
          <SectionHead
            title="Forces"
            action={
              <LinkButton onClick={resetPhysics} disabled={!physicsDirty}>
                Reset
              </LinkButton>
            }
          />
          {PHYSICS_SLIDERS.map((s) => (
            <SliderRow
              key={s.key}
              label={s.label}
              value={physics[s.key]}
              min={s.min}
              max={s.max}
              step={s.step}
              onChange={(v) => setPhysics({ [s.key]: v })}
            />
          ))}

          <div style={dividerStyle} />

          <SectionHead
            title="Show"
            action={
              <LinkButton onClick={resetFilters} disabled={!filtersDirty}>
                Show all
              </LinkButton>
            }
          />
          <CheckRow label="Notes" color={typeColor("note")} checked={filters.notes} onChange={(v) => setFilters({ notes: v })} />
          <CheckRow
            label="Tasks"
            color={typeColor("task")}
            checked={tasksAll}
            indeterminate={tasksMixed}
            onChange={(v) => setFilters({ tasksOpen: v, tasksDone: v })}
          />
          <CheckRow label="Complete" indent={22} checked={filters.tasksDone} onChange={(v) => setFilters({ tasksDone: v })} />
          <CheckRow label="Incomplete" indent={22} checked={filters.tasksOpen} onChange={(v) => setFilters({ tasksOpen: v })} />
          <CheckRow label="Files" color={typeColor("document")} checked={filters.files} onChange={(v) => setFilters({ files: v })} />
          <CheckRow label="Canvases" color={typeColor("canvas")} checked={filters.canvases} onChange={(v) => setFilters({ canvases: v })} />

          {projects.length > 0 ? (
            <>
              <SectionHead
                title="Projects"
                action={
                  <span style={{ display: "flex", gap: 8 }}>
                    <LinkButton onClick={() => setFilters({ hiddenProjects: [], unassigned: true })} disabled={hidden.size === 0 && filters.unassigned}>
                      All
                    </LinkButton>
                    <LinkButton
                      onClick={() => setFilters({ hiddenProjects: projects.map((p) => p.id), unassigned: false })}
                      disabled={hidden.size === projects.length && !filters.unassigned}
                    >
                      None
                    </LinkButton>
                  </span>
                }
              />
              {projects.map((p) => (
                <CheckRow
                  key={p.id}
                  label={p.title || "Untitled project"}
                  color={p.objectColor ?? typeColor("project")}
                  checked={!hidden.has(p.id)}
                  onChange={(v) => setProjectVisible(p.id, v)}
                />
              ))}
              <CheckRow label="No project" checked={filters.unassigned} onChange={(v) => setFilters({ unassigned: v })} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
