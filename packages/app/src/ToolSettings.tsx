import { View, type ViewStyle } from "react-native";
import { Icon, Text, colors, icon, radius, row, space, useDensity } from "@companion/design-system";
import { SortableList } from "./SortableList";
import { CheckBox, SettingsNote } from "./settingsUi";
import { useToolVisibility, type ToolId } from "./ToolVisibilityProvider";

/** Settings › Tools: choose which tools show in the sidebar on this device, and in what
 *  order. Stored locally (never synced) — each device curates its own rail. Hiding a tool
 *  only removes its sidebar entry; the view stays reachable by URL/deep link. Drag a row by
 *  its handle to reorder. */
export function ToolSettings() {
  const { tools, hidden, setHidden, reorder } = useToolVisibility();
  const touch = useDensity() === "touch";
  return (
    <View style={styles.section}>
      <SettingsNote>
        Choose which tools appear in the sidebar and drag to reorder them. This only applies to this device, and a hidden
        tool is just tucked away — links to it still work.
      </SettingsNote>
      <View style={styles.list}>
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
                  { minHeight: touch ? row.touch : 28 },
                  index === tools.length - 1 ? null : styles.rowDivider,
                  isActive ? styles.rowActive : null,
                ]}
              >
                {/* Drag handle: claims the gesture on vertical movement so a tap still hits the
                    checkbox. Cursor hints it's grabbable on web. */}
                <View {...drag} style={[styles.handle, grabCursor, touch ? styles.handleTouch : null]} aria-label={`Reorder ${t.label}`}>
                  <Icon name="moreH" size={touch ? icon.lg : icon.sm} color={colors.borderStrong} />
                </View>
                <Icon name={t.icon} size={touch ? icon.lg : icon.sm} color={visible ? colors.textSecondary : colors.textQuaternary} />
                <Text variant="label" style={{ flex: 1 }} tone={visible ? "default" : "tertiary"} numberOfLines={1}>
                  {t.label}
                </Text>
                <CheckBox
                  checked={visible}
                  onPress={() => setHidden(t.id, visible)}
                  ariaLabel={visible ? `Hide ${t.label} from the sidebar` : `Show ${t.label} in the sidebar`}
                />
              </View>
            );
          }}
        />
      </View>
    </View>
  );
}

// A grab cursor on web. Not a value native's ViewStyle knows, hence the cast (it no-ops there).
const grabCursor = { cursor: "grab" } as unknown as ViewStyle;

const styles = {
  section: { gap: space.lg },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingLeft: space.xs,
    paddingRight: space.ml,
    backgroundColor: colors.surfaceCard,
  },
  rowActive: { backgroundColor: colors.surfaceActive },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  // Generous hit area so the handle is easy to grab.
  handle: { alignSelf: "stretch" as const, justifyContent: "center" as const, paddingHorizontal: space.xs },
  handleTouch: { paddingHorizontal: space.md },
};
