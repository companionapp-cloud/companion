import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, colors, control, font, motion, radius, row, space } from "@companion/design-system";
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

// The graph view's settings menu: a settings button in the graph's sub-toolbar that opens a
// 252px popover with "Forces" sliders (live-tuning the d3 simulation) and "Show" toggles (which node
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
// Declared before the components (see the TDZ note in GraphView.web.tsx). Hover/press fills,
// the range track and the checkbox need pseudo-classes, so those live in one injected
// stylesheet; everything else is inline. Colour roles are CSS variables here, which is fine
// in a stylesheet — the only literal is the check glyph, white on accent in both themes.
const CHECK_GLYPH = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-5' fill='none' stroke='%23fff' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;
const DASH_GLYPH = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 6h6' fill='none' stroke='%23fff' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E")`;

export const GRAPH_CHROME_CSS = `
.graph-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: ${control.sm}px; height: ${control.sm}px; padding: 0; flex-shrink: 0; border: 0; border-radius: ${radius.sm}px; background: transparent; color: ${colors.textSecondary}; cursor: pointer; transition: background-color ${motion.instant}ms ${motion.ease}; }
.graph-iconbtn:hover { background: ${colors.surfaceHover}; }
.graph-iconbtn:active { background: ${colors.surfaceActive}; }
.graph-iconbtn.on { background: ${colors.accentSoft}; color: ${colors.textAccent}; }
.graph-ghostbtn { height: ${control.sm}px; padding: 0 ${space.md}px; border: 0; border-radius: ${radius.sm}px; background: transparent; color: ${colors.textSecondary}; font: ${font.weight.medium} ${font.size.sm}px ${font.sans}; cursor: pointer; transition: background-color ${motion.instant}ms ${motion.ease}; }
.graph-ghostbtn:hover { background: ${colors.surfaceHover}; }
.graph-ghostbtn:active { background: ${colors.surfaceActive}; }
.graph-ghostbtn:disabled { opacity: 0.4; cursor: default; background: transparent; }
.graph-range { display: block; width: 100%; height: 14px; margin: 0; padding: 0; background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none; }
.graph-range::-webkit-slider-runnable-track { height: 2px; border-radius: 1px; background: linear-gradient(to right, ${colors.accent} var(--fill, 0%), ${colors.borderDefault} var(--fill, 0%)); }
.graph-range::-moz-range-track { height: 2px; border-radius: 1px; background: ${colors.borderDefault}; }
.graph-range::-moz-range-progress { height: 2px; border-radius: 1px; background: ${colors.accent}; }
.graph-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 10px; height: 10px; margin-top: -4px; border: 0; border-radius: 50%; background: ${colors.accent}; }
.graph-range::-moz-range-thumb { width: 10px; height: 10px; border: 0; border-radius: 50%; background: ${colors.accent}; }
.graph-range:hover::-webkit-slider-thumb { background: ${colors.accentHover}; }
.graph-range:hover::-moz-range-thumb { background: ${colors.accentHover}; }
.graph-range:focus-visible { outline: 2px solid ${colors.focusRing}; outline-offset: 2px; border-radius: ${radius.xs}px; }
.graph-check { -webkit-appearance: none; appearance: none; box-sizing: border-box; width: 12px; height: 12px; margin: 0; flex-shrink: 0; border: 1px solid ${colors.borderStrong}; border-radius: ${radius.xs}px; background: ${colors.surfaceCard} center / 12px 12px no-repeat; cursor: pointer; transition: background-color ${motion.fast}ms ${motion.ease}, border-color ${motion.fast}ms ${motion.ease}; }
.graph-check:checked { border-color: ${colors.accent}; background-color: ${colors.accent}; background-image: ${CHECK_GLYPH}; background-position: -1px -1px; }
.graph-check:indeterminate { border-color: ${colors.accent}; background-color: ${colors.accent}; background-image: ${DASH_GLYPH}; background-position: -1px -1px; }
.graph-check:focus-visible { outline: 2px solid ${colors.focusRing}; outline-offset: 1px; }
.graph-checkrow { border-radius: ${radius.sm}px; }
.graph-checkrow:hover { background: ${colors.surfaceHover}; }
/* Desktop density never applies to touch: inside the mobile WebView (a coarse pointer) the
   buttons take the 30px control size and rows the 44px touch height. */
@media (pointer: coarse) {
  .graph-iconbtn { width: ${control.lg}px; height: ${control.lg}px; }
  .graph-ghostbtn { height: ${control.lg}px; font-size: ${font.size.md}px; }
  .graph-checkrow { min-height: ${row.touch}px !important; }
  .graph-range { height: ${control.lg}px; }
  .graph-range::-webkit-slider-thumb { width: 18px; height: 18px; margin-top: -8px; }
}
`;

const rootStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexShrink: 0,
  fontFamily: font.sans,
  color: colors.textPrimary,
};

// A popover, so it floats: overlay surface, hairline, 6px radius and the menu shadow.
const panelStyle: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: space.xs,
  zIndex: 40,
  width: 252,
  maxHeight: "min(70vh, 440px)",
  overflowY: "auto",
  boxSizing: "border-box",
  padding: `${space.xs}px ${space.ml}px ${space.ml}px`,
  borderRadius: radius.lg,
  border: `1px solid ${colors.borderSubtle}`,
  background: colors.surfaceOverlay,
  boxShadow: "0 4px 12px rgba(17,17,16,0.1)",
  fontSize: font.size.sm,
  lineHeight: font.leading.ui,
};

const sectionHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space.xs,
  padding: `${space.sm}px 0 ${space.xxs}px ${space.xxs}px`,
};

// The eyebrow: 10px semibold uppercase mono, 0.12em tracking.
const eyebrowStyle: CSSProperties = {
  flex: 1,
  fontFamily: font.mono,
  fontSize: font.size["2xs"],
  fontWeight: font.weight.semibold,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: colors.textTertiary,
};

const sliderRowStyle: CSSProperties = {
  display: "block",
  padding: `${space.xs}px ${space.xxs}px`,
};

const sliderHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: space.sm,
  marginBottom: 3,
};

const sliderLabelStyle: CSSProperties = {
  flex: 1,
  fontSize: font.size.sm,
  color: colors.textSecondary,
};

const sliderValueStyle: CSSProperties = {
  fontFamily: font.mono,
  fontSize: font.size.xs,
  color: colors.textTertiary,
};

const checkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minHeight: row.h,
  paddingLeft: space.xxs,
  paddingRight: space.xs,
  cursor: "pointer",
  fontSize: font.size.base,
  color: colors.textPrimary,
  userSelect: "none",
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
  margin: `${space.md}px 0 0`,
  background: colors.borderSubtle,
};

// ── Pieces ───────────────────────────────────────────────────────────────────────────────

function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div style={sectionHeadStyle}>
      <span style={eyebrowStyle}>{title}</span>
      {action}
    </div>
  );
}

/** The ghost `sm` button, in plain DOM (see the note at the top of this file). */
function GhostButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="graph-ghostbtn" onClick={onClick} disabled={disabled}>
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
  // WebKit has no ::range-progress, so the filled part of the track is a gradient stop.
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <label style={sliderRowStyle}>
      <div style={sliderHeadStyle}>
        <span style={sliderLabelStyle}>{label}</span>
        <span style={sliderValueStyle}>{formatValue(value, step)}</span>
      </div>
      <input
        type="range"
        className="graph-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ "--fill": `${fill}%` } as CSSProperties}
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
    <label className="graph-checkrow" style={indent ? { ...checkRowStyle, paddingLeft: indent } : checkRowStyle}>
      <input ref={ref} type="checkbox" className="graph-check" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
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
        className={open ? "graph-iconbtn on" : "graph-iconbtn"}
        onClick={() => setOpen((o) => !o)}
        aria-label="Graph settings"
        aria-expanded={open}
        title="Graph settings"
      >
        <Icon name="settings" size={13} color="currentColor" />
      </button>

      {open ? (
        <div style={panelStyle} role="group" aria-label="Graph settings">
          <SectionHead
            title="Forces"
            action={
              <GhostButton onClick={resetPhysics} disabled={!physicsDirty}>
                Reset
              </GhostButton>
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
              <GhostButton onClick={resetFilters} disabled={!filtersDirty}>
                Reset
              </GhostButton>
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
              <div style={dividerStyle} />
              <SectionHead
                title="Projects"
                action={
                  <span style={{ display: "flex", gap: space.xxs }}>
                    <GhostButton onClick={() => setFilters({ hiddenProjects: [], unassigned: true })} disabled={hidden.size === 0 && filters.unassigned}>
                      All
                    </GhostButton>
                    <GhostButton
                      onClick={() => setFilters({ hiddenProjects: projects.map((p) => p.id), unassigned: false })}
                      disabled={hidden.size === projects.length && !filters.unassigned}
                    >
                      None
                    </GhostButton>
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
