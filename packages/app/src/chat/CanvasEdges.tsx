import { StyleSheet, View } from "react-native";
import Svg, { Circle, G, Path } from "react-native-svg";
import { colors } from "@companion/design-system";
import type { EdgeShape } from "./thumbnailGeometry";

const WIDTH = 1.25;

/** The canvas miniature's arrows (native: react-native-svg). Web/desktop resolve
 *  CanvasEdges.web.tsx (inline DOM <svg>) instead; both draw the shapes thumbnailGeometry.ts
 *  computed. */
export function CanvasEdges({ shapes, width, height }: { shapes: EdgeShape[]; width: number; height: number }) {
  return (
    <View style={styles.layer}>
      <Svg width={width} height={height}>
        {shapes.map((s) => {
          const color = s.color ?? colors.borderStrong;
          return (
            <G key={s.id}>
              <Path d={s.d} fill="none" stroke={color} strokeWidth={WIDTH} strokeLinecap="round" strokeLinejoin="round" />
              {s.marks.map((m, i) =>
                m.kind === "chevron" ? (
                  <Path key={i} d={m.d} fill="none" stroke={color} strokeWidth={WIDTH} strokeLinecap="round" strokeLinejoin="round" />
                ) : m.kind === "triangle" ? (
                  <Path key={i} d={m.d} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
                ) : (
                  <Circle key={i} cx={m.cx} cy={m.cy} r={m.r} fill={m.kind === "dotFilled" ? color : colors.surfaceCard} stroke={color} strokeWidth={WIDTH} />
                ),
              )}
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" },
});
