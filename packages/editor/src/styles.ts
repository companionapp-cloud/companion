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

/* Simple variant (task notes, chat composer): an inline field, not a full page. Drop the
   tall min-height and the roomy document column; the field hugs its content. .pm-simple
   is the web wrapper; .pm-compact is the native WebView mount. */
.pm-simple .ProseMirror, .pm-compact .ProseMirror { min-height: 1.65em; }
.pm-compact { padding: 4px 0; }

/* Placeholder over an empty document: the placeholder plugin tags the empty paragraph with
   .pm-empty + data-placeholder; render it via ::before so it doesn't enter the doc. */
.ProseMirror p.pm-empty:first-child::before {
  content: attr(data-placeholder);
  color: #9a9a92;
  float: left;
  height: 0;
  pointer-events: none;
}

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

/* Document embed (![[doc:…]]): an inline-block that renders the file's contents — an image
   preview, an audio player, or a file chip with a download link (PLAN §6.9). */
.pm-doc-embed {
  display: inline-block;
  vertical-align: bottom;
  max-width: 100%;
  cursor: default;
}
.pm-doc-embed.ProseMirror-selectednode { outline: 2px solid #f76808; outline-offset: 2px; border-radius: 8px; }
.pm-doc-image {
  display: block;
  max-width: 100%;
  max-height: 420px;
  border-radius: 8px;
  border: 1px solid #e0e0dc;
}
.pm-doc-audio { display: block; max-width: 360px; }
/* File / loading / broken states share a compact chip. */
.pm-doc-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 11px;
  border-radius: 9px;
  background: #f5f5f3;
  border: 1px solid #e0e0dc;
  color: #3e3e3a;
  font-size: 0.92em;
  line-height: 1.3;
  max-width: 100%;
}
.pm-doc-fileicon { flex: 0 0 auto; font-size: 1.05em; }
.pm-doc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-doc-hint { color: #9a9a92; font-size: 0.85em; flex: 0 0 auto; }
.pm-doc-download {
  flex: 0 0 auto;
  margin-left: 2px;
  color: #b7500a;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.pm-doc-download:hover { text-decoration: underline; }
.pm-doc-broken { border-style: dashed; color: #9a9a92; }

/* Drop target highlight while a file is dragged over the editor (PLAN §6.9). */
.companion-editor.pm-drop-active {
  outline: 2px dashed #f76808;
  outline-offset: 4px;
  border-radius: 8px;
  background: rgba(247, 104, 8, 0.04);
}

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

/* Broken reference: the target no longer exists. A leading unlink icon plus a muted, struck
   label; the TYPE badge and any task status / meta are suppressed. */
.pm-wikilink-broken {
  background: #f4ecea;
  color: #9a5a4a;
  border-color: #e6d2cc;
  cursor: default;
}
.pm-wikilink-broken::before { content: none; }
.pm-wikilink-broken .pm-wikilink-status,
.pm-wikilink-broken .pm-wikilink-meta { display: none; }
.pm-wikilink-broken .pm-wikilink-label {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.pm-wikilink-brokenicon {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}
.pm-wikilink-brokenicon svg { width: 0.9em; height: 0.9em; }

/* Unresolved "empty" link: raw [[label]] text the author never resolved to a target. Styled
   as a dashed, muted pill-ish run; double-clicking it opens the quick-create UI. */
.pm-wikilink-empty {
  border-radius: 4px;
  padding: 0 2px;
  color: #9a5a4a;
  background: #faf1ee;
  text-decoration: underline dashed #d9b7ac;
  text-underline-offset: 2px;
  cursor: pointer;
}

/* Floating [[ autocomplete result list (appended to <body>, positioned at the caret). Focus
   stays in the editor — this is a read-only list navigated with the keyboard. */
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

/* GFM tables: real rows/cells with a header row. Columns/rows auto-size (no columnResizing
   plugin is installed, so cells are not resizable); the table caps at the editor width and
   cells wrap rather than overflow. Rounded outer corners via a table border + rounded corner
   cells (border-collapse: separate is required for per-corner radius). */
.ProseMirror table {
  border-collapse: separate;
  border-spacing: 0;
  table-layout: auto;
  width: auto;
  max-width: 100%;
  margin: 0 0 0.8em;
  font-size: 0.95em;
  border: 1px solid #e0e0dc;
  border-radius: 8px;
}
.ProseMirror th,
.ProseMirror td {
  /* The table border draws the outer top + left edges; cells draw only the interior grid. */
  border-right: 1px solid #e0e0dc;
  border-bottom: 1px solid #e0e0dc;
  padding: 6px 10px;
  vertical-align: top;
  text-align: left;
  min-width: 3em;
  position: relative;
  white-space: normal;
  overflow-wrap: break-word;
  word-break: break-word;
}
.ProseMirror th:last-child,
.ProseMirror td:last-child { border-right: none; }
.ProseMirror tr:last-child th,
.ProseMirror tr:last-child td { border-bottom: none; }
/* Round the four corner cells so the header's top and the last row's bottom follow the radius. */
.ProseMirror tr:first-child th:first-child,
.ProseMirror tr:first-child td:first-child { border-top-left-radius: 8px; }
.ProseMirror tr:first-child th:last-child,
.ProseMirror tr:first-child td:last-child { border-top-right-radius: 8px; }
.ProseMirror tr:last-child th:first-child,
.ProseMirror tr:last-child td:first-child { border-bottom-left-radius: 8px; }
.ProseMirror tr:last-child th:last-child,
.ProseMirror tr:last-child td:last-child { border-bottom-right-radius: 8px; }
.ProseMirror th {
  background: #f5f5f3;
  font-weight: 600;
}
/* prosemirror-tables tags the active cell(s) so menu actions have an anchor. */
.ProseMirror .selectedCell { background: rgba(247, 104, 8, 0.1); }

/* Per-cell hover affordance: a flat vertical-ellipsis button (styled like the toolbar buttons)
   at the end of the hovered cell that opens the table menu. Appended to <body> and positioned
   (fixed, viewport coords) by the tableMenu plugin from the cell's rect, so it works under any
   mount. Hovering the button keeps it up (the plugin cancels the hide) so it stays clickable. */
.pm-table-cellbtn {
  position: fixed;
  z-index: 20;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: transparent;
  border: none;
  color: #7b7b75;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  user-select: none;
}
.pm-table-cellbtn:hover { background: rgba(0, 0, 0, 0.08); color: #3e3e3a; }

/* Built-in HTML table menu (web). Desktop/iOS present a native menu instead; the model is
   identical (see tableMenu.ts). Mirrors the wikilink picker chrome. */
.pm-table-menu,
.pm-table-submenu {
  z-index: 10000;
  min-width: 200px;
  background: #ffffff;
  border: 1px solid #e6e6e2;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  padding: 5px;
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1a1a18;
}
.pm-table-menu { position: fixed; }
.pm-table-submenu {
  position: absolute;
  top: -5px;
  left: 100%;
  margin-left: 3px;
  min-width: 150px;
  display: none;
}
.pm-table-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  position: relative;
}
.pm-table-menu-item:hover { background: #f5f5f3; }
.pm-table-menu-item.has-submenu:hover > .pm-table-submenu { display: block; }
.pm-table-menu-item.is-disabled { color: #bcbcb6; cursor: default; }
.pm-table-menu-item.is-disabled:hover { background: transparent; }
.pm-table-menu-label { flex: 1; }
.pm-table-menu-arrow { color: #9a9a92; font-size: 0.78em; }
.pm-table-menu-check {
  width: 14px;
  flex: 0 0 14px;
  color: #b7500a;
  text-align: center;
}
.pm-table-menu-sep { height: 1px; background: #efefec; margin: 4px 6px; }
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
