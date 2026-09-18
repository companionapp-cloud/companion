export interface BrandMarkProps {
  size?: number;
  /** "tile" is the rounded orange app tile; "mono" is the bare glyph in `color`. */
  variant?: "tile" | "mono";
  /** Rounded-square backdrop. Pass "transparent" to render just the mark. */
  background?: string;
  /** The "C" arc + companion dot. */
  color?: string;
}
