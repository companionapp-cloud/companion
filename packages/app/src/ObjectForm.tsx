import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import type { GraphNode, ObjectField, ObjectProps, ObjectSchema } from "@companion/core-bridge";
import { Icon, Input, Text, colors, control, radius, row, space, useDensity, type PressState } from "@companion/design-system";
import { useCore } from "./CoreContext";

/** The TS form renderer for an archetype's structured metadata (PLAN §6.3). It reads the
 *  schema and edits a props object — the rule is "TS decides what to show, Go decides
 *  what's valid," so this never validates; it just collects values and hands them to the
 *  core, which validates on write. Tolerant of missing/extra keys. */
export function ObjectForm({
  schema,
  props,
  onChange,
}: {
  schema: ObjectSchema;
  props: ObjectProps;
  /** Called with the full next props object whenever a field changes. */
  onChange: (next: ObjectProps) => void;
}) {
  const fields = schema.fields ?? [];
  if (fields.length === 0) {
    return (
      <Text variant="caption" tone="tertiary">
        This type has no fields yet.
      </Text>
    );
  }
  const setField = (key: string, value: unknown) => {
    const next = { ...props };
    if (value === undefined || value === null || value === "") delete next[key];
    else next[key] = value;
    onChange(next);
  };
  return (
    <View style={{ gap: space.md }}>
      {fields.map((f) => (
        // A mono field-name label over a `sm` control.
        <View key={f.key} style={{ gap: space.xxs }}>
          <Text variant="mono" tone="quaternary">
            {(f.label || f.key).toLowerCase()}
            {f.required ? " *" : ""}
          </Text>
          <FieldControl field={f} value={props[f.key]} onChange={(v) => setField(f.key, v)} />
        </View>
      ))}
    </View>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ObjectField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case "number":
      return (
        <Input
          size="sm"
          mono
          value={value === undefined || value === null ? "" : String(value)}
          placeholder="0"
          onChangeText={(t) => {
            const trimmed = t.trim();
            if (trimmed === "") return onChange(undefined);
            const n = Number(trimmed);
            onChange(Number.isNaN(n) ? trimmed : n);
          }}
        />
      );
    case "date":
      return (
        <Input
          size="sm"
          mono
          autoCapitalize="none"
          value={typeof value === "string" ? value : ""}
          placeholder="YYYY-MM-DD"
          onChangeText={(t) => onChange(t)}
        />
      );
    case "url":
      return (
        <Input
          size="sm"
          mono
          autoCapitalize="none"
          value={typeof value === "string" ? value : ""}
          placeholder="https://…"
          onChangeText={(t) => onChange(t)}
        />
      );
    case "checkbox":
      return <ToggleField value={value === true} onChange={onChange} />;
    case "select":
      return <SelectField options={field.options ?? []} value={typeof value === "string" ? value : null} onChange={onChange} />;
    case "multi_select":
      return <MultiSelectField options={field.options ?? []} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
    case "reference":
      return <ReferenceField to={field.to} value={typeof value === "string" ? value : null} onChange={onChange} />;
    case "text":
    default:
      return (
        <Input
          size="sm"
          value={typeof value === "string" ? value : ""}
          placeholder="…"
          onChangeText={(t) => onChange(t)}
        />
      );
  }
}

function ToggleField({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const touch = useDensity() === "touch";
  const dim = touch ? 22 : 14;
  return (
    <Pressable
      onPress={() => onChange(!value)}
      aria-label={value ? "Checked" : "Unchecked"}
      hitSlop={touch ? 11 : 4}
      style={[styles.checkbox, { width: dim, height: dim, borderRadius: touch ? radius.sm : radius.xs }, value ? styles.checkboxOn : null]}
    >
      {value ? <Icon name="check" size={Math.round(dim * 0.72)} color={colors.onAccent} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

function SelectField({ options, value, onChange }: { options: string[]; value: string | null; onChange: (v: string | undefined) => void }) {
  return (
    <View style={styles.pillRow}>
      {options.map((opt) => {
        const on = opt === value;
        return (
          <Pill key={opt} label={opt} active={on} onPress={() => onChange(on ? undefined : opt)} />
        );
      })}
    </View>
  );
}

function MultiSelectField({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (opt: string) => {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt));
    else onChange([...value, opt]);
  };
  return (
    <View style={styles.pillRow}>
      {options.map((opt) => (
        <Pill key={opt} label={opt} active={value.includes(opt)} onPress={() => toggle(opt)} />
      ))}
    </View>
  );
}

/** A reference-field picker: a title search over the object graph (PLAN §5.2), scoped to
 *  the field's target type. Stores the picked node's id; a `prop:<field>` edge is derived
 *  by the core (§6.3). */
function ReferenceField({ to, value, onChange }: { to?: string; value: string | null; onChange: (v: string | undefined) => void }) {
  const { graph } = useCore();
  const touch = useDensity() === "touch";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GraphNode[]>([]);
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<GraphNode | null>(null);

  // Resolve the current id to a title chip.
  useEffect(() => {
    let alive = true;
    if (!value) {
      setResolved(null);
      return;
    }
    void graph.lookup(value).then((n) => {
      if (alive) setResolved(n);
    });
    return () => {
      alive = false;
    };
  }, [graph, value]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSearch = (q: string) => {
    setQuery(q);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const r = await graph.search(q, to && to !== "" ? to : "all", 8);
      setResults(r ?? []);
    }, 150);
  };

  if (value) {
    return (
      <View style={[styles.refChip, touch ? styles.refChipTouch : null]}>
        <Icon name="link" size={11} color={colors.textQuaternary} />
        <Text variant="mono" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>
          {resolved?.title || value}
        </Text>
        <Pressable onPress={() => onChange(undefined)} aria-label="Clear reference" hitSlop={touch ? 10 : 3} style={styles.refClear}>
          <Icon name="close" size={11} color={colors.textQuaternary} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ gap: space.xs }}>
      <Input
        size="sm"
        value={query}
        placeholder={`Search ${to || "note"}s…`}
        autoCapitalize="none"
        onChangeText={runSearch}
        leadingIcon={<Icon name="search" size={12} color={colors.textQuaternary} />}
      />
      {open && results.length > 0 ? (
        <View style={styles.dropdown}>
          {results.map((n) => (
            <Pressable
              key={`${n.type}:${n.id}`}
              onPress={() => {
                onChange(n.id);
                setQuery("");
                setResults([]);
                setOpen(false);
              }}
              style={({ hovered, pressed }: PressState) => [
                styles.dropdownRow,
                touch ? styles.dropdownRowTouch : null,
                hovered ? { backgroundColor: colors.surfaceHover } : null,
                pressed ? { backgroundColor: colors.surfaceActive } : null,
              ]}
            >
              <Text variant="label" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
                {n.title || "Untitled"}
              </Text>
              <Text variant="mono" tone="quaternary">
                {n.type}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A select option: a squared 22px chip (30px on touch) — soft accent when chosen. */
function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const touch = useDensity() === "touch";
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered, pressed }: PressState) => [
        styles.pill,
        touch ? styles.pillTouch : null,
        hovered ? { backgroundColor: colors.surfaceHover } : null,
        pressed ? { backgroundColor: colors.surfaceActive } : null,
        active ? styles.pillActive : null,
      ]}
    >
      <Text variant="caption" tone={active ? "accent" : "secondary"}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = {
  pillRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  pill: {
    height: control.sm,
    justifyContent: "center" as const,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  pillTouch: { height: control.lg, paddingHorizontal: space.ml },
  pillActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  // Same box as the task checkbox: 1px border-strong, accent fill + white check when on.
  checkbox: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  // A resolved reference reads like the editor's wikilink chip: mono on the sunken fill.
  refChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: control.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceSunken,
  },
  refChipTouch: { height: control.lg },
  refClear: { padding: 3, marginVertical: -3, marginRight: -3 },
  dropdown: {
    padding: space.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceCard,
  },
  dropdownRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: space.md,
    minHeight: row.h,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  dropdownRowTouch: { minHeight: row.touch },
};
