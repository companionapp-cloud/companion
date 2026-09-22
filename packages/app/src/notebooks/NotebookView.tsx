import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { colors, useTheme } from "@companion/design-system";
import type { EditorController } from "@companion/editor";
import { NOTEBOOK_JS } from "../notebookBundle.generated";
import type { NotebookHost } from "./host";
import type { NotebookViewController, NotebookViewProps } from "./viewTypes";

export type { NotebookZoom, NotebookViewState, NotebookViewController, NotebookViewProps } from "./viewTypes";

// Native notebook view: the same DOM page view the web app renders, hosted in a WebView, the
// way the canvas and the note editor are. The bundle is built offline by
// scripts/build-notebook.mjs. The WebView drives the shared NotebookHost over postMessage RPC;
// the view's props are pushed in through window.__notebookProps, its callbacks arrive as
// "event" messages, and the controller is driven through window.__notebookCall. Web and
// desktop resolve NotebookView.web.tsx instead.

function buildHtml(notebookId: string, theme: string): string {
  const id = JSON.stringify(notebookId).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html${theme === "dark" ? ' data-theme="dark"' : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html,body{margin:0;padding:0;height:100%;width:100%;background:${colors.surfaceSunken};overflow:hidden;-webkit-text-size-adjust:100%;font-family:-apple-system,system-ui,sans-serif;}#notebook{position:absolute;inset:0;}</style>
</head>
<body>
<div id="notebook"></div>
<script>window.__NOTEBOOK_ID__ = ${id};</script>
<script>${NOTEBOOK_JS}</script>
</body>
</html>`;
}

type Message =
  | { type: "rpc"; payload: { requestId: number; method: string; args: unknown[] } }
  | { type: "event"; payload: { name: string; value: unknown } }
  | { type: "ready"; payload: null };

export const NotebookView = forwardRef<NotebookViewController, NotebookViewProps>(function NotebookView(
  { host, notebookId, mode, zoom, onZoom, tool, penTool, rulers, revision, onState, onActivePage, onFormatState, onInkState, onExitDrawing },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const theme = useTheme();
  const hostRef = useRef<NotebookHost>(host);
  hostRef.current = host;
  const cbs = useRef({ onZoom, onState, onActivePage, onFormatState, onInkState, onExitDrawing });
  cbs.current = { onZoom, onState, onActivePage, onFormatState, onInkState, onExitDrawing };
  const ready = useRef(false);

  // Built once per notebook (and theme); everything else flows through messages.
  const html = useMemo(() => buildHtml(notebookId, theme), [notebookId, theme]);

  const inject = (js: string) => webRef.current?.injectJavaScript(`${js} true;`);
  const jsonArg = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c");
  const call = (method: string, ...args: unknown[]) => inject(`window.__notebookCall && window.__notebookCall(${jsonArg(method)}, ${jsonArg(args)});`);

  // Push the view's props whenever they change (and once the page reports ready).
  const props = useMemo(() => ({ mode, zoom, tool, penTool, rulers, revision }), [mode, zoom, tool, penTool, rulers, revision]);
  useEffect(() => {
    if (ready.current) inject(`window.__notebookProps && window.__notebookProps(${jsonArg(props)});`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props]);

  // The editor controller for the current page, proxied into the WebView.
  const editor = useMemo<EditorController>(
    () => ({
      format: (name) => call("format", name),
      insertReference: () => call("insertReference"),
      insertTable: () => call("insertTable"),
      insertDocument: () => call("insertDocument"),
      resolveQuickCreate: (target) => call("resolveQuickCreate", target),
      inkUndo: () => call("inkUndo"),
      inkRedo: () => call("inkRedo"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useImperativeHandle(ref, () => ({ goTo: (page) => call("goTo", page), addPage: () => call("addPage"), editor: () => editor }), [editor]);

  const onMessage = async (event: WebViewMessageEvent) => {
    let msg: Message;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      ready.current = true;
      inject(`window.__notebookProps && window.__notebookProps(${jsonArg(props)});`);
      return;
    }
    if (msg.type === "event") {
      const c = cbs.current;
      const { name, value } = msg.payload;
      if (name === "zoom") c.onZoom(value as NotebookViewProps["zoom"]);
      else if (name === "state") c.onState(value as Parameters<NotebookViewProps["onState"]>[0]);
      else if (name === "activePage") c.onActivePage(value as Parameters<NotebookViewProps["onActivePage"]>[0]);
      else if (name === "formatState") c.onFormatState(value as Parameters<NotebookViewProps["onFormatState"]>[0]);
      else if (name === "inkState") c.onInkState(value as Parameters<NotebookViewProps["onInkState"]>[0]);
      else if (name === "exitDrawing") c.onExitDrawing();
      return;
    }
    if (msg.type !== "rpc") return;
    const { requestId, method, args } = msg.payload;
    const h = hostRef.current as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fn = h[method];
    const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }) => {
      if (requestId) inject(`window.__notebookResolve && window.__notebookResolve(${requestId}, ${jsonArg(result)});`);
    };
    if (typeof fn !== "function") {
      reply({ ok: false, error: `unknown host method ${method}` });
      return;
    }
    try {
      const value = await fn.apply(hostRef.current, args ?? []);
      reply({ ok: true, value: value ?? null });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <View style={styles.root}>
      <WebView
        ref={webRef}
        style={styles.web}
        originWhitelist={["*"]}
        source={{ html }}
        onMessage={(e) => void onMessage(e)}
        automaticallyAdjustContentInsets={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        // The page view scrolls itself (the stage); the WebView must not.
        scrollEnabled={false}
        bounces={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceSunken },
  web: { flex: 1, backgroundColor: "transparent" },
});
