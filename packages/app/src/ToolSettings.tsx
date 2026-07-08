import { View } from "react-native";
import { Icon, Text, colors, radius, space } from "@companion/design-system";
import { Checkbox } from "./TaskEditor";
import { SortableList } from "./SortableList";
import { useToolVisibility, type ToolId } from "./ToolVisibilityProvider";

/** Settings › Tools: choose which tools show in the sidebar on this device, and in what
 *  order. Stored locally (never synced) — each device curates its own rail. Hiding a tool
 *  only removes its sidebar entry; the view stays reachable by URL/deep link. Drag a row by
 *  its handle to reorder. */
export function ToolSettings() {
  const { tools, hidden, setHidden, reorder } = useToolVisibility();
  return (
    <View style={{ gap: space.md }}>
      <Text variant="caption" tone="tertiary" style={{ lineHeight: 18 }}>
        Choose which tools appear in the sidebar and drag to reorder them. This only applies to
        this device, and a hidden tool is just tucked away — links to it still work.
      </Text>
      <View style={styles.card}>
        <SortableList
          items={tools}
          keyExtractor={(t) => t.id}
          onReorder={(ids) => reorder(ids as ToolId[])}
          renderItem={({ item: t, index, isActive, drag }) => {
            const visible = !hidden.has(t.id);
            return (
              <View
                style={[
                  styles.row,
                  index === tools.length - 1 ? null : styles.rowDivider,
                  isActive ? styles.rowActive : null,
                ]}
              >
                {/* Drag handle: claims the gesture on vertical movement so a tap still hits the
                    checkbox. Cursor hints it's grabbable on web. */}
                <View {...drag} style={styles.handle} aria-label={`Reorder ${t.label}`}>
                  <Icon name="moreH" size={16} color={colors.textTertiary} />
                </View>
                <Icon name={t.icon} size={18} color={visible ? colors.textSecondary : colors.textTertiary} />
                <Text style={{ flex: 1 }} tone={visible ? "default" : "tertiary"}>
                  {t.label}
                </Text>
                <Checkbox
                  checked={visible}
                  onPress={() => setHidden(t.id, visible)}
                  size={20}
                  label={visible ? `Hide ${t.label} from the sidebar` : `Show ${t.label} in the sidebar`}
                />
              </View>
            );
          }}
        />
      </View>
    </View>
  );
}

const styles = {
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingLeft: space.md,
    paddingRight: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.surfaceCard,
  },
  rowActive: { backgroundColor: colors.surfaceActive },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  // Generous hit area so the handle is easy to grab; a grab cursor on web.
  handle: { paddingVertical: space.xs, paddingHorizontal: space.xs, cursor: "grab" as const },
};
