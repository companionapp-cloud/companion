import type { CanvasDocument, CanvasNode, Note, Task } from "@companion/core-bridge";
import { font, lightColors as c, radius } from "@companion/design-system";
import { bounds } from "../canvas/geometry";
import { edgeShapes, wash as washOrNull, type Fit } from "../chat/thumbnailGeometry";
import { reminderLabel } from "../reminders";
import { repeatLabel } from "../repeat";

// What an export looks like: a note or a task as a page of prose, a canvas as its board. Built as
// plain HTML + CSS strings — no React, no theme variables — because the same markup is saved as
// the HTML export and drawn into the PDF and PNG ones (raster.ts), where nothing of the app's own
// styling reaches. Always the light theme: an export is a sheet of paper.

/** One document laid out for export. */
export interface ExportPage {
  title: string;
  /** "flow": prose that runs down a page and paginates. "board": a fixed-size picture. */
  layout: "flow" | "board";
  /** The body markup; styled by EXPORT_CSS. */
  html: string;
  /** A board's size in CSS px. */
  width?: number;
  height?: number;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SANS = font.sans;
const MONO = font.mono;

/** The stylesheet every export carries. Prose rules mirror the editor's (packages/editor
 *  styles.ts) with the light theme's literals. */
export const EXPORT_CSS = `
.cx-root { font: 400 14px/22px ${SANS}; color: ${c.textPrimary}; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
.cx-root *, .cx-root *::before, .cx-root *::after { box-sizing: border-box; }
.cx-eyebrow { font: 500 11px/16px ${MONO}; letter-spacing: 0.04em; text-transform: uppercase; color: ${c.textTertiary}; margin: 0 0 6px; }
.cx-title { font: 600 28px/34px ${SANS}; letter-spacing: -0.025em; margin: 0 0 18px; overflow-wrap: anywhere; }
.cx-title.cx-done { color: ${c.textTertiary}; text-decoration: line-through; }
.cx-task-head { display: flex; align-items: flex-start; gap: 12px; }
.cx-check { flex: none; width: 20px; height: 20px; margin-top: 8px; border-radius: 50%; border: 1.5px solid ${c.borderStrong}; }
.cx-check.cx-on { background: ${c.accent}; border-color: ${c.accent}; position: relative; }
.cx-check.cx-on::after { content: ""; position: absolute; left: 6px; top: 2.5px; width: 5px; height: 9px; border: solid ${c.onAccent}; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.cx-check.cx-off { background: ${c.surfaceSunken}; }
.cx-meta { margin: 0 0 20px; padding: 10px 0; border-top: 1px solid ${c.borderSubtle}; border-bottom: 1px solid ${c.borderSubtle}; }
.cx-meta-row { display: flex; gap: 12px; padding: 2px 0; font-size: 13px; line-height: 20px; }
.cx-meta-key { flex: none; width: 96px; font: 400 11px/20px ${MONO}; text-transform: uppercase; letter-spacing: 0.04em; color: ${c.textTertiary}; }
.cx-meta-val { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.cx-empty { color: ${c.textTertiary}; font-style: italic; }

.cx-prose { white-space: pre-wrap; overflow-wrap: break-word; }
.cx-prose p { margin: 0 0 10px; }
.cx-prose h1, .cx-prose h2, .cx-prose h3, .cx-prose h4, .cx-prose h5, .cx-prose h6 { font-weight: 600; }
.cx-prose h1 { font-size: 24px; line-height: 28px; letter-spacing: -0.025em; margin: 20px 0 8px; }
.cx-prose h2 { font-size: 20px; line-height: 24px; letter-spacing: -0.025em; margin: 18px 0 6px; }
.cx-prose h3 { font-size: 17px; line-height: 22px; letter-spacing: -0.011em; margin: 16px 0 6px; }
.cx-prose h4 { font-size: 15px; line-height: 20px; margin: 14px 0 4px; }
.cx-prose h5, .cx-prose h6 { font-size: 14px; line-height: 20px; margin: 12px 0 4px; }
.cx-prose > :first-child { margin-top: 0; }
.cx-prose ul, .cx-prose ol { padding-left: 22px; margin: 0 0 10px; }
.cx-prose li > p { margin-bottom: 2px; }
.cx-prose a { color: ${c.textAccent}; text-decoration: underline; text-underline-offset: 2px; }
.cx-prose hr { border: none; border-top: 1px solid ${c.borderSubtle}; margin: 16px 0; }
.cx-prose blockquote { border-left: 2px solid ${c.borderDefault}; margin: 0 0 10px; padding-left: 12px; color: ${c.textSecondary}; }
.cx-prose code { font: 400 12.5px/18px ${MONO}; background: ${c.surfaceCode}; border-radius: ${radius.xs}px; padding: 1px 4px; }
.cx-prose pre { background: ${c.surfaceCode}; border-radius: ${radius.lg}px; padding: 10px 12px; margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cx-prose pre code { background: none; padding: 0; }
.cx-prose img { display: block; max-width: 100%; max-height: 720px; height: auto; border-radius: ${radius.md}px; margin: 4px 0; }
.cx-prose table { border-collapse: collapse; margin: 0 0 12px; width: 100%; font-size: 13px; line-height: 20px; }
.cx-prose th, .cx-prose td { border: 1px solid ${c.borderDefault}; padding: 4px 8px; text-align: left; vertical-align: top; }
.cx-prose th { background: ${c.surfaceSunken}; font-weight: 600; }
.cx-prose th p, .cx-prose td p { margin: 0; }
.cx-prose li.pm-task-item { list-style: none; position: relative; }
.cx-prose .pm-task-checkbox { position: absolute; left: -20px; top: 4px; width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid ${c.borderStrong}; }
.cx-prose li[data-checked="true"] > .pm-task-checkbox { background: ${c.accent}; border-color: ${c.accent}; }
.cx-prose li[data-checked="true"] > .pm-task-checkbox::after { content: ""; position: absolute; left: 3.5px; top: 1px; width: 3.5px; height: 6.5px; border: solid ${c.onAccent}; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); }
.cx-prose li[data-checked="true"] > .pm-task-body { color: ${c.textTertiary}; text-decoration: line-through; }
.cx-prose .pm-wikilink { color: ${c.textAccent}; background: ${c.accentSoft}; border-radius: ${radius.xs}px; padding: 0 3px; }
.cx-prose .pm-file { font: 400 12px/18px ${MONO}; color: ${c.textSecondary}; background: ${c.surfaceSunken}; border: 1px solid ${c.borderSubtle}; border-radius: ${radius.sm}px; padding: 1px 5px; }

.cx-board { position: relative; background: ${c.surfaceCard}; font-family: ${SANS}; overflow: hidden; }
.cx-board > * { position: absolute; }
.cx-group { border-radius: ${radius.lg}px; border: 1px solid; }
.cx-group-label { position: absolute; top: -1px; left: 8px; transform: translateY(-50%); padding: 0 4px; background: ${c.surfaceCard}; color: ${c.textTertiary}; font: 400 11px/14px ${MONO}; max-width: calc(100% - 16px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx-card { background: ${c.surfaceCard}; border: 1px solid ${c.borderDefault}; border-left-width: 2px; border-radius: ${radius.md}px; overflow: hidden; padding: 4px 7px; display: flex; flex-direction: column; gap: 2px; font-size: 13px; line-height: 18px; }
.cx-sticky { border: 1px solid; border-radius: ${radius.md}px; overflow: hidden; padding: 4px 6px; font-size: 12px; line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cx-card-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; }
.cx-card-title.cx-done { color: ${c.textTertiary}; text-decoration: line-through; }
.cx-card-kind { font: 400 10px/14px ${MONO}; color: ${c.textTertiary}; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx-card-body { font-size: 12px; line-height: 16px; color: ${c.textSecondary}; overflow: hidden; flex: 1; min-height: 0; }
.cx-card-gone { font-size: 12px; color: ${c.textTertiary}; font-style: italic; }
.cx-card-image { padding: 0; background: ${c.surfaceSunken}; align-items: center; justify-content: center; }
.cx-card-image img { width: 100%; height: 100%; object-fit: contain; display: block; }
.cx-edge-label { transform: translate(-50%, -50%); background: ${c.surfaceCard}; padding: 0 4px; font: 400 11px/16px ${SANS}; color: ${c.textSecondary}; white-space: nowrap; }
`;

const dateOnly: Intl.DateTimeFormatOptions = { weekday: "short", year: "numeric", month: "short", day: "numeric" };

/** "Fri, Sep 18, 2026", with the time when the instant carries one. */
export function formatWhen(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  return midnight ? d.toLocaleDateString(undefined, dateOnly) : d.toLocaleString(undefined, { ...dateOnly, hour: "numeric", minute: "2-digit" });
}

const STATUS_LABEL: Record<Task["status"], string> = { open: "Open", done: "Done", cancelled: "Cancelled" };

/** A task's fields as label/value pairs, in the order its editor shows them. Shared by every
 *  format so the PDF, the markdown and the text say the same things. */
export function taskFacts(task: Task, filedIn: string | null): [string, string][] {
  const facts: [string, string][] = [["Status", STATUS_LABEL[task.status] ?? task.status]];
  if (task.someday) facts.push(["Start", "Someday"]);
  else if (task.startAt) facts.push(["Start", formatWhen(task.startAt)]);
  if (task.dueAt) facts.push(["Deadline", formatWhen(task.dueAt)]);
  const repeat = repeatLabel(task.repeatRule);
  if (repeat) facts.push(["Repeats", repeat]);
  const reminders = (task.reminders ?? []).map(reminderLabel).filter(Boolean);
  if (reminders.length) facts.push([reminders.length === 1 ? "Reminder" : "Reminders", reminders.join(" · ")]);
  if (task.completedAt) facts.push([task.status === "cancelled" ? "Cancelled" : "Completed", formatWhen(task.completedAt)]);
  if (filedIn) facts.push(["Filed in", filedIn]);
  return facts;
}

export function notePage(note: Note, bodyHtml: string): ExportPage {
  const title = note.title || "Untitled";
  const html =
    `<div class="cx-eyebrow">Note · Updated ${esc(formatWhen(note.updatedAt))}</div>` +
    `<h1 class="cx-title">${esc(title)}</h1>` +
    `<div class="cx-prose">${bodyHtml}</div>`;
  return { title, layout: "flow", html };
}

export function taskPage(task: Task, filedIn: string | null, notesHtml: string): ExportPage {
  const title = task.title || "Untitled task";
  const check = task.status === "done" ? "cx-check cx-on" : task.status === "cancelled" ? "cx-check cx-off" : "cx-check";
  const rows = taskFacts(task, filedIn)
    .map(([k, v]) => `<div class="cx-meta-row"><div class="cx-meta-key">${esc(k)}</div><div class="cx-meta-val">${esc(v)}</div></div>`)
    .join("");
  const html =
    `<div class="cx-eyebrow">Task</div>` +
    `<div class="cx-task-head"><div class="${check}"></div><h1 class="cx-title${task.status === "open" ? "" : " cx-done"}">${esc(title)}</h1></div>` +
    `<div class="cx-meta">${rows}</div>` +
    (task.notesMd.trim() ? `<div class="cx-prose">${notesHtml}</div>` : "");
  return { title, layout: "flow", html };
}

// ---- Boards ---------------------------------------------------------------------------

/** Clear space around a board's content. */
const BOARD_PAD = 48;
// The board's own colors (CanvasView.web.tsx): each embedded kind's accent stripe, and the
// default swatches of stickies and groups.
const KIND_COLOR: Record<string, string> = { note: c.success, task: c.info, event: c.textPrimary, image: c.textTertiary, link: c.textTertiary };
const STICKY = "#eab308";
const GROUP = "#64748b";

const wash = (hex: string, alpha: number) => washOrNull(hex, alpha) ?? "transparent";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const box = (n: CanvasNode, f: Fit) => `left:${n.x + f.dx}px;top:${n.y + f.dy}px;width:${n.width}px;height:${n.height}px;`;

function hostOf(url: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url);
  return m ? m[1] : url;
}

function eventWhen(startsAt: string, allDay: boolean): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return "";
  const date = start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return allDay ? `${date} · all day` : `${date} · ${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function cardHtml(node: CanvasNode, doc: CanvasDocument, f: Fit, images: Map<string, string>): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const ref = node.refId ?? "";
  const at = box(node, f);
  if (node.kind === "text") {
    const color = node.color ?? STICKY;
    // The swatch washed over the card surface, so a sticky reads the same over a group.
    return `<div class="cx-sticky" style="${at}border-color:${color};background:linear-gradient(${wash(color, 0.18)},${wash(color, 0.18)}),${c.surfaceCard};">${esc(str(data.text))}</div>`;
  }
  const stripe = `border-left-color:${node.color ?? KIND_COLOR[node.kind] ?? c.textTertiary};`;
  const card = (inner: string, cls = "") => `<div class="cx-card${cls}" style="${at}${stripe}">${inner}</div>`;
  const gone = (what: string) => card(`<div class="cx-card-gone">This ${what} is gone.</div>`);
  const title = (text: string, done = false) => `<div class="cx-card-title${done ? " cx-done" : ""}">${esc(text)}</div>`;
  const kind = (text: string) => `<div class="cx-card-kind">${esc(text)}</div>`;
  switch (node.kind) {
    case "note": {
      const n = doc.refs.notes[ref];
      if (!n || n.missing) return gone("note");
      return card(title(n.title || "Untitled") + kind("note") + `<div class="cx-card-body">${esc(n.excerpt || "")}</div>`);
    }
    case "task": {
      const t = doc.refs.tasks[ref];
      if (!t || t.missing) return gone("task");
      const due = t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }).toLowerCase()}` : "";
      return card(title(t.title || "Untitled task", t.status === "done") + kind(`task · ${STATUS_LABEL[t.status]?.toLowerCase() ?? t.status}${due}`));
    }
    case "event": {
      const e = doc.refs.events[ref];
      const live = e && !e.missing ? e : null;
      const startsAt = live?.startsAt ?? str(data.startsAt);
      const when = startsAt ? ` · ${eventWhen(startsAt, live?.allDay ?? data.allDay === true).toLowerCase()}` : "";
      return card(title(live?.title ?? (str(data.title) || "Event")) + kind(`event${when}`) + (live?.location ? `<div class="cx-card-body">${esc(live.location)}</div>` : ""));
    }
    case "image": {
      const d = doc.refs.documents[ref];
      if (!d || d.missing) return gone("image");
      const src = images.get(ref);
      return src ? card(`<img src="${esc(src)}" alt="${esc(d.filename)}"/>`, " cx-card-image") : card(kind(d.filename));
    }
    case "link": {
      const url = str(data.url);
      return card(title(str(data.title) || hostOf(url) || "Link") + kind(str(data.siteName) || hostOf(url)) + (str(data.description) ? `<div class="cx-card-body">${esc(str(data.description))}</div>` : ""));
    }
    default:
      return "";
  }
}

/** A board as the app draws it — groups behind arrows behind cards — at its own scale, cropped to
 *  its content. `images` maps an image node's document id to a data: URL. */
export function canvasPage(doc: CanvasDocument, images: Map<string, string>): ExportPage {
  const title = doc.canvas.name || "Untitled canvas";
  const b = bounds(doc.nodes) ?? { x: 0, y: 0, width: 480, height: 240 };
  const width = Math.ceil(b.width + BOARD_PAD * 2);
  const height = Math.ceil(b.height + BOARD_PAD * 2);
  const fit: Fit = { scale: 1, dx: BOARD_PAD - b.x, dy: BOARD_PAD - b.y, width, height };
  const byZ = (a: CanvasNode, z: CanvasNode) => a.z - z.z;

  const groups = doc.nodes
    .filter((n) => n.kind === "group")
    .sort(byZ)
    .map((g) => {
      const color = g.color ?? GROUP;
      const label = str(g.data?.label);
      return `<div class="cx-group" style="${box(g, fit)}border-color:${wash(color, 0.45)};background:${wash(color, 0.07)};">${label ? `<div class="cx-group-label">${esc(label)}</div>` : ""}</div>`;
    })
    .join("");

  const shapes = edgeShapes(doc.nodes, doc.edges, fit);
  const paths = shapes
    .map((s) => {
      const stroke = s.color ?? c.textTertiary;
      const marks = s.marks
        .map((m) => {
          if (m.kind === "chevron") return `<path d="${m.d}" fill="none" stroke="${stroke}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>`;
          if (m.kind === "triangle") return `<path d="${m.d}" fill="${stroke}" stroke="${stroke}" stroke-width="1" stroke-linejoin="round"/>`;
          return `<circle cx="${m.cx}" cy="${m.cy}" r="${m.r}" fill="${m.kind === "dotFilled" ? stroke : c.surfaceCard}" stroke="${stroke}" stroke-width="1.25"/>`;
        })
        .join("");
      return `<path d="${s.d}" fill="none" stroke="${stroke}" stroke-width="1.25"/>${marks}`;
    })
    .join("");
  const edges = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="left:0;top:0;">${paths}</svg>`;
  const labels = shapes
    .filter((s) => s.label)
    .map((s) => `<div class="cx-edge-label" style="left:${s.mid.x}px;top:${s.mid.y}px;">${esc(s.label)}</div>`)
    .join("");

  const cards = doc.nodes
    .filter((n) => n.kind !== "group")
    .sort(byZ)
    .map((n) => cardHtml(n, doc, fit, images))
    .join("");

  const empty = doc.nodes.length ? "" : `<div class="cx-empty" style="left:${BOARD_PAD}px;top:${BOARD_PAD}px;">This canvas is empty.</div>`;
  return { title, layout: "board", width, height, html: `<div class="cx-board" style="width:${width}px;height:${height}px;">${groups}${edges}${labels}${cards}${empty}</div>` };
}

/** A standalone HTML document around a flow page — the HTML export. Unbranded: it's the user's
 *  own document, like the markdown and text forms. */
export function standaloneHtml(page: ExportPage): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="generator" content="Companion">\n<title>${esc(page.title)}</title>\n` +
    `<style>\nbody { margin: 0; background: ${c.surfaceCard}; }\n.cx-root { max-width: 720px; margin: 0 auto; padding: 48px 24px 72px; }\n${EXPORT_CSS}</style>\n` +
    `</head>\n<body>\n<main class="cx-root">${page.html}</main>\n</body>\n</html>\n`
  );
}
