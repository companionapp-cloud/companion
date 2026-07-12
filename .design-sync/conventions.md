# Companion Design System — how to build with it

Companion is a **React-Native-for-web** design system (it renders through `react-native-web`).
That one fact drives every convention below.

## Styling idiom: props + style objects + tokens — NOT CSS classes

There are **no CSS classes, no Tailwind, no `className`** in this system. Every component is
already styled; you shape it two ways:

1. **Semantic props** carry the design language — `variant`, `tone`, `size`. Reach for these
   first (e.g. `<Button variant="primary" size="md">`, `<Text variant="heading" tone="secondary">`).
2. **The `style` prop** takes a **react-native style object** for your own layout glue:
   camelCase keys, **numeric** spacing (points, not `"12px"`), single values or arrays.
   Feed it token values, never hardcoded hex/px: `style={{ padding: space.lg, backgroundColor: colors.surfaceCard, borderRadius: radius.lg }}`.

No provider or theme wrapper is required — styles apply on mount. Fonts (Geist / Geist Mono)
ship inside `styles.css`.

## Tokens — import them from the package, don't invent values

`import { colors, space, radius, font, shadow, control } from "@companion/design-system"`

- **colors** — surfaces `surfaceApp` `surfaceCard` `surfaceSunken` `surfaceHover`; text `textPrimary`
  `textSecondary` `textTertiary` `textInverse`; borders `borderSubtle` `borderDefault` `borderStrong`;
  brand `accent` `accentHover` `accentSoft` `onAccent`; semantic `success` `warning` `danger`
  `dangerSoft` `info`. (Warm-gray ramp `gray0`…`gray950`, orange accent `#f76808`.)
- **space** (4px grid): `xs`(4) `sm`(6) `md`(8) `lg`(12) `xl`(16) `xxl`(24) `xxxl`(32).
- **radius**: `xs` `sm` `md` `lg` `xl` `xxl` `full`. Rounding is core to the brand — use it.
- **font**: `font.sans` / `font.mono`, `font.size.{2xs,xs,sm,base,md,lg,xl,2xl,3xl}`,
  `font.weight.{regular,medium,semibold,bold}`. Prefer `<Text variant=…>` over raw font tokens.
- **shadow**: `shadow.sm|md|lg` (react-native shadow props). **control**: control heights `sm|md|lg`.

## Layout: use the primitives, not flexbox CSS

`Stack` (vertical) and `Row` (horizontal) take `gap` (a **number**), `justify`
(`"start"|"center"|"end"|"between"`), and `align` (`"start"|"center"|"end"|"stretch"`).
`Center` centers its child (needs a bounded-height parent). `Divider` is a hairline rule.
Compose layout from these — do not reach for raw `<div>`/flex styles.

## Where the truth lives

- `styles.css` (and the `@font-face` it imports) — the shipped fonts + any global styling.
- Each component's `<Name>.d.ts` (its exact prop contract) and `<Name>.prompt.md` (usage) —
  read these before composing a component you haven't used.

## Key components & their semantic props

`Text` (variant `display|heading|title|body|label|caption|mono`, tone
`default|secondary|tertiary|accent|danger|inverse`) · `Button` (variant
`primary|secondary|ghost|danger`, size `sm|md|lg`, `label`, optional `icon`) · `IconButton`
(takes an `<Icon>` as **children** + required `label`) · `Icon` (`name`, `size`, `color`) ·
`Input` / `TextField` (borderless doc field: variant `title|prose`, `multiline`) · `Badge`
(`label`, tone `neutral|accent`) · `Avatar` (`name`, size `sm|md`) · `ListRow` · `Tab` ·
`RailItem` · `Spinner` · `ProgressRing` (`value` 0–1) · `Frame`/`Toolbar`/`FrameTitle`
(app-window chrome, compose together) · `SplitView` (two panes) · `Row`/`Stack`/`Center`/`Divider`.

## One idiomatic snippet

```jsx
import { Stack, Row, Text, Button, Badge, Icon, colors, space, radius } from "@companion/design-system";

function NoteCard() {
  return (
    <Stack gap={space.md} style={{ padding: space.xl, backgroundColor: colors.surfaceCard, borderRadius: radius.lg }}>
      <Row justify="between" align="center">
        <Text variant="title">Migrating the sync engine</Text>
        <Badge label="Draft" tone="accent" />
      </Row>
      <Text variant="body" tone="secondary">
        Conflicts now resolve field-by-field instead of replacing the whole document.
      </Text>
      <Row gap={space.sm}>
        <Button label="Open" variant="primary" size="sm" icon={<Icon name="external" size={16} color={colors.onAccent} />} />
        <Button label="Archive" variant="ghost" size="sm" />
      </Row>
    </Stack>
  );
}
```
