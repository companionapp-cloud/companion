import type { AppliesTo, CoreBridge, ObjectSchema, ObjectType } from "./types";

export interface CreateObjectTypeInput {
  name: string;
  appliesTo?: AppliesTo;
  schemaVersion?: number;
  /** The schema envelope; sent as a JSON object (Go decodes it as json.RawMessage). */
  schemaJson?: ObjectSchema;
}

export interface UpdateObjectTypeInput {
  name?: string;
  appliesTo?: AppliesTo;
  schemaVersion?: number;
  schemaJson?: ObjectSchema;
}

/** Typed wrappers over the objectTypes.* core methods (archetypes — PLAN §6.3). The Go
 *  core is the single source of schema validation; this is just transport. */
export function objectTypesApi(core: CoreBridge) {
  return {
    list: () => core.invoke<ObjectType[]>("objectTypes.list"),
    get: (id: string) => core.invoke<ObjectType>("objectTypes.get", { id }),
    create: (input: CreateObjectTypeInput) => core.invoke<ObjectType>("objectTypes.create", input),
    update: (id: string, fields: UpdateObjectTypeInput) =>
      core.invoke<ObjectType>("objectTypes.update", { id, ...fields }),
    remove: (id: string) => core.invoke<{ ok: boolean }>("objectTypes.delete", { id }),
  };
}

export type ObjectTypesApi = ReturnType<typeof objectTypesApi>;
