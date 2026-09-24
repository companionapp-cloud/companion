import { View, type ViewStyle } from "react-native";
import { Icon, Text, colors, icon, radius, row, space, useDensity } from "@companion/design-system";
import { SortableList } from "./SortableList";
import { CheckBox, SettingsNote } from "./settingsUi";
import { useToolVisibility, type ToolId } from "./ToolVisibilityProvider";
import { usePomodoroEnabled } from "./pomodoro/usePomodoroEnabled";

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
                <View style={styles.checkCell}>
                  <CheckBox
                    checked={visible}
                    onPress={() => setHidden(t.id, visible)}
                    ariaLabel={visible ? `Hide ${t.label} from the sidebar` : `Show ${t.label} in the sidebar`}
                  />
                </View>
              </View>
            );
          }}
        />
      </View>
      <ExtraTools />
    </View>
  );
}

/** Tools that aren't sidebar views but can still be switched on or off per device — today the
 *  pomodoro timer, which only the desktop app can host (off until switched on). */
function ExtraTools() {
  const pomodoro = usePomodoroEnabled();
  const touch = useDensity() === "touch";
  if (!pomodoro.available) return null;
  const on = pomodoro.enabled;
  return (
    <>
      <SettingsNote>
        More tools, off until you switch them on. A tool you switch off disappears from everywhere it shows up.
      </SettingsNote>
      <View style={styles.list}>
        <View style={[styles.row, styles.extraRow, { minHeight: touch ? row.touch : 28 }]}>
          <Icon name="timer" size={touch ? icon.lg : icon.sm} color={on ? colors.textSecondary : colors.textQuaternary} />
          <View style={{ flex: 1, paddingVertical: space.xs }}>
            <Text variant="label" tone={on ? "default" : "tertiary"} numberOfLines={1}>
              Pomodoro timer
            </Text>
            <Text variant="caption" tone="tertiary">
              A stopwatch on every task starts a 25-minute focus session, timed in the menu bar.
            </Text>
          </View>
          <View style={styles.checkCell}>
            <CheckBox
              checked={on}
              onPress={() => pomodoro.setEnabled(!on)}
              ariaLabel={on ? "Turn off the pomodoro timer" : "Turn on the pomodoro timer"}
            />
          </View>
        </View>
      </View>
    </>
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
  // No drag handle, so the icon lines up with the sidebar tools' icons.
  extraRow: { paddingLeft: space.xs * 3 + icon.sm + space.md },
  // CheckBox keeps to the start of its line (alignSelf: flex-start, for stacked forms), which in a
  // row would pin it to the top; its own cell is what the row centres.
  checkCell: { justifyContent: "center" as const },
  rowActive: { backgroundColor: colors.surfaceActive },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  // Generous hit area so the handle is easy to grab.
  handle: { alignSelf: "stretch" as const, justifyContent: "center" as const, paddingHorizontal: space.xs },
  handleTouch: { paddingHorizontal: space.md },
};
