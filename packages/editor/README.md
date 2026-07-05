# @companion/editor

The shared rich-text note editor (ProseMirror, markdown in/out). One `Editor` component,
two platform implementations resolved at build time:

- **`Editor.web.tsx`** (web/desktop) — ProseMirror mounted straight into the DOM. Vite
  resolves this via `.web.tsx`. No WebView: react-native-web is real DOM.
- **`Editor.tsx`** (native) — a `react-native-webview` hosting the same ProseMirror setup,
  bundled offline into a string. Metro resolves this. (Expo's `use dom` was tried first but
  its DomWebView crashes on mount on Android + the New Architecture.)

Both share `createEditor.ts` (the ProseMirror setup) and `styles.ts` (the CSS), so the
platforms can't drift.

```
src/
  createEditor.ts   shared ProseMirror setup (pure DOM)
  styles.ts         shared CSS (injected on web, embedded in the WebView HTML on native)
  types.ts          EditorProps
  Editor.web.tsx    web/desktop: ProseMirror in the DOM
  Editor.tsx        native: react-native-webview + the bundled editor
  webview/main.ts   native WebView entry (uses createEditor + postMessage)
  editorBundle.generated.ts   esbuild output embedded by Editor.tsx (committed)
```

## Usage

```tsx
import { Editor } from "@companion/editor";

<Editor markdown={note.contentMd} onChangeMarkdown={(md) => save(id, { contentMd: md })} />
```

`markdown` seeds the editor once; it owns its content thereafter and reports edits back
(debounced) via `onChangeMarkdown`. The editor fills its parent, so size it from outside.

## Building the native bundle

The native WebView needs ProseMirror as an offline string. After editing `createEditor.ts`
or anything under `webview/`, regenerate it:

```sh
npm run build:editor -w @companion/editor   # → src/editorBundle.generated.ts
```

The generated file is committed so a fresh checkout builds without the esbuild step. Web
and desktop don't use it — they import ProseMirror directly through Vite.
