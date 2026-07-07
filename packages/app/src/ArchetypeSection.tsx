import { useState } from "react";
import { Pressable, View } from "react-native";
import type { ObjectProps } from "@companion/core-bridge";
import { Icon, Text, colors, radius, space, type IconName, type PressState } from "@companion/design-system";
import { useObjectTypes } from "./ObjectTypesProvider";
import { ObjectForm } from "./ObjectForm";

/** The archetype block for a note/task editor (PLAN §6.3): a chip that shows/sets the
 *  object type, and — once a type is chosen — the structured props form. Applying a type
 *  and editing its props persist through the provided callbacks; the core validates. */
export function ArchetypeSection({
  kind,
  objectTypeId,
  props,
  onSetType,
  onClearType,
  onChangeProps,
}: {
  kind: "note" | "task";
  objectTypeId?: string | null;
  props?: ObjectProps;
  onSetType: (typeId: string) => void;
  onClearType: () => void;
  onChangeProps: (next: ObjectProps) => void;
}) {
  const objectTypes = useObjectTypes();
  const [picking, setPicking] = useState(false);
  const active = objectTypes.byId(objectTypeId);
  const candidates = objectTypes.forKind(kind);

  // No archetype: a ghost chip that opens a picker. Always shown (even with no types yet)
  // so making a note/task an object is discoverable; an empty picker points to Settings.
  if (!objectTypeId) {
    return (
      <View style={styles.wrap}>
        <Pressable onPress={() => setPicking((v) => !v)} style={styles.ghostChip}>
          <Icon name="file" size={13} color={colors.textTertiary} />
          <Text variant="caption" tone="tertiary">
            Add type
          </Text>
        </Pressable>
        {picking ? (
          <View style={styles.dropdown}>
            {candidates.length === 0 ? (
              <View style={styles.dropdownRow}>
                <Text variant="caption" tone="tertiary">
                  No object types yet — create one in Settings → Objects.
                </Text>
              </View>
            ) : (
              candidates.map((t) => (
                <Pressable
                  key={t.id}
                  onPress={() => {
                    onSetType(t.id);
                    setPicking(false);
                  }}
                  style={({ hovered }: PressState) => [styles.dropdownRow, hovered ? { backgroundColor: colors.surfaceHover } : null]}
                >
                  <Text variant="caption">{t.name}</Text>
                  <Text variant="caption" tone="tertiary">
                    {t.appliesTo}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        ) : null}
      </View>
    );
  }

  // Archetyped: show the type chip + its props form. A dangling type (deleted/not synced)
  // still lets the user clear it, tolerating the dangle (PLAN §5.1).
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Icon
          name={(active?.schemaJson.icon as IconName) || "file"}
          size={14}
          color={active?.schemaJson.color || colors.accentHover}
        />
        <Text variant="caption" tone="secondary" style={{ fontWeight: "600", flex: 1 }}>
          {active?.name ?? "Unknown type"}
        </Text>
        <Pressable onPress={onClearType} aria-label="Remove type" style={styles.clear}>
          <Icon name="close" size={13} color={colors.textTertiary} />
        </Pressable>
      </View>
      {active ? (
        <ObjectForm schema={active.schemaJson} props={props ?? {}} onChange={onChangeProps} />
      ) : (
        <Text variant="caption" tone="tertiary">
          This type isn’t available on this device yet.
        </Text>
      )}
    </View>
  );
}

const styles = {
  wrap: { gap: space.xs },
  ghostChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    alignSelf: "flex-start" as const,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  card: {
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  cardHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
  clear: { padding: 3, marginVertical: -3, marginRight: -3 },
  dropdown: {
    alignSelf: "flex-start" as const,
    minWidth: 180,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceCard,
    overflow: "hidden" as const,
  },
  dropdownRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
};
