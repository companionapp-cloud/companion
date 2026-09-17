// A frozen snapshot of the design-system primitives the marketing site uses, taken before
// the app's dense redesign. The site ships a look the team is happy with and is
// deliberately out of that redesign's scope, so it keeps its own airy tokens (14px base,
// generous radii, round badges) instead of following @companion/design-system. Web-only:
// the DOM <svg> variants of Icon and BrandMark are the only ones here.
export * from "./tokens";
export { Icon } from "./Icon";
export type { IconProps, IconName } from "./iconPaths";
export { BrandMark } from "./BrandMark";
export type { BrandMarkProps } from "./BrandMark";
export { Text } from "./Text";
export type { TextProps, TextVariant, TextTone } from "./Text";
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";
export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";
export { ListRow } from "./ListRow";
export type { ListRowProps } from "./ListRow";
export { ProgressRing } from "./ProgressRing";
export type { ProgressRingProps } from "./ProgressRing";
