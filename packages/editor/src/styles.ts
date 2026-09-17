import { font, lightColors, type SemanticColors } from "@companion/design-system";

// Editor CSS, shared by the web component (injected into <head>) and the native
// WebView (embedded in its HTML). Every colour is a design-system role: on web/desktop the
// `--c-*` custom properties the design system defines resolve it (so `data-theme="dark"`
// re-points the editor with the rest of the app); the native WebView has no such
// properties, so each `var()` carries the light literal as its fallback. `.pm-wrap` is the
// centered document column used by the native WebView (full-screen); on web the note
// view supplies its own column, so only the `.ProseMirror` rules apply there.

/** `var(--c-text-primary, #1a1a18)` for a semantic role — themed on web, light in a WebView. */
const c = (role: keyof SemanticColors) =>
  `var(--c-${role.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}, ${lightColors[role]})`;

// Glyphs are drawn as CSS masks so they take a role colour and need no DOM from the node
// views. Path strings are copied verbatim from design-system's iconPaths.ts (24×24, 1.5 stroke).
const ICON_LINK = "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5";
const ICON_FILE = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6";
const ICON_BELL = "M10.3 21a1.9 1.9 0 0 0 3.4 0M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9Z";
const mask = (d: string) => {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' ` +
    `stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='${d}'/></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return `-webkit-mask: ${url} center / contain no-repeat; mask: ${url} center / contain no-repeat;`;
};

const MONO = font.mono;
const SANS = font.sans;
// Menus and popovers float above the document: the design system's shadow.md.
const SHADOW_MD = "0 4px 12px rgba(17, 17, 16, 0.1)";

export const EDITOR_CSS = `
.ProseMirror {
  outline: none;
  min-height: 40vh;
  font: 400 14px/22px ${SANS};
  color: ${c("textPrimary")};
  caret-color: ${c("accent")};
  white-space: pre-wrap;
  word-wrap: break-word;
}
.ProseMirror ::selection { background: ${c("focusRing")}; }
.ProseMirror p { margin: 0 0 10px; }
.ProseMirror h1, .ProseMirror h2, .ProseMirror h3,
.ProseMirror h4, .ProseMirror h5, .ProseMirror h6 { font-weight: 600; color: ${c("textPrimary")}; }
.ProseMirror h1 { font-size: 24px; line-height: 28px; letter-spacing: -0.025em; margin: 20px 0 8px; }
.ProseMirror h2 { font-size: 20px; line-height: 24px; letter-spacing: -0.025em; margin: 18px 0 6px; }
.ProseMirror h3 { font-size: 17px; line-height: 22px; letter-spacing: -0.011em; margin: 16px 0 6px; }
.ProseMirror h4 { font-size: 15px; line-height: 20px; letter-spacing: -0.011em; margin: 14px 0 4px; }
.ProseMirror h5, .ProseMirror h6 { font-size: 14px; line-height: 20px; margin: 12px 0 4px; }
.ProseMirror > :first-child { margin-top: 0; }
.ProseMirror ul, .ProseMirror ol { padding-left: 20px; margin: 0 0 10px; }
.ProseMirror li > p { margin-bottom: 2px; }
.ProseMirror a { color: ${c("textAccent")}; text-decoration: underline; text-underline-offset: 2px; }
.ProseMirror hr { border: none; border-top: 1px solid ${c("borderSubtle")}; margin: 16px 0; }
.ProseMirror blockquote {
  border-left: 1px solid ${c("borderDefault")}; margin: 0 0 10px; padding-left: 12px; color: ${c("textSecondary")};
}
.ProseMirror code {
  font-family: ${MONO}; font-size: 12px;
  background: ${c("surfaceCode")}; border: 1px solid ${c("borderSubtle")}; border-radius: 3px; padding: 0 3px;
  color: ${c("textSecondary")};
}
.ProseMirror pre {
  margin: 0 0 12px; padding: 8px 10px; overflow-x: auto;
  background: ${c("surfaceCode")}; border: 1px solid ${c("borderSubtle")}; border-radius: 4px;
  font: 400 12px/18px ${MONO}; color: ${c("textSecondary")};
}
.ProseMirror pre code { background: none; border: none; border-radius: 0; padding: 0; font: inherit; color: inherit; }
.pm-wrap { max-width: 720px; margin: 0 auto; width: 100%; padding: 20px 28px 120px; box-sizing: border-box; }
@media (max-width: 640px) { .pm-wrap { padding: 16px 20px 96px; } }

/* Simple variant (task notes, chat composer): an inline field, not a full page. Drop the
   tall min-height and the roomy document column; the field hugs its content. .pm-simple
   is the web wrapper; .pm-compact is the native WebView mount. */
.pm-simple .ProseMirror, .pm-compact .ProseMirror { min-height: 22px; }
.pm-simple .ProseMirror > :last-child, .pm-compact .ProseMirror > :last-child { margin-bottom: 0; }
.pm-compact { padding: 4px 0; }

/* Placeholder over an empty document: the placeholder plugin tags the empty paragraph with
   .pm-empty + data-placeholder; render it via ::before so it doesn't enter the doc. */
.ProseMirror p.pm-empty:first-child::before {
  content: attr(data-placeholder);
  color: ${c("textQuaternary")};
  float: left;
  height: 0;
  pointer-events: none;
}

/* Task list items: a square checkbox todo ([ ] / [x]) the reader can click — the same
   1px border-strong / accent-fill box as the app's task rows. */
.ProseMirror li.pm-task-item {
  list-style: none;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ProseMirror .pm-task-checkbox {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin-top: 4px;
  border: 1px solid ${c("borderStrong")};
  border-radius: 2px;
  box-sizing: border-box;
  cursor: pointer;
  transition: background 0.08s cubic-bezier(0.2, 0, 0.2, 1), border-color 0.08s cubic-bezier(0.2, 0, 0.2, 1);
}
.ProseMirror li.pm-task-item[data-checked="true"] .pm-task-checkbox {
  background: ${c("accent")};
  border-color: ${c("accent")};
}
.ProseMirror li.pm-task-item[data-checked="true"] .pm-task-checkbox::after {
  content: "";
  display: block;
  width: 3px;
  height: 7px;
  margin: 1px auto 0;
  border: solid ${c("onAccent")};
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.ProseMirror .pm-task-body { flex: 1 1 auto; min-width: 0; }
.ProseMirror .pm-task-body p { margin: 0; }
.ProseMirror li.pm-task-item[data-checked="true"] .pm-task-body {
  color: ${c("textQuaternary")};
  text-decoration: line-through;
}

/* Wikilink chip: a 20px mono chip rendered for [[type:id]] / ![[type:id|alias]], led by a
   quiet link glyph. Machine-owned, so it reads as metadata rather than prose. */
.pm-wikilink {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  box-sizing: border-box;
  padding: 0 6px;
  vertical-align: middle;
  border-radius: 3px;
  background: ${c("surfaceSunken")};
  color: ${c("textSecondary")};
  font: 400 11px/18px ${MONO};
  letter-spacing: 0;
  white-space: nowrap;
  cursor: default;
  border: 1px solid ${c("borderSubtle")};
}
.pm-wikilink::before {
  content: "";
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  background-color: ${c("textQuaternary")};
  ${mask(ICON_LINK)}
}
/* An embed (![[…]]) is the same chip; only its glyph changes tone. */
.pm-wikilink-embed::before { background-color: ${c("info")}; }
.pm-wikilink.ProseMirror-selectednode { outline: 2px solid ${c("focusRing")}; border-color: ${c("borderFocus")}; }

/* Document embed (![[doc:…]]): an inline-block that renders the file's contents — an image
   preview, an audio player, or a file chip with a download link (PLAN §6.9). */
.pm-doc-embed {
  display: inline-block;
  vertical-align: bottom;
  max-width: 100%;
  cursor: default;
}
.pm-doc-embed.ProseMirror-selectednode { outline: 2px solid ${c("focusRing")}; outline-offset: 1px; border-radius: 6px; }
.pm-doc-image {
  display: block;
  max-width: 100%;
  max-height: 420px;
  border-radius: 6px;
  border: 1px solid ${c("borderSubtle")};
}
.pm-doc-audio { display: block; max-width: 360px; }
/* File / loading / broken states share a compact chip. */
.pm-doc-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  box-sizing: border-box;
  padding: 0 6px;
  border-radius: 3px;
  background: ${c("surfaceSunken")};
  border: 1px solid ${c("borderSubtle")};
  color: ${c("textSecondary")};
  font: 400 12px/16px ${SANS};
  max-width: 100%;
}
/* The file glyph is a mask, so any text the node view put here stays invisible. */
.pm-doc-fileicon {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  font-size: 0;
  background-color: ${c("textQuaternary")};
  ${mask(ICON_FILE)}
}
.pm-doc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-doc-hint { color: ${c("textQuaternary")}; font: 400 11px/16px ${MONO}; flex: 0 0 auto; }
.pm-doc-download {
  flex: 0 0 auto;
  margin-left: 2px;
  color: ${c("textAccent")};
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
}
.pm-doc-download:hover { text-decoration: underline; }
.pm-doc-broken { border-style: dashed; color: ${c("textQuaternary")}; }

/* Drop target highlight while a file is dragged over the editor (PLAN §6.9). */
.companion-editor.pm-drop-active {
  outline: 1px dashed ${c("borderFocus")};
  outline-offset: 4px;
  border-radius: 6px;
  background: ${c("accentSoft")};
}

/* Task chip: a referenced task rendered like a todo — a square status box, the title, and
   its due / reminder dates. The status box leads, so the link glyph is dropped. */
.pm-wikilink-task { gap: 5px; cursor: pointer; }
.pm-wikilink-task::before { content: none; }
.pm-wikilink-task .pm-wikilink-status {
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border: 1px solid ${c("borderStrong")};
  border-radius: 2px;
  box-sizing: border-box;
}
.pm-wikilink-task[data-status="done"] .pm-wikilink-status {
  background: ${c("accent")};
  border-color: ${c("accent")};
  position: relative;
}
.pm-wikilink-task[data-status="done"] .pm-wikilink-status::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 0.5px;
  width: 2.5px;
  height: 5.5px;
  border: solid ${c("onAccent")};
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
.pm-wikilink-task[data-status="done"] .pm-wikilink-label { text-decoration: line-through; color: ${c("textQuaternary")}; }
.pm-wikilink-task .pm-wikilink-meta { display: inline-flex; align-items: center; gap: 5px; }
.pm-wikilink-task .pm-wikilink-due,
.pm-wikilink-task .pm-wikilink-remind {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: ${c("textQuaternary")};
  white-space: nowrap;
}
.pm-wikilink-task .pm-wikilink-remind::before {
  content: "";
  width: 10px;
  height: 10px;
  background-color: ${c("textQuaternary")};
  ${mask(ICON_BELL)}
}
.pm-wikilink-task .pm-wikilink-meta:empty { display: none; }

/* Broken reference: the target no longer exists. A leading unlink icon plus a struck
   label in the danger tone; the link glyph and any task status / meta are suppressed. */
.pm-wikilink-broken {
  background: ${c("dangerSoft")};
  color: ${c("danger")};
  border-color: transparent;
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
.pm-wikilink-brokenicon svg { width: 11px; height: 11px; stroke-width: 1.5; }

/* Unresolved "empty" link: raw [[label]] text the author never resolved to a target. A
   dashed, quiet run; double-clicking it opens the quick-create UI. */
.pm-wikilink-empty {
  border-radius: 2px;
  padding: 0 2px;
  color: ${c("textTertiary")};
  background: ${c("surfaceSunken")};
  text-decoration: underline dashed ${c("borderStrong")};
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
  background: ${c("surfaceOverlay")};
  border: 1px solid ${c("borderSubtle")};
  border-radius: 6px;
  box-shadow: ${SHADOW_MD};
  font: 400 13px/18px ${SANS};
  color: ${c("textPrimary")};
  overflow: hidden;
}
.pm-wikilink-menu-list { max-height: 240px; overflow-y: auto; padding: 4px; }
.pm-wikilink-menu-empty { padding: 6px; color: ${c("textTertiary")}; font-size: 12px; }
.pm-wikilink-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 6px;
  border-radius: 3px;
  cursor: pointer;
}
.pm-wikilink-menu-item:hover { background: ${c("surfaceHover")}; }
.pm-wikilink-menu-item.is-active { background: ${c("surfaceSelected")}; }
.pm-wikilink-menu-type {
  flex-shrink: 0;
  min-width: 44px;
  font: 600 10px/1 ${MONO};
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: ${c("textQuaternary")};
}
.pm-wikilink-menu-title {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  color: ${c("textPrimary")};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm-wikilink-menu-item.is-active .pm-wikilink-menu-title { color: ${c("textAccent")}; }

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
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 18px;
  border: 1px solid ${c("borderSubtle")};
  border-radius: 6px;
}
.ProseMirror th,
.ProseMirror td {
  /* The table border draws the outer top + left edges; cells draw only the interior grid. */
  border-right: 1px solid ${c("borderSubtle")};
  border-bottom: 1px solid ${c("borderSubtle")};
  padding: 4px 8px;
  vertical-align: top;
  text-align: left;
  min-width: 3em;
  position: relative;
  white-space: normal;
  overflow-wrap: break-word;
  word-break: break-word;
}
.ProseMirror th p, .ProseMirror td p { margin: 0; }
.ProseMirror th:last-child,
.ProseMirror td:last-child { border-right: none; }
.ProseMirror tr:last-child th,
.ProseMirror tr:last-child td { border-bottom: none; }
/* Round the four corner cells so the header's top and the last row's bottom follow the radius. */
.ProseMirror tr:first-child th:first-child,
.ProseMirror tr:first-child td:first-child { border-top-left-radius: 5px; }
.ProseMirror tr:first-child th:last-child,
.ProseMirror tr:first-child td:last-child { border-top-right-radius: 5px; }
.ProseMirror tr:last-child th:first-child,
.ProseMirror tr:last-child td:first-child { border-bottom-left-radius: 5px; }
.ProseMirror tr:last-child th:last-child,
.ProseMirror tr:last-child td:last-child { border-bottom-right-radius: 5px; }
.ProseMirror th {
  background: ${c("surfaceSunken")};
  font-weight: 600;
}
/* prosemirror-tables tags the active cell(s) so menu actions have an anchor. */
.ProseMirror .selectedCell { background: ${c("surfaceSelected")}; }

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
  border-radius: 3px;
  background: transparent;
  border: none;
  color: ${c("textQuaternary")};
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  user-select: none;
}
.pm-table-cellbtn:hover { background: ${c("surfaceHover")}; color: ${c("textSecondary")}; }
.pm-table-cellbtn:active { background: ${c("surfaceActive")}; }

/* Built-in HTML table menu (web). Desktop/iOS present a native menu instead; the model is
   identical (see tableMenu.ts). Mirrors the wikilink picker chrome. */
.pm-table-menu,
.pm-table-submenu {
  z-index: 10000;
  min-width: 200px;
  background: ${c("surfaceOverlay")};
  border: 1px solid ${c("borderSubtle")};
  border-radius: 6px;
  box-shadow: ${SHADOW_MD};
  padding: 4px;
  font: 400 13px/18px ${SANS};
  color: ${c("textPrimary")};
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
  gap: 6px;
  min-height: 24px;
  padding: 0 6px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  position: relative;
}
.pm-table-menu-item:hover { background: ${c("surfaceHover")}; }
.pm-table-menu-item.has-submenu:hover > .pm-table-submenu { display: block; }
.pm-table-menu-item.is-disabled { color: ${c("textDisabled")}; cursor: default; }
.pm-table-menu-item.is-disabled:hover { background: transparent; }
.pm-table-menu-label { flex: 1; }
.pm-table-menu-arrow { color: ${c("textQuaternary")}; font-size: 10px; }
.pm-table-menu-check {
  width: 12px;
  flex: 0 0 12px;
  color: ${c("textAccent")};
  font-size: 11px;
  text-align: center;
}
.pm-table-menu-sep { height: 1px; background: ${c("borderSubtle")}; margin: 4px 0; }
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
