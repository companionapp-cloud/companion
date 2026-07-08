import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";

/** The kind of item a list holds; selection is homogeneous (a list is all notes or all
 *  tasks), so bulk actions know which store to call. */
export type MultiSelectKind = "note" | "task";

/** Keyboard modifiers read off a row press, normalized across platforms. */
export interface PressMods {
  /** Cmd (mac) or Ctrl — toggle a single row in/out of the selection. */
  meta: boolean;
  /** Shift — extend a contiguous range from the anchor. */
  shift: boolean;
}

export interface MultiSelectStore {
  kind: MultiSelectKind;
  /** true once ≥2 items are selected: the toolbar swaps and the preview shows the stack. */
  active: boolean;
  count: number;
  /** Selected ids in list order. */
  selectedIds: string[];
  /** The first selected id in list order — shown on top of the preview stack. */
  primaryId: string | null;
  isSelected: (id: string) => boolean;
  /** The active on-screen list announces its identity + current visible order. Switching
   *  lists (a new scope) drops the selection. */
  register: (scope: string, kind: MultiSelectKind, orderedIds: string[]) => void;
  /** Apply a row press. Returns true when it consumed a multiselect gesture (cmd/shift) and
   *  the caller should NOT navigate; false for a plain click (caller opens the item). */
  press: (id: string, mods: PressMods) => boolean;
  clear: () => void;
}

/** Reads modifier keys off a press event. On web (react-native-web) the DOM modifiers ride
 *  on `nativeEvent`; on native they're absent, so this yields no-modifiers and multiselect
 *  stays inert (mobile keeps single-select). Mirrors `GraphView.web.tsx`'s meta/ctrl read. */
export function pressMods(e: GestureResponderEvent | undefined): PressMods {
  const ne = (e?.nativeEvent ?? {}) as { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean };
  return { meta: !!ne.metaKey || !!ne.ctrlKey, shift: !!ne.shiftKey };
}

const MultiSelectCtx = createContext<MultiSelectStore | null>(null);

/** Owns the shared multiselect state for the browse lists (notes/tasks, global or per
 *  project). One instance sits above both the toolbar and the screens so the toolbar can
 *  swap to bulk actions while a list drives the selection. */
export function MultiSelectProvider({ children }: { children: ReactNode }) {
  // Scope value is only read inside setScope's updater (to detect a list change), so we
  // don't destructure the current value.
  const [, setScope] = useState<string | null>(null);
  const [kind, setKind] = useState<MultiSelectKind>("note");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // The active list's visible order, kept in a ref so `press` can read the latest range
  // without being re-created on every reorder.
  const orderRef = useRef<string[]>([]);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  const register = useCallback(
    (nextScope: string, nextKind: MultiSelectKind, orderedIds: string[]) => {
      orderRef.current = orderedIds;
      setKind(nextKind);
      setScope((prev) => {
        if (prev !== nextScope) {
          // A different list took the stage — drop the old selection.
          setSelected(new Set());
          setAnchor(null);
        }
        return nextScope;
      });
    },
    [],
  );

  const press = useCallback(
    (id: string, mods: PressMods): boolean => {
      const order = orderRef.current;
      if (mods.shift && anchor) {
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          setSelected(new Set(order.slice(lo, hi + 1)));
          return true;
        }
        // Anchor no longer visible: fall through to a fresh single selection.
      }
      if (mods.meta) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setAnchor(id);
        return true;
      }
      // Plain click: single selection, and let the caller open it.
      setSelected(new Set([id]));
      setAnchor(id);
      return false;
    },
    [anchor],
  );

  const value = useMemo<MultiSelectStore>(() => {
    const order = orderRef.current;
    const selectedIds = order.filter((id) => selected.has(id));
    return {
      kind,
      active: selected.size >= 2,
      count: selected.size,
      selectedIds,
      primaryId: selectedIds[0] ?? null,
      isSelected: (id) => selected.has(id),
      register,
      press,
      clear,
    };
  }, [kind, selected, register, press, clear]);

  // Escape clears the selection (web convenience).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear]);

  return <MultiSelectCtx.Provider value={value}>{children}</MultiSelectCtx.Provider>;
}

export function useMultiSelect(): MultiSelectStore {
  const v = useContext(MultiSelectCtx);
  if (!v) throw new Error("useMultiSelect must be used within a MultiSelectProvider");
  return v;
}
