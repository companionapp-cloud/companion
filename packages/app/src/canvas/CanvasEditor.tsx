import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { CANVAS_CSS, CANVAS_JS } from "../canvasBundle.generated";
import { useCanvasHost } from "./useCanvasHost";
import type { CanvasHost, CanvasRefKind } from "./host";

// Native canvas editor: the exact same React Flow board the web app renders, hosted in a
// WebView (React Flow is DOM-only), the way the graph and the note editor are. The bundle
// is built offline by scripts/build-canvas.mjs. The WebView drives the shared CanvasHost
// over postMessage RPC: each call is answered through window.__canvasResolve, and board
// change events are pushed in through window.__canvasChanged. Pickers (note/task/event
// search, the link prompt, the OS image picker) run natively over the WebView.
// Web/desktop resolve CanvasEditor.web.tsx (React Flow straight in the DOM) instead.

export interface CanvasEditorProps {
  canvasId: string;
  /** Where an embedded entity opens (a pushed native route). Defaults to a no-op. */
  onOpenRef?: (ref: { type: CanvasRefKind; id: string }) => void;
  /** Create and open a new board (⌘⇧N on a hardware keyboard). */
  onNewCanvas?: () => void;
}

function buildHtml(canvasId: string): string {
  const id = JSON.stringify(canvasId).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>html,body{margin:0;padding:0;height:100%;width:100%;background:#f5f5f3;overflow:hidden;-webkit-text-size-adjust:100%;}#canvas{position:absolute;inset:0;}${CANVAS_CSS}</style>
</head>
<body>
<div id="canvas"></div>
<script>window.__CANVAS_ID__ = ${id};</script>
<script>${CANVAS_JS}</script>
</body>
</html>`;
}

type RpcMessage = { type: "rpc"; payload: { requestId: number; method: string; args: unknown[] } } | { type: "ready"; payload: null };

export function CanvasEditor({ canvasId, onOpenRef, onNewCanvas }: CanvasEditorProps) {
  const webRef = useRef<WebView>(null);
  const { host, dialogs } = useCanvasHost({ onOpenRef: (ref) => onOpenRef?.(ref), onNewCanvas });
  const hostRef = useRef<CanvasHost>(host);
  hostRef.current = host;

  // Built once per board; data flows through RPC so the WebView never reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => buildHtml(canvasId), [canvasId]);

  const inject = (js: string) => webRef.current?.injectJavaScript(`${js} true;`);
  const jsonArg = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c");

  // Forward board change events into the WebView.
  useEffect(() => {
    return host.onChanged((id) => inject(`window.__canvasChanged && window.__canvasChanged(${jsonArg(id)});`));
    // host.onChanged reads stable core listeners; re-subscribe only when the host changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const onMessage = async (event: WebViewMessageEvent) => {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type !== "rpc") return;
    const { requestId, method, args } = msg.payload;
    const h = hostRef.current as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fn = h[method];
    const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }) => {
      if (requestId) inject(`window.__canvasResolve && window.__canvasResolve(${requestId}, ${jsonArg(result)});`);
    };
    if (typeof fn !== "function" || method === "onChanged" || method === "ingestImage") {
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
        scrollEnabled={false}
        bounces={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
      />
      {dialogs}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },
});
