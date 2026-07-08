import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { IconName } from "@companion/design-system";
import type { ViewId } from "./nav-context";

/** The rail tools a user can hide. Settings is deliberately not hideable (it's how you get
 *  back), and notifications has no rail item — its entry point is the toolbar bell. */
export type ToolId = Exclude<ViewId, "settings" | "notifications">;

export interface ToolDef {
  id: ToolId;
  label: string;
  icon: IconName;
}

/** The tool registry in its *default* order. The sidebar renders these (minus the hidden
 *  set) in the user's saved order, and the settings toggles list them. One list so the two
 *  can't drift. */
export const TOOLS: ToolDef[] = [
  { id: "today", label: "Today", icon: "today" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "notes", label: "Notes", icon: "notes" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "habits", label: "Habits", icon: "habits" },
  { id: "graph", label: "Graph", icon: "graph" },
  { id: "trash", label: "Trash", icon: "trash" },
];

/** Where the hidden set + order persist. Deliberately device-local — hiding or reordering a
 *  tool is an ergonomic choice per machine, not synced data. Same synchronous contract as
 *  SyncStorage so mobile can inject its file-backed equivalent. */
export interface ToolsStorage {
  load(): string | null;
  save(value: string): void;
}

const STORAGE_KEY = "companion.tools.hidden";

const localStorageBacked: ToolsStorage = {
  load: () => {
    try {
      return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  save: (value) => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value);
    } catch {
      /* storage unavailable */
    }
  },
};

export interface ToolVisibilityStore {
  /** Every tool in the user's saved display order (hidden ones included). */
  tools: readonly ToolDef[];
  /** Tools hidden from the sidebar on this device. */
  hidden: ReadonlySet<ToolId>;
  setHidden: (id: ToolId, hidden: boolean) => void;
  /** Persist a new display order. Accepts a *subset* of tool ids (e.g. mobile reorders only
   *  its visible sections) — ids left out keep their current slots. */
  reorder: (orderedIds: ToolId[]) => void;
}

const ToolVisibilityCtx = createContext<ToolVisibilityStore | null>(null);

const KNOWN: ReadonlySet<ToolId> = new Set(TOOLS.map((t) => t.id));
const isTool = (id: unknown): id is ToolId => typeof id === "string" && KNOWN.has(id as ToolId);

/** Drop unknown/duplicate ids, then append any known tool the list is missing (in default
 *  order) so a saved order stays complete even as TOOLS grows. */
function canonicalOrder(ids: ToolId[]): ToolId[] {
  const seen = new Set<ToolId>();
  const out: ToolId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const t of TOOLS) {
    if (!seen.has(t.id)) out.push(t.id);
  }
  return out;
}

interface Parsed {
  hidden: Set<ToolId>;
  order: ToolId[];
}

function parse(raw: string | null): Parsed {
  const empty: Parsed = { hidden: new Set(), order: canonicalOrder([]) };
  if (!raw) return empty;
  try {
    const v: unknown = JSON.parse(raw);
    // Legacy format: a bare array of hidden ids (no order was stored yet).
    if (Array.isArray(v)) return { hidden: new Set(v.filter(isTool)), order: canonicalOrder([]) };
    if (v && typeof v === "object") {
      const obj = v as { hidden?: unknown; order?: unknown };
      const hidden = Array.isArray(obj.hidden) ? obj.hidden.filter(isTool) : [];
      const order = Array.isArray(obj.order) ? obj.order.filter(isTool) : [];
      return { hidden: new Set(hidden), order: canonicalOrder(order) };
    }
    return empty;
  } catch {
    return empty;
  }
}

/** Slot a reordered subset back into the full order: the positions currently held by
 *  `part`'s members are refilled in `part`'s new sequence, and every other tool stays put. */
function mergeOrder(full: ToolId[], part: ToolId[]): ToolId[] {
  const inPart = new Set(part.filter((id) => full.includes(id)));
  const seq = part.filter((id) => inPart.has(id));
  let i = 0;
  return full.map((id) => (inPart.has(id) ? seq[i++] : id));
}

/** Per-device tool visibility + ordering (only the rail entries — every view stays reachable
 *  by URL/deep link). Defaults to localStorage; mobile injects a file-backed store since
 *  React Native has no localStorage. */
export function ToolVisibilityProvider({ storage, children }: { storage?: ToolsStorage; children: ReactNode }) {
  const store = storage ?? localStorageBacked;
  const [state, setState] = useState<Parsed>(() => parse(store.load()));

  const persist = useCallback(
    (next: Parsed) => {
      store.save(JSON.stringify({ hidden: [...next.hidden], order: next.order }));
    },
    [store],
  );

  const setHidden = useCallback(
    (id: ToolId, hide: boolean) => {
      setState((prev) => {
        if (prev.hidden.has(id) === hide) return prev;
        const hidden = new Set(prev.hidden);
        if (hide) hidden.add(id);
        else hidden.delete(id);
        const next = { hidden, order: prev.order };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reorder = useCallback(
    (ids: ToolId[]) => {
      setState((prev) => {
        const order = mergeOrder(prev.order, ids.filter(isTool));
        if (order.every((id, i) => id === prev.order[i])) return prev;
        const next = { hidden: prev.hidden, order };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const byId = useMemo(() => new Map(TOOLS.map((t) => [t.id, t])), []);
  const tools = useMemo(
    () => state.order.map((id) => byId.get(id)).filter((t): t is ToolDef => t != null),
    [state.order, byId],
  );

  const value = useMemo<ToolVisibilityStore>(
    () => ({ tools, hidden: state.hidden, setHidden, reorder }),
    [tools, state.hidden, setHidden, reorder],
  );
  return <ToolVisibilityCtx.Provider value={value}>{children}</ToolVisibilityCtx.Provider>;
}

export function useToolVisibility(): ToolVisibilityStore {
  const v = useContext(ToolVisibilityCtx);
  if (!v) throw new Error("useToolVisibility must be used within ToolVisibilityProvider");
  return v;
}
