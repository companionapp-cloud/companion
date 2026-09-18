import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import type { AppliesTo, ObjectField, ObjectFieldType, ObjectType } from "@companion/core-bridge";
import {
  Button,
  Divider,
  Icon,
  IconButton,
  Input,
  ListRow,
  Text,
  colors,
  control,
  icon as iconSize,
  motion,
  radius,
  space,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { useObjectTypes } from "./ObjectTypesProvider";
import { ConfirmDialog } from "./ConfirmDialog";
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

/** Object-type (archetype) management (PLAN §6.3): create types and author their schemas —
 *  the flat field list of {key, type, label, required, options?, to?}. The Go core is the
 *  single source of validation; this is just an editor. Lives in the AI/Objects settings. */
export function ObjectTypeSettings() {
  const objectTypes = useObjectTypes();
  const density = useDensity();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = objectTypes.types.find((t) => t.id === selectedId) ?? null;

  const createType = async () => {
    const ot = await objectTypes.create({ name: "New type", appliesTo: "both", schemaJson: { fields: [] } });
    setSelectedId(ot.id);
  };

  if (selected) {
    return <TypeEditor key={selected.id} type={selected} onBack={() => setSelectedId(null)} />;
  }

  const touch = density === "touch";
  return (
    <View style={styles.stack}>
      <View style={styles.headerRow}>
        <Text variant="eyebrow" tone="quaternary" style={{ flex: 1 }}>
          Object types · {objectTypes.types.length}
        </Text>
        <Button label="New type" size={touch ? undefined : "sm"} variant="secondary" onPress={() => void createType()} />
      </View>
      {objectTypes.types.length === 0 ? (
        <SettingsNote>
          Object types turn notes and tasks into structured objects with schema-validated fields. Create one to get
          started.
        </SettingsNote>
      ) : (
        <View style={styles.list}>
          {objectTypes.types.map((t) => {
            const count = (t.schemaJson.fields ?? []).length;
            return (
              <ListRow
                key={t.id}
                icon={<Icon name={typeIcon(t)} size={touch ? iconSize.lg : iconSize.sm} color={t.schemaJson.color || colors.textQuaternary} />}
                title={t.name}
                trailing={`${t.appliesTo} · ${count} field${count === 1 ? "" : "s"}`}
                onPress={() => setSelectedId(t.id)}
              />
            );
          })}
        </View>
      )}
    </View>
  );
}

function TypeEditor({ type, onBack }: { type: ObjectType; onBack: () => void }) {
  const objectTypes = useObjectTypes();
  const [name, setName] = useState(type.name);
  const [appliesTo, setAppliesTo] = useState<AppliesTo>(type.appliesTo);
  const [fields, setFields] = useState<ObjectField[]>(type.schemaJson.fields ?? []);
  const [icon, setIcon] = useState<string>(type.schemaJson.icon ?? "file");
  const [color, setColor] = useState<string | undefined>(type.schemaJson.color);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-seed when a synced edit lands on this type.
  useEffect(() => {
    setName(type.name);
    setAppliesTo(type.appliesTo);
    setFields(type.schemaJson.fields ?? []);
    setIcon(type.schemaJson.icon ?? "file");
    setColor(type.schemaJson.color);
  }, [type]);

  const setField = (i: number, patch: Partial<ObjectField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((prev) => [...prev, { key: "", type: "text", label: "" }]);
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    setError(null);
    try {
      await objectTypes.update(type.id, { name, appliesTo, schemaJson: { fields, icon, color } });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    await objectTypes.remove(type.id);
    onBack();
  };

  const touch = useDensity() === "touch";
  const tile = touch ? 38 : control.md;
  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <IconButton label="Back to object types" size={touch ? undefined : "sm"} onPress={onBack}>
          <Icon name="chevronLeft" size={touch ? iconSize.lg : 13} color={colors.textSecondary} />
        </IconButton>
        <Text variant="title" numberOfLines={1} style={{ flex: 1 }}>
          {name.trim() || "Untitled type"}
        </Text>
      </View>

      <SettingsField label="Name">
        <View style={styles.control}>
          <Input value={name} onChangeText={setName} placeholder="e.g. Book" />
        </View>
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
          <FieldEditor key={i} field={f} onChange={(patch) => setField(i, patch)} onRemove={() => removeField(i)} />
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

      <Divider />

      <View style={styles.footer}>
        <Button label={saved ? "Saved" : "Save"} onPress={() => void save()} />
        <View style={{ flex: 1 }} />
        <Button label="Delete type" variant="danger" onPress={() => void remove()} />
      </View>
    </View>
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
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fieldName = (field.label || field.key || "").trim();
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
        <IconButton label="Remove field" size={touch ? undefined : "sm"} onPress={() => setConfirmRemove(true)}>
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

      {confirmRemove ? (
        <ConfirmDialog
          title="Remove field?"
          message={
            fieldName
              ? `Remove the “${fieldName}” field from this type? Existing values for it are kept but no longer shown.`
              : "Remove this field from this type? Existing values for it are kept but no longer shown."
          }
          confirmLabel="Remove field"
          onConfirm={() => {
            setConfirmRemove(false);
            onRemove();
          }}
          onClose={() => setConfirmRemove(false)}
        />
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
  section: { gap: space.xl },
  stack: { gap: space.md },
  control: { width: "100%" as const, maxWidth: 320 },
  headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  list: { gap: 1 },
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
  footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
};
