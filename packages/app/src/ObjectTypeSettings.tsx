import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import type { AppliesTo, ObjectField, ObjectFieldType, ObjectType } from "@companion/core-bridge";
import {
  Button,
  Divider,
  Icon,
  IconButton,
  Input,
  Text,
  colors,
  control,
  icon as iconSize,
  motion,
  radius,
  row,
  space,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { useObjectTypes } from "./ObjectTypesProvider";
import { ConfirmDialog, useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { CheckBox, Segmented, SettingsField, SettingsNote, SwatchPicker } from "./settingsUi";

const FIELD_TYPES: ObjectFieldType[] = ["text", "number", "date", "select", "multi_select", "reference", "checkbox", "url"];
const APPLIES: AppliesTo[] = ["note", "task", "both"];
const REF_TARGETS = ["note", "task", "habit"];

// The icons an archetype can be marked with (shown in the graph + lists); its colour comes
// from the shared swatches.
const OBJECT_ICONS: IconName[] = ["file", "notes", "tasks", "calendar", "folder", "bell", "link", "graph", "habits", "chat", "settings", "dot"];

/** The archetype's marker icon (its chosen icon, or a sensible default). */
function typeIcon(t: ObjectType): IconName {
  return (t.schemaJson.icon as IconName) || "file";
}

/** Object-type (archetype) management (PLAN §6.3): the list of types, each opening an editor
 *  dialog, with its delete on the row behind a confirmation. "New type" opens the same dialog
 *  empty — nothing is created until it is saved. The Go core is the single source of validation;
 *  this is just an editor. */
export function ObjectTypeSettings() {
  const objectTypes = useObjectTypes();
  const touch = useDensity() === "touch";
  // The editor dialog: a type being edited, "new" for the add flow, or closed.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [deleting, setDeleting] = useState<ObjectType | null>(null);
  const editingType = editing && editing !== "new" ? (objectTypes.types.find((t) => t.id === editing) ?? null) : null;

  return (
    <View style={styles.stack}>
      <Text variant="eyebrow" tone="quaternary">
        Object types{objectTypes.types.length > 0 ? ` · ${objectTypes.types.length}` : ""}
      </Text>
      <SettingsNote>Object types turn notes and tasks into structured objects — a Book, a Person, a Meeting — with their own fields.</SettingsNote>

      {objectTypes.types.length > 0 ? (
        <View style={styles.list}>
          {objectTypes.types.map((t, i) => {
            const count = (t.schemaJson.fields ?? []).length;
            return (
              <View key={t.id} style={[styles.typeRow, i === objectTypes.types.length - 1 ? null : styles.rowDivider]}>
                {/* The row opens the editor; the delete button is its sibling, not its child, so
                    pressing it can never also open the editor. */}
                <Pressable
                  onPress={() => setEditing(t.id)}
                  aria-label={`Edit ${t.name}`}
                  style={({ hovered, pressed }: PressState) => [
                    styles.typeMain,
                    transition("background-color", motion.instant),
                    { minHeight: touch ? row.touch : 32, backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
                  ]}
                >
                  <Icon name={typeIcon(t)} size={touch ? iconSize.lg : iconSize.sm} color={t.schemaJson.color || colors.textQuaternary} />
                  <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                    {t.name}
                  </Text>
                  <Text variant="mono" tone="quaternary" numberOfLines={1}>
                    {t.appliesTo} · {count} field{count === 1 ? "" : "s"}
                  </Text>
                </Pressable>
                <IconButton label={`Delete ${t.name}`} size={touch ? undefined : "sm"} onPress={() => setDeleting(t)}>
                  <Icon name="trash" size={touch ? iconSize.lg : 13} color={colors.textTertiary} />
                </IconButton>
              </View>
            );
          })}
        </View>
      ) : null}

      <View style={{ flexDirection: "row" }}>
        <Button label="New type" variant="secondary" onPress={() => setEditing("new")} />
      </View>

      {editing === "new" || editingType ? (
        <TypeEditor key={editing} type={editingType} onClose={() => setEditing(null)} />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          portal
          title={`Delete “${deleting.name}”?`}
          message="Notes and tasks that use this type keep their content and their field values, but stop showing as this type."
          confirmLabel="Delete type"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await objectTypes.remove(deleting.id);
            setDeleting(null);
          }}
        />
      ) : null}
    </View>
  );
}

/** What the form edits, and what "unchanged" is measured against. */
function formOf(type: ObjectType | null) {
  return {
    name: type?.name ?? "",
    appliesTo: (type?.appliesTo ?? "both") as AppliesTo,
    fields: type?.schemaJson.fields ?? [],
    icon: type?.schemaJson.icon ?? "file",
    color: type?.schemaJson.color,
  };
}

/** The add/edit dialog. `type` null is the add flow: the same form, empty, and the type only
 *  comes into being on Create — cancelling leaves nothing behind. */
function TypeEditor({ type, onClose }: { type: ObjectType | null; onClose: () => void }) {
  const objectTypes = useObjectTypes();
  const initial = formOf(type);
  const [name, setName] = useState(initial.name);
  const [appliesTo, setAppliesTo] = useState<AppliesTo>(initial.appliesTo);
  const [fields, setFields] = useState<ObjectField[]>(initial.fields);
  const [icon, setIcon] = useState<string>(initial.icon);
  const [color, setColor] = useState<string | undefined>(initial.color);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The field whose removal is being confirmed (the confirmation is a dialog above this one).
  const [removing, setRemoving] = useState<number | null>(null);

  const dirty = JSON.stringify({ name, appliesTo, fields, icon, color }) !== JSON.stringify(initial);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Re-seed when a synced edit lands on this type — but never over the user's own unsaved
  // changes: the provider hands out a fresh object on every reload, not only on real edits.
  useEffect(() => {
    if (dirtyRef.current) return;
    const next = formOf(type);
    setName(next.name);
    setAppliesTo(next.appliesTo);
    setFields(next.fields);
    setIcon(next.icon);
    setColor(next.color);
  }, [type]);

  const setField = (i: number, patch: Partial<ObjectField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((prev) => [...prev, { key: "", type: "text", label: "" }]);
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));
  // A field nobody has filled in yet goes without ceremony; one with a name asks first.
  const requestRemoveField = (i: number) => {
    const f = fields[i];
    if (f && !(f.key || "").trim() && !(f.label || "").trim()) removeField(i);
    else setRemoving(i);
  };

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return setError("Give the type a name.");
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), appliesTo, schemaJson: { fields, icon, color } };
      if (type) await objectTypes.update(type.id, body);
      else await objectTypes.create(body);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // esc cancels — unless the remove-field confirmation is up, which then owns the keyboard. ⏎ is
  // left alone: in a form this long it is far likelier to be a slip than a decision to save.
  const hints = useDialogKeys({ onEscape: removing !== null || busy ? undefined : onClose });

  const touch = useDensity() === "touch";
  const tile = touch ? 38 : control.md;
  const removingName = removing !== null ? (fields[removing]?.label || fields[removing]?.key || "").trim() : "";
  return (
    <Dialog
      title={type ? "Edit object type" : "New object type"}
      width={520}
      // With unsaved changes a stray click outside must not throw the work away; Cancel still does.
      onClose={dirty || busy ? undefined : onClose}
      footer={
        <>
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          <Button label={busy ? "…" : type ? "Save" : "Create type"} disabled={busy} onPress={() => void save()} />
        </>
      }
    >
      <SettingsField label="Name">
        <Input autoFocus={!type} value={name} onChangeText={setName} placeholder="e.g. Book" />
      </SettingsField>

      <SettingsField label="Applies to" help="Which documents can take this type.">
        <Segmented options={APPLIES.map((a) => ({ value: a, label: a }))} value={appliesTo} onChange={setAppliesTo} />
      </SettingsField>

      <SettingsField label="Icon">
        <View style={styles.wrapRow}>
          {OBJECT_ICONS.map((name) => {
            const on = icon === name;
            return (
              <Pressable
                key={name}
                onPress={() => setIcon(name)}
                aria-label={name}
                style={({ hovered, pressed }: PressState) => [
                  styles.iconTile,
                  transition("background-color", motion.instant),
                  { width: tile, height: tile },
                  on ? styles.iconTileOn : pressed ? styles.tilePressed : hovered ? styles.tileHover : null,
                ]}
              >
                <Icon name={name} size={touch ? iconSize.tile : iconSize.md} color={on ? color || colors.textAccent : colors.textSecondary} />
              </Pressable>
            );
          })}
        </View>
      </SettingsField>

      <SettingsField label="Color" help="Tints the type’s icon in lists and the graph. Press the selected swatch to clear it.">
        <SwatchPicker value={color} onChange={setColor} clearable />
      </SettingsField>

      <Divider />

      <View style={styles.stack}>
        <Text variant="eyebrow" tone="quaternary">
          Fields · {fields.length}
        </Text>
        {fields.map((f, i) => (
          <FieldEditor key={i} field={f} onChange={(patch) => setField(i, patch)} onRemove={() => requestRemoveField(i)} />
        ))}
        <View style={{ flexDirection: "row" }}>
          <Button
            label="Add field"
            size={touch ? undefined : "sm"}
            variant="secondary"
            onPress={addField}
            icon={<Icon name="plus" size={iconSize.sm} color={colors.textSecondary} />}
          />
        </View>
      </View>

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}

      {/* Rendered inside the dialog's tree so that on native it stacks above it, and portaled so
          it is not squeezed into it. */}
      {removing !== null ? (
        <ConfirmDialog
          portal
          title="Remove field?"
          message={
            removingName
              ? `Remove the “${removingName}” field from this type? Existing values for it are kept but no longer shown.`
              : "Remove this field from this type? Existing values for it are kept but no longer shown."
          }
          confirmLabel="Remove field"
          onConfirm={() => {
            removeField(removing);
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </Dialog>
  );
}

function FieldEditor({
  field,
  onChange,
  onRemove,
}: {
  field: ObjectField;
  onChange: (patch: Partial<ObjectField>) => void;
  onRemove: () => void;
}) {
  const hasOptions = field.type === "select" || field.type === "multi_select";
  const touch = useDensity() === "touch";
  return (
    <View style={styles.fieldCard}>
      <View style={styles.fieldTopRow}>
        <View style={{ flex: 1 }}>
          <Input size={touch ? undefined : "sm"} mono value={field.key} placeholder="key" autoCapitalize="none" onChangeText={(t) => onChange({ key: t })} />
        </View>
        <View style={{ flex: 1 }}>
          <Input size={touch ? undefined : "sm"} value={field.label ?? ""} placeholder="Label" onChangeText={(t) => onChange({ label: t })} />
        </View>
        <IconButton label="Remove field" size={touch ? undefined : "sm"} onPress={onRemove}>
          <Icon name="trash" size={touch ? iconSize.lg : 13} color={colors.textTertiary} />
        </IconButton>
      </View>

      <View style={styles.wrapRow}>
        {FIELD_TYPES.map((ft) => (
          <Chip key={ft} label={ft} active={field.type === ft} onPress={() => onChange({ type: ft })} />
        ))}
      </View>

      <CheckBox checked={!!field.required} onPress={() => onChange({ required: !field.required })} label="Required" />

      {hasOptions ? (
        <Input
          size={touch ? undefined : "sm"}
          value={(field.options ?? []).join(", ")}
          placeholder="Options, comma-separated"
          onChangeText={(t) => onChange({ options: t.split(",").map((s) => s.trim()).filter(Boolean) })}
        />
      ) : null}

      {field.type === "reference" ? (
        <View style={styles.wrapRow}>
          <Text variant="caption" tone="tertiary" style={{ alignSelf: "center", marginRight: space.xs }}>
            Links to
          </Text>
          {REF_TARGETS.map((t) => (
            <Chip key={t} label={t} active={(field.to ?? "note") === t} onPress={() => onChange({ to: t })} />
          ))}
        </View>
      ) : null}

    </View>
  );
}

/** A mono value chip — field types and reference targets are machine values, so they read
 *  as mono. Squared (radius 3); selected takes the soft-accent treatment. */
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const touch = useDensity() === "touch";
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.chip,
        transition("background-color, border-color", motion.instant),
        { height: touch ? control.lg : control.xs, paddingHorizontal: touch ? space.ml : space.sm },
        active ? styles.chipActive : pressed ? styles.tilePressed : hovered ? styles.tileHover : null,
      ]}
    >
      <Text variant="mono" tone={active ? "accent" : "secondary"}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = {
  stack: { gap: space.md },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  typeRow: { flexDirection: "row" as const, alignItems: "center" as const, paddingRight: space.xs },
  typeMain: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, paddingHorizontal: space.ml },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  wrapRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  iconTile: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  iconTileOn: { borderColor: colors.accentSoftBorder, backgroundColor: colors.accentSoft },
  tileHover: { backgroundColor: colors.surfaceHover },
  tilePressed: { backgroundColor: colors.surfaceActive },
  chip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  chipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  fieldCard: {
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  fieldTopRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
};
