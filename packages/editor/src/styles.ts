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

/* Task list items: a round checkbox todo ([ ] / [x]) the reader can click. */
.ProseMirror li.pm-task-item {
  list-style: none;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ProseMirror .pm-task-checkbox {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-top: 0.2em;
  border: 2px solid #a7a7a1;
  border-radius: 999px;
  box-sizing: border-box;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.ProseMirror li.pm-task-item[data-checked="true"] .pm-task-checkbox {
  background: #2e9e5b;
  border-color: #2e9e5b;
}
.ProseMirror li.pm-task-item[data-checked="true"] .pm-task-checkbox::after {
  content: "";
  display: block;
  width: 4px;
  height: 8px;
  margin: 2px auto 0;
  border: solid #ffffff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.ProseMirror .pm-task-body { flex: 1 1 auto; min-width: 0; }
.ProseMirror .pm-task-body p { margin: 0; }
.ProseMirror li.pm-task-item[data-checked="true"] .pm-task-body {
  color: #7b7b75;
  text-decoration: line-through;
}

/* Wikilink chip: an inline pill rendered for [[type:id]] / ![[type:id|alias]]. */
.pm-wikilink {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #fdece0;
  color: #b7500a;
  font-size: 0.92em;
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  cursor: default;
  border: 1px solid #f7d9c4;
}
.pm-wikilink::before {
  content: attr(data-type);
  font-size: 0.72em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.6;
}
.pm-wikilink-embed { background: #e7f0fb; color: #1f5fb0; border-color: #cfe0f5; }
.pm-wikilink.ProseMirror-selectednode { outline: 2px solid #f76808; outline-offset: 1px; }

/* Task chip: a referenced task rendered like a todo — a round status box, the title, and
   its due / reminder dates. Neutral (not accent) so it reads as a task, not a link. */
.pm-wikilink-task {
  gap: 5px;
  background: #f5f5f3;
  color: #3e3e3a;
  border-color: #e0e0dc;
  cursor: pointer;
}
.pm-wikilink-task::before { content: none; } /* no TYPE badge; the status box leads instead */
.pm-wikilink-task .pm-wikilink-status {
  align-self: center;
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
  border: 1.5px solid #a7a7a1;
  border-radius: 999px;
  box-sizing: border-box;
}
.pm-wikilink-task[data-status="done"] .pm-wikilink-status {
  background: #2e9e5b;
  border-color: #2e9e5b;
  position: relative;
}
.pm-wikilink-task[data-status="done"] .pm-wikilink-status::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 1px;
  width: 3px;
  height: 6px;
  border: solid #ffffff;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.pm-wikilink-task[data-status="done"] .pm-wikilink-label { text-decoration: line-through; color: #7b7b75; }
.pm-wikilink-task .pm-wikilink-meta { display: inline-flex; align-items: center; gap: 5px; }
.pm-wikilink-task .pm-wikilink-due,
.pm-wikilink-task .pm-wikilink-remind {
  font-size: 0.82em;
  font-weight: 500;
  color: #7b7b75;
  white-space: nowrap;
}
.pm-wikilink-task .pm-wikilink-meta:empty { display: none; }

/* Floating [[ autocomplete picker (appended to <body>, positioned at the caret). */
.pm-wikilink-menu {
  position: fixed;
  z-index: 9999;
  width: 320px;
  max-width: 90vw;
  background: #ffffff;
  border: 1px solid #e6e6e2;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14);
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
.pm-wikilink-menu-header {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid #efefec;
}
.pm-wikilink-menu-input {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid #e0e0dc;
  border-radius: 7px;
  font: inherit;
  color: #1a1a18;
  outline: none;
}
.pm-wikilink-menu-input:focus { border-color: #f7a86b; box-shadow: 0 0 0 2px #fdece0; }
.pm-wikilink-menu-typesel {
  flex-shrink: 0;
  padding: 6px 8px;
  border: 1px solid #e0e0dc;
  border-radius: 7px;
  font: inherit;
  color: #595954;
  background: #fafaf8;
  cursor: pointer;
  outline: none;
}
.pm-wikilink-menu-list { max-height: 240px; overflow-y: auto; padding: 4px; }
.pm-wikilink-menu-empty { padding: 10px 9px; color: #9a9a92; }
.pm-wikilink-menu-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 6px;
  cursor: pointer;
}
.pm-wikilink-menu-item.is-active { background: #fdece0; }
.pm-wikilink-menu-type {
  flex-shrink: 0;
  font-size: 0.68em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #b7500a;
}
.pm-wikilink-menu-title {
  flex: 1;
  min-width: 0;
  color: #1a1a18;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
