import { View, type GestureResponderHandlers } from "react-native";
import { Icon, colors, noDragRegion, noSelect, space } from "@companion/design-system";

// A click on the grip must not bubble to the row's Pressable and open the item.
const SWALLOW_CLICK = { onClick: (e: { stopPropagation: () => void }) => e.stopPropagation() } as object;

/** The grip at a list row's far right — the one place a row's drag starts from, so the row
 *  itself stays a plain press target and its text never fights the gesture. `handlers` come
 *  from whatever drives the drag: a drop onto the sidebar (DragHandle) or a reorder
 *  (SortableList's `drag`, with `activateOnStart`). */
export function DragGrip({ handlers, label }: { handlers: GestureResponderHandlers; label: string }) {
  return (
    <View {...handlers} {...SWALLOW_CLICK} aria-label={label} style={[styles.grip, noSelect, noDragRegion]}>
      <Icon name="grip" size={12} color={colors.textTertiary} strokeWidth={2.5} />
    </View>
  );
}

const styles = {
  grip: {
    width: 16,
    // The full height of a dense row, so the grip is an easy target.
    height: 24,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    // Sit flush with the row's right edge (rows pad their right side by space.sm).
    marginRight: -space.xs,
    cursor: "grab",
  },
};
