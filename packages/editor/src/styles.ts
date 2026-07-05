// Editor CSS, shared by the web component (injected into <head>) and the native
// WebView (embedded in its HTML). Colors mirror the design tokens. `.pm-wrap` is the
// centered document column used by the native WebView (full-screen); on web the note
// view supplies its own column, so only the `.ProseMirror` rules apply there.
export const EDITOR_CSS = `
.ProseMirror {
  outline: none;
  min-height: 40vh;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1a1a18;
  caret-color: #f76808;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.ProseMirror p { margin: 0 0 0.8em; }
.ProseMirror h1 { font-size: 1.6em; font-weight: 700; margin: 0.4em 0 0.3em; }
.ProseMirror h2 { font-size: 1.3em; font-weight: 700; margin: 0.4em 0 0.3em; }
.ProseMirror h3 { font-size: 1.1em; font-weight: 600; margin: 0.4em 0 0.3em; }
.ProseMirror ul, .ProseMirror ol { padding-left: 1.4em; margin: 0 0 0.8em; }
.ProseMirror blockquote {
  border-left: 3px solid #e0e0dc; margin: 0 0 0.8em; padding-left: 12px; color: #595954;
}
.ProseMirror code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #f5f5f3; border-radius: 4px; padding: 1px 4px; font-size: 0.9em;
}
.ProseMirror pre {
  background: #f5f5f3; border-radius: 8px; padding: 12px; overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em;
}
.pm-wrap { max-width: 760px; margin: 0 auto; width: 100%; padding: 40px 44px 120px; box-sizing: border-box; }
@media (max-width: 640px) { .pm-wrap { padding: 16px 20px 96px; } }
`;

// Web only: inject the editor CSS into the document head once.
let injected = false;
export function ensureEditorStyles(): void {
  if (injected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.setAttribute("data-companion-editor", "");
  el.textContent = EDITOR_CSS;
  document.head.appendChild(el);
  injected = true;
}
