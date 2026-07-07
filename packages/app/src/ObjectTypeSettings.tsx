import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import type { AppliesTo, ObjectField, ObjectFieldType, ObjectType } from "@companion/core-bridge";
import { Button, Icon, Input, Text, colors, radius, space, type IconName, type PressState } from "@companion/design-system";
import { useObjectTypes } from "./ObjectTypesProvider";
import { ConfirmDialog } from "./ConfirmDialog";

const FIELD_TYPES: ObjectFieldType[] = ["text", "number", "date", "select", "multi_select", "reference", "checkbox", "url"];
const APPLIES: AppliesTo[] = ["note", "task", "both"];
const REF_TARGETS = ["note", "task", "habit"];

// The icons and colors an archetype can be marked with (shown in the graph + lists).
const OBJECT_ICONS: IconName[] = ["file", "notes", "tasks", "calendar", "folder", "bell", "link", "graph", "habits", "chat", "settings", "dot"];
const OBJECT_COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#14b8a6", "#6366f1", "#ef4444", "#10b981", "#eab308", "#3b82f6", "#64748b"];

/** The archetype's marker icon (its chosen icon, or a sensible default). */
function typeIcon(t: ObjectType): IconName {
  return (t.schemaJson.icon as IconName) || "file";
}

/** Object-type (archetype) management (PLAN §6.3): create types and author their schemas —
 *  the flat field list of {key, type, label, required, options?, to?}. The Go core is the
 *  single source of validation; this is just an editor. Lives in the AI/Objects settings. */
export function ObjectTypeSettings() {
  const objectTypes = useObjectTypes();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = objectTypes.types.find((t) => t.id === selectedId) ?? null;

  const createType = async () => {
    const ot = await objectTypes.create({ name: "New type", appliesTo: "both", schemaJson: { fields: [] } });
    setSelectedId(ot.id);
  };

  if (selected) {
    return <TypeEditor key={selected.id} type={selected} onBack={() => setSelectedId(null)} />;
  }

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.headerRow}>
        <Text variant="caption" tone="tertiary" style={{ fontWeight: "600", flex: 1 }}>
          Object types
        </Text>
        <Button label="New type" size="sm" variant="secondary" onPress={() => void createType()} />
      </View>
      {objectTypes.types.length === 0 ? (
        <Text variant="caption" tone="tertiary">
          Object types turn notes and tasks into structured objects with schema-validated fields.
          Create one to get started.
        </Text>
      ) : (
        <View style={styles.list}>
          {objectTypes.types.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => setSelectedId(t.id)}
              style={({ hovered }: PressState) => [styles.row, hovered ? { backgroundColor: colors.surfaceHover } : null]}
            >
              <Icon name={typeIcon(t)} size={15} color={t.schemaJson.color || colors.textTertiary} />
              <Text style={{ flex: 1 }} numberOfLines={1}>
                {t.name}
              </Text>
              <Text variant="caption" tone="tertiary">
                {t.appliesTo} · {(t.schemaJson.fields ?? []).length} field{(t.schemaJson.fields ?? []).length === 1 ? "" : "s"}
              </Text>
              <Icon name="chevronRight" size={15} color={colors.textTertiary} />
            </Pressable>
          ))}
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

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.headerRow}>
        <Pressable onPress={onBack} aria-label="Back" style={styles.backBtn}>
          <Icon name="chevronLeft" size={16} color={colors.textSecondary} />
        </Pressable>
        <Text variant="title" style={{ flex: 1 }}>
          Edit type
        </Text>
      </View>

      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder="e.g. Book" />
      </Field>

      <Field label="Applies to">
        <View style={styles.pillRow}>
          {APPLIES.map((a) => (
            <Pill key={a} label={a} active={appliesTo === a} onPress={() => setAppliesTo(a)} />
          ))}
        </View>
      </Field>

      <Field label="Icon">
        <View style={styles.pillRow}>
          {OBJECT_ICONS.map((name) => {
            const on = icon === name;
            return (
              <Pressable
                key={name}
                onPress={() => setIcon(name)}
                aria-label={name}
                style={[styles.iconSwatch, on ? { borderColor: color || colors.accent, backgroundColor: colors.accentSoft } : null]}
              >
                <Icon name={name} size={17} color={on ? color || colors.accentHover : colors.textSecondary} />
              </Pressable>
            );
          })}
        </View>
      </Field>

      <Field label="Color">
        <View style={styles.pillRow}>
          {OBJECT_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setColor((prev) => (prev === c ? undefined : c))}
              aria-label={c}
              style={[styles.colorSwatch, { backgroundColor: c }, color === c ? styles.colorSwatchOn : null]}
            >
              {color === c ? <Icon name="check" size={13} color={colors.gray0} /> : null}
            </Pressable>
          ))}
        </View>
      </Field>

      <Field label="Fields">
        <View style={{ gap: space.sm }}>
          {fields.map((f, i) => (
            <FieldEditor
              key={i}
              field={f}
              onChange={(patch) => setField(i, patch)}
              onRemove={() => removeField(i)}
            />
          ))}
          <Button label="Add field" size="sm" variant="secondary" onPress={addField} />
        </View>
      </Field>

      {error ? (
        <Text tone="danger" variant="caption">
          {error}
        </Text>
      ) : null}

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
  return (
    <View style={styles.fieldCard}>
      <View style={styles.fieldTopRow}>
        <View style={{ flex: 1 }}>
          <Input size="sm" value={field.key} placeholder="key" autoCapitalize="none" onChangeText={(t) => onChange({ key: t })} />
        </View>
        <View style={{ flex: 1 }}>
          <Input size="sm" value={field.label ?? ""} placeholder="Label" onChangeText={(t) => onChange({ label: t })} />
        </View>
        <Pressable onPress={() => setConfirmRemove(true)} aria-label="Remove field" style={styles.removeField}>
          <Icon name="trash" size={14} color={colors.textTertiary} />
        </Pressable>
      </View>

      <View style={styles.pillRow}>
        {FIELD_TYPES.map((ft) => (
          <Pill key={ft} label={ft} active={field.type === ft} onPress={() => onChange({ type: ft })} />
        ))}
      </View>

      <View style={styles.fieldOptsRow}>
        <Pressable onPress={() => onChange({ required: !field.required })} style={styles.requiredToggle}>
          <View style={[styles.miniCheck, field.required ? styles.miniCheckOn : null]}>
            {field.required ? <Icon name="check" size={11} color={colors.gray0} /> : null}
          </View>
          <Text variant="caption" tone="secondary">
            Required
          </Text>
        </Pressable>
      </View>

      {hasOptions ? (
        <Input
          size="sm"
          value={(field.options ?? []).join(", ")}
          placeholder="Options, comma-separated"
          onChangeText={(t) => onChange({ options: t.split(",").map((s) => s.trim()).filter(Boolean) })}
        />
      ) : null}

      {field.type === "reference" ? (
        <View style={styles.pillRow}>
          <Text variant="caption" tone="tertiary" style={{ alignSelf: "center", marginRight: space.xs }}>
            Links to
          </Text>
          {REF_TARGETS.map((t) => (
            <Pill key={t} label={t} active={(field.to ?? "note") === t} onPress={() => onChange({ to: t })} />
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="caption" tone="tertiary" style={{ fontWeight: "600" }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, active ? styles.pillActive : null]}>
      <Text variant="caption" tone={active ? "accent" : "secondary"}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = {
  headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  backBtn: { padding: space.xs, marginLeft: -space.xs },
  list: { gap: 2 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  pillRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  pill: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  pillActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  iconSwatch: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  colorSwatch: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 2,
    borderColor: "transparent" as const,
  },
  colorSwatchOn: { borderColor: colors.textPrimary },
  fieldCard: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  fieldTopRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  removeField: { padding: space.xs },
  fieldOptsRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  requiredToggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
  miniCheck: {
    width: 18,
    height: 18,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  miniCheckOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, marginTop: space.sm },
};
