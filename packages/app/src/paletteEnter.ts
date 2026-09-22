import { Platform, StyleSheet } from "react-native";

const reducedMotion = Platform.OS === "web" && typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** How the palette arrives: it drops in from just above, overshoots a touch and settles — a
 *  bounce, pivoting on the top edge it hangs from. For the host's card (the palette itself has
 *  no surface). Nothing on native, or when the system asks for reduced motion. */
export const paletteEnter =
  Platform.OS === "web" && !reducedMotion
    ? // Through StyleSheet.create: react-native-web only compiles keyframes for registered styles.
      StyleSheet.create({
        enter: {
          animationKeyframes: [
            {
              // CSS strings: keyframes skip the resolver that turns RN transform arrays into CSS.
              "0%": { opacity: 0, transform: "translateY(-14px) scale(0.92)" },
              "55%": { opacity: 1, transform: "translateY(3px) scale(1.025)" },
              "78%": { transform: "translateY(-1px) scale(0.992)" },
              "100%": { opacity: 1, transform: "translateY(0) scale(1)" },
            },
          ],
          animationDuration: "320ms",
          animationTimingFunction: "cubic-bezier(0.2, 0, 0.2, 1)",
          animationFillMode: "both",
          transformOrigin: "top center",
        } as Record<string, unknown>,
      }).enter
    : null;
