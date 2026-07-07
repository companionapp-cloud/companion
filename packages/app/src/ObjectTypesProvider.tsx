import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CreateObjectTypeInput,
  ObjectType,
  UpdateObjectTypeInput,
} from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";

export interface ObjectTypesStore {
  types: ObjectType[];
  loading: boolean;
  /** Lookup a type by id (for rendering an entity's archetype). */
  byId: (id: string | null | undefined) => ObjectType | undefined;
  /** Types that can archetype the given entity kind ("note" | "task"). */
  forKind: (kind: "note" | "task") => ObjectType[];
  create: (input: CreateObjectTypeInput) => Promise<ObjectType>;
  update: (id: string, fields: UpdateObjectTypeInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const ObjectTypesCtx = createContext<ObjectTypesStore | null>(null);

/** Owns the object-type (archetype) definitions (PLAN §6.3). Refreshes on
 *  `objectTypes.changed` (local edits) and `data.changed` (a sync pull applied types from
 *  another device), and triggers a sync after every local mutation. */
export function ObjectTypesProvider({ children }: { children: ReactNode }) {
  const { core, objectTypes: api } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const next = await api.list();
    setTypes(next ?? []);
    setLoading(false);
  }, [api]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const offChanged = core.on("objectTypes.changed", scheduleRefresh);
    const offData = core.on("data.changed", scheduleRefresh);
    return () => {
      offChanged();
      offData();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [core, refresh, scheduleRefresh]);

  const create = useCallback(
    async (input: CreateObjectTypeInput) => {
      const ot = await api.create(input);
      await refresh();
      syncTrigger();
      return ot;
    },
    [api, refresh, syncTrigger],
  );
  const update = useCallback(
    async (id: string, fields: UpdateObjectTypeInput) => {
      await api.update(id, fields);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );
  const remove = useCallback(
    async (id: string) => {
      await api.remove(id);
      await refresh();
      syncTrigger();
    },
    [api, refresh, syncTrigger],
  );

  const byId = useCallback(
    (id: string | null | undefined) => (id ? types.find((t) => t.id === id) : undefined),
    [types],
  );
  const forKind = useCallback(
    (kind: "note" | "task") => types.filter((t) => t.appliesTo === kind || t.appliesTo === "both"),
    [types],
  );

  const value = useMemo<ObjectTypesStore>(
    () => ({ types, loading, byId, forKind, create, update, remove }),
    [types, loading, byId, forKind, create, update, remove],
  );

  return <ObjectTypesCtx.Provider value={value}>{children}</ObjectTypesCtx.Provider>;
}

export function useObjectTypes(): ObjectTypesStore {
  const v = useContext(ObjectTypesCtx);
  if (!v) throw new Error("useObjectTypes must be used within an ObjectTypesProvider");
  return v;
}
