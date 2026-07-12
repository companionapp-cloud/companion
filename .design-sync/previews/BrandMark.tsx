import { Row, Stack, BrandMark, Text, colors } from "@companion/design-system";

/** The Companion mark at the sizes it ships in — sidebar rail to app header. */
export function Sizes() {
  return (
    <Row gap={16} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <BrandMark size={26} />
      <BrandMark size={40} />
      <BrandMark size={56} />
    </Row>
  );
}

/** The mark paired with the wordmark, as it reads in the app header. */
export function Lockup() {
  return (
    <Row gap={10} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <BrandMark size={32} />
      <Text variant="title">Companion</Text>
    </Row>
  );
}

/** Just the mark, backdrop dropped — for use on colored surfaces. */
export function Bare() {
  return (
    <Row gap={16} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <BrandMark size={44} background="transparent" color={colors.accent} />
      <BrandMark size={44} background="transparent" color={colors.gray700} />
    </Row>
  );
}
