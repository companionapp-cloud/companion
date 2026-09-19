import { colors } from "@companion/design-system";
import type { EdgeShape } from "./thumbnailGeometry";

const WIDTH = 1.25;

/** The canvas miniature's arrows (web/desktop: inline DOM <svg>). Colors go through `style`,
 *  since theme colors are CSS variables here. The native variant (CanvasEdges.tsx) draws the same
 *  shapes with react-native-svg. */
export function CanvasEdges({ shapes, width, height }: { shapes: EdgeShape[]; width: number; height: number }) {
  return (
    <svg width={width} height={height} aria-hidden style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}>
      {shapes.map((s) => {
        const color = s.color ?? colors.borderStrong;
        return (
          <g key={s.id}>
            <path d={s.d} style={{ fill: "none", stroke: color, strokeWidth: WIDTH, strokeLinecap: "round", strokeLinejoin: "round" }} />
            {s.marks.map((m, i) =>
              m.kind === "chevron" ? (
                <path key={i} d={m.d} style={{ fill: "none", stroke: color, strokeWidth: WIDTH, strokeLinecap: "round", strokeLinejoin: "round" }} />
              ) : m.kind === "triangle" ? (
                <path key={i} d={m.d} style={{ fill: color, stroke: color, strokeWidth: 1, strokeLinejoin: "round" }} />
              ) : (
                <circle key={i} cx={m.cx} cy={m.cy} r={m.r} style={{ fill: m.kind === "dotFilled" ? color : colors.surfaceCard, stroke: color, strokeWidth: WIDTH }} />
              ),
            )}
          </g>
        );
      })}
    </svg>
  );
}
