import { useMemo, useRef } from "react";
import { StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { EDITOR_JS } from "./editorBundle.generated";
import { EDITOR_CSS } from "./styles";
import type { EditorProps } from "./types";

// Native editor: ProseMirror hosted in a plain react-native-webview. The editor code
// is bundled offline into EDITOR_JS (`npm run build:editor`) and embedded below. A raw
// WebView is used rather than Expo's `use dom`, whose DomWebView crashes on mount on
// Android + the New Architecture. Web/desktop resolve Editor.web.tsx instead (DOM).
function buildHtml(markdown: string): string {
  // Escape `<` so note content can't break out of the <script> (e.g. "</script>").
  const initial = JSON.stringify(markdown).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html,body{margin:0;padding:0;min-height:100%;background:#ffffff;}${EDITOR_CSS}</style>
</head>
<body>
<div id="editor" class="pm-wrap"></div>
<script>window.__INITIAL_MARKDOWN__ = ${initial};</script>
<script>${EDITOR_JS}</script>
</body>
</html>`;
}

export function Editor({ markdown, onChangeMarkdown }: EditorProps) {
  const onChangeRef = useRef(onChangeMarkdown);
  onChangeRef.current = onChangeMarkdown;

  // Built once from the initial content; the WebView owns edits thereafter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => buildHtml(markdown), []);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "change" && typeof msg.payload === "string") {
        onChangeRef.current(msg.payload);
      }
    } catch {
      // ignore malformed messages
    }
  };

  return (
    <WebView
      style={styles.web}
      originWhitelist={["*"]}
      source={{ html }}
      onMessage={onMessage}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      automaticallyAdjustContentInsets={false}
      overScrollMode="never"
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
});
