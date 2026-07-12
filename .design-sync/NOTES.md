# design-sync notes — @companion/design-system

## Architecture (why this repo needs a custom build step)

- The DS is **React Native primitives rendered on web via `react-native-web`**. Components
  import from `react-native` (`Pressable`, `Text`, `StyleSheet`, `View`, …); a handful ship
  a `.web.tsx` variant (Icon, BrandMark, ProgressRing) that avoids `react-native-svg`.
  Web resolution = `react-native → react-native-web` alias + `.web.tsx` extension priority,
  exactly as `apps/web/vite.config.ts` does it.
- The package **has no build** — `main: ./src/index.ts`, consumed as raw source by the apps'
  bundlers. So design-sync can't point `--entry` at a shipped dist and there are no `.d.ts`.
- **`.design-sync/build-web-dist.mjs`** fills both gaps (run via `cfg.buildCmd`):
  - `tsc --emitDeclarationOnly` → `packages/design-system/dist/types/*.d.ts` (prop contracts).
  - esbuild web pre-bundle → `packages/design-system/dist/index.web.mjs` (react-native-web
    inlined, `react`/`react/jsx-runtime` kept external for the converter's own IIFE shim).
  - `cfg.entry` points the converter at that pre-bundle; only `react` remains bare, which the
    converter's `reactShim` binds to `window.React`.

## Discovery is driven by cfg.componentSrcMap (NOT the .d.ts barrel)

- The converter's `exportedNames`/`getSourceFile(entry)` looks for `<pkgDir>/index.d.ts`
  (or `pkgJson.types`). This repo has neither and we deliberately do NOT add a `types` field
  to the shared package.json (it would point consumers' TS at gitignored dist and break
  typechecking on a fresh clone). So the barrel-based discovery finds nothing.
- Instead every component is enumerated in `cfg.componentSrcMap` (non-null entries ADD names).
  Prop extraction still works: `propsBodyFor` globs `<Name>Props` across all `.d.ts` under the
  types root (`dist/types/`) filtered by pkgDir prefix.
- **Adding a new DS component?** add it to `cfg.componentSrcMap` with its `src/*.tsx` path.
  `Layout.tsx` exports Center/Divider/Row/Stack; `Frame.tsx` exports Frame/Toolbar/FrameTitle —
  multiple map entries point at one file, that's expected.
- Side effect of empty `exported` set: the adherence raw-element map (`<button>`→Button, etc.)
  is not populated. Acceptable — the app regenerates adherence from source on upload.

## Styling / fonts

- Runtime-styled: react-native-web injects styles from inline `StyleSheet`/style props. There
  is **no shipped component CSS** → expect `[CSS_RUNTIME]` (self-styling bundle, non-blocking).
- Fonts: the DS asks for **Geist** + **Geist Mono** (host app loads them from Google Fonts in
  `apps/web/index.html`). See "Re-sync risks" — fonts must be shipped with the bundle or every
  preview renders in a fallback face. [TODO: wire fonts]

## Preview authoring patterns (proven on the solo set — Button/Text/ListRow all graded good)

- Fonts CONFIRMED rendering: Geist (sans) + Geist Mono visibly applied in captures. Tokens,
  colors, icons (Icon.web.tsx inline svg), and press/selected states all render correctly in
  headless Chrome. react-native-web injects styles at mount — no provider needed.
- Preview file = `.design-sync/previews/<Name>.tsx`; each **named export is a story cell**,
  rendered as `<Export/>` (a component fn, no props). 2–6 cells per component.
- Import components AND tokens from `@companion/design-system` (e.g. `import { Stack, Row,
  Center, colors } from "@companion/design-system"`). Layout via Stack/Row (`gap` number,
  `justify`, `align` props) / Center; wrap cell content in `style={{ padding: 16 }}` and set a
  `backgroundColor: colors.surfaceCard` on list/panel containers so they read as real surfaces.
- Realistic content only (note-taking app domain: notes, tasks, projects, calendar) — never
  foo/test. Valid Icon names: chat notes calendar today bell tasks habits search plus folder
  file chevronRight chevronLeft settings link panelLeft panelRight moreH trash external close
  check dot graph repeat refresh bold italic strikethrough code codeBlock quote listBullet
  listOrdered table.
- Compose context-required leaves inside their parent (e.g. FrameTitle/Toolbar inside Frame).

## Component API quick-reference (learned while authoring previews — all 22 graded good)

- **Avatar**: `name` (initials derived), `size` "sm"|"md" (NOT a number).
- **Badge**: `label` + `tone` "neutral"|"accent"; mono text in a pill.
- **BrandMark**: `size` (number), `background` (accepts "transparent" for a bare mark on colored surfaces), `color`; composes with a wordmark for a lockup.
- **Icon**: `name` (required, see valid names above), `size`, `color`. Web renders via Icon.web.tsx (inline DOM svg).
- **IconButton**: takes the icon as **`children`** (an `<Icon>`), NOT an `icon` prop; `label` REQUIRED (a11y); `active` uses accentSoft bg (pair with `color={colors.accent}` on the icon); `disabled` dims to 0.35.
- **Input**: controlled RN TextInput — static `value`/`defaultValue` renders fine in screenshots; `leadingIcon` is a ReactNode `<Icon>`; `size` sm/md → control heights 28/34.
- **TextField**: a **borderless document field, not a labeled form field** — no label/error props; only `variant` "title"|"prose" + `multiline`. Compose as note-editor content on a surfaceCard panel.
- **Tab**: `label`, `active` (raised card look), an icon at size ~13, `onClose`/`onExpand` render affordances.
- **RailItem**: `expanded` toggles label + width (100% vs 40px), `active` = accentSoft + accent label.
- **Spinner**: `label` only (no size axis); renders inside `<Center>` which is `flex:1`, so bare use needs a height-bounded wrapper.
- **ProgressRing**: `value` 0..1 + `size`; swaps to a filled-check completion state at value≥1.
- **Layout — Center/Row/Stack/Divider**: Center is `flex:1` (needs a bounded parent to fill); Row/Stack `gap` is a number, `justify`/`align` are string enums.
- **Frame / Toolbar / FrameTitle**: compose together — Frame is `flex:1` + surfaceApp; author Toolbar/FrameTitle previews as full `<Frame toolbar={<Toolbar><FrameTitle/>…</Toolbar>}>` compositions inside a sized Stack.
- **SplitView**: root is `height:100%` so needs a fixed-height parent; `asideSide` ("right") + `defaultWidth` both work; panes need `height:"100%"` + a bg to fill.
- Compose everything from `@companion/design-system` imports (Stack/Row/Center/Text/Button/Icon/colors) — never raw `View`/`div`.

## Render-check gotchas (all handled — recorded so a regression is recognizable)

- **react-native-web stylesheet id collision (CRITICAL).** RNW injects `<style
  id="react-native-stylesheet">` into `<head>` with rules added via CSSOM `insertRule`, so its
  `innerHTML` stays empty. The validator measures `querySelectorAll('#root,[id^="r"]')[0]` as the
  render root — that empty `<style>` matches `[id^="r"]` and sorts first, so EVERY preview falsely
  reads `[RENDER] root empty` even though the cells render fine. Fixed by a `footer` in
  `build-web-dist.mjs` that renames RNW's `style[id^="react-native"]` elements off the `r*` prefix
  (immediate + MutationObserver). **If a future validate shows ALL 22 components root-empty, this
  footer regressed** — restore it. Harmless in shipped designs (RNW holds the sheet by reference).
- **Known render warns:** none currently. `[GRID_OVERFLOW]` on wide compositions is handled by
  `cfg.overrides.<Name>.cardMode = "column"` (Button, Divider, Frame, FrameTitle, Row, SplitView,
  Stack, TextField, Toolbar) — column cards can't re-flag, so this is stable.
- **Render check runs on system Chrome:** `playwright` (npm only, no bundled chromium) is installed
  in `.ds-sync/`; point it at Chrome via `export DS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` before every validate/capture.

## Re-sync risks / watch-list

- `dist/` is generated by `cfg.buildCmd` and gitignored — always rebuilt, never committed.
- `.design-sync/node_modules` is a fork symlink (→ ../.ds-sync/node_modules) so the committed
  build script can resolve esbuild; recreate on a fresh clone:
  `ln -sfn ../.ds-sync/node_modules .design-sync/node_modules`.
- **Fonts (`.design-sync/fonts.css`) are committed, self-contained data-URI woff2** — Geist +
  Geist Mono, **latin subset only**, fetched once from Google Fonts (css2). Non-latin glyphs fall
  back. To refresh/extend: re-fetch the css2 CSS and re-embed the woff2 as base64 @font-face (the
  one-off fetch script was not committed — regenerate from the Google Fonts css2 URL in
  `apps/web/index.html`). The build script copies this file into `dist/fonts.css` (cfg.cssEntry).
- **componentSrcMap must be maintained by hand** — discovery is NOT barrel-driven (no `types`
  field on the shared package.json by design). A new DS component won't sync until it's added to
  `cfg.componentSrcMap`. If the DS ever ships its own build + `.d.ts` + a `types` field, revisit:
  `cfg.entry`, the build script, and componentSrcMap could all be simplified/removed.
- Grades carried forward cleanly (22/22, 0 cleared) — next sync will be fast and mostly
  deterministic. Previews in `.design-sync/previews/` are tied to the current component APIs; if a
  component's props change upstream, its preview may need updating (re-grade will catch a broken
  render).
