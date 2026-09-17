import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { useDensity } from "./Density";
import { noDragRegion, transition, type PressState } from "./platform";
import { colors, control, motion, radius } from "./tokens";

export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps {
  children: ReactNode;
  label: string;
  onPress?: () => void;
  /** 22 / 26 / 30px square. Defaults to `md` with a pointer, `lg` on touch surfaces. */
  size?: IconButtonSize;
  /** Toggled on: the same soft-accent treatment as a selected row. */
  active?: boolean;
  disabled?: boolean;
}

/** Square, quiet button for a single icon (toolbars, list affordances). Transparent at
 * rest; the fill steps on hover and press, and nothing moves. */
export function IconButton({ children, label, onPress, size, active = false, disabled = false }: IconButtonProps) {
  const density = useDensity();
  const dim = control[size ?? (density === "touch" ? "lg" : "md")];
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      aria-label={label}
      // Touch targets stay ≥44px even though the drawn square is 30.
      hitSlop={density === "touch" ? 7 : undefined}
      style={({ hovered, pressed }: PressState) => [
        styles.base,
        noDragRegion,
        transition("background-color", motion.instant),
        {
          width: dim,
          height: dim,
          opacity: disabled ? 0.35 : 1,
          backgroundColor:
            disabled || (!active && !hovered && !pressed)
              ? "transparent"
              : active
                ? colors.accentSoft
                : pressed
                  ? colors.surfaceActive
                  : colors.surfaceHover,
        },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", borderRadius: radius.sm, flexShrink: 0 },
});
