import { useCallback, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, Text, colors, motion, radius, space, transition, type PressState } from "@companion/design-system";

const KEY_PREFIX = "companion.listFold.";

/** Whether a list section is open. Per-device, mirrored to localStorage (absent on native and
 *  in some sandboxes, hence the guards — see useCollapsedAreas) so a fold survives the list
 *  unmounting; `defaultOpen` applies until the user first toggles it. */
function useFold(storageKey: string, defaultOpen: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      const raw = globalThis.localStorage?.getItem(KEY_PREFIX + storageKey);
      return raw === "1" ? true : raw === "0" ? false : defaultOpen;
    } catch {
      return defaultOpen;
    }
  });
  const toggle = useCallback(() => {
    setOpen((prev) => {
      try {
        globalThis.localStorage?.setItem(KEY_PREFIX + storageKey, prev ? "0" : "1");
      } catch {
        // Storage is best-effort.
      }
      return !prev;
    });
  }, [storageKey]);
  return [open, toggle];
}

/** A foldable list section: an eyebrow header with a fold chevron (as the rail's area
 *  headings) over its rows, which only mount while open. */
export function ListSectionFold({
  label,
  storageKey,
  defaultOpen,
  children,
}: {
  label: string;
  storageKey: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useFold(storageKey, defaultOpen);
  return (
    <>
      <Pressable
        onPress={toggle}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
        style={({ hovered, pressed }: PressState) => [
          styles.header,
          { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
        ]}
      >
        <View style={[styles.fold, { transform: [{ rotate: open ? "90deg" : "0deg" }] }, transition("transform", motion.fast)]}>
          <Icon name="chevronRight" size={10} color={colors.textQuaternary} />
        </View>
        <Text variant="eyebrow" tone="quaternary" numberOfLines={1} style={{ flex: 1 }}>
          {label}
        </Text>
      </Pressable>
      {open ? children : null}
    </>
  );
}

const styles = {
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    marginTop: space.md,
    paddingHorizontal: space.xs,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  fold: { width: 14, height: 16, alignItems: "center" as const, justifyContent: "center" as const, flexShrink: 0 },
};
