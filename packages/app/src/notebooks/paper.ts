// Notebook paper (PLAN-notebooks.md §3): the page's fixed geometry and its ruling. A page is
// laid out at one logical size on every device and zoomed to fit, so ink drawn on a phone
// lands in the same place on a desktop. Pure data and strings: nothing here touches the DOM,
// so the core's exporter or a native renderer could follow the same numbers.

export type PaperKind = "blank" | "lined" | "grid" | "dots";

/** Ruling pitch in page px (6.3, 7.4 and 8.5 mm on A5; stationery is 6 to 8 mm). Text on the
 *  page takes the same line height, so typed lines sit on the rules. */
export type PaperSpacing = 24 | 28 | 32;
export const PAPER_SPACINGS: readonly PaperSpacing[] = [24, 28, 32];
export const SPACING_LABEL: Record<PaperSpacing, string> = { 24: "Narrow", 28: "Medium", 32: "Wide" };

export interface PaperStyle {
  kind: PaperKind;
  spacing: PaperSpacing;
}

export const DEFAULT_PAPER: PaperStyle = { kind: "lined", spacing: 28 };

export const PAPER_KINDS: { kind: PaperKind; label: string }[] = [
  { kind: "blank", label: "Blank" },
  { kind: "lined", label: "Lined" },
  { kind: "grid", label: "Grid" },
  { kind: "dots", label: "Dots" },
];

/** The page in logical px: A5 (148 x 210 mm) at 96 dpi, so 100% zoom is life size on screen
 *  and a PDF export maps 1:1. Margins are 10.6 mm sides, 12.7 mm head and foot. A page never
 *  shrinks below this; it grows by whole rules when its text runs past the bottom margin. */
export const PAGE = {
  width: 559,
  height: 794,
  marginX: 40,
  marginTop: 48,
  marginBottom: 48,
} as const;

export const PAGE_GAP = 24;

/** Body type per spacing: the font grows a little with the rule pitch so wide-ruled pages
 *  don't look like small print on big lines. */
export const PAPER_FONT_PX: Record<PaperSpacing, number> = { 24: 14, 28: 15, 32: 16 };

/** How far above the bottom of a text line box its rule is drawn: the rule sits just under
 *  the baseline, where a pen would rest, rather than at the box's edge. */
const RULE_LIFT: Record<PaperSpacing, number> = { 24: 4, 28: 5, 32: 6 };

/** CSS background for a sheet. `rule`, `dot` and `sheet` are colours (CSS vars on web). The
 *  pattern is phased to the top margin so the first text line sits on the first rule, and the
 *  head and foot margins are masked with the sheet colour, the way printed paper leaves them
 *  clear. */
export function paperBackground(paper: PaperStyle, rule: string, dot: string, sheet: string, scale = 1): Record<string, string> {
  const s = paper.spacing;
  // Rules are a device hairline, not a page measure: zoomed out, a 1px rule would round away.
  const t = Math.min(3, Math.max(1, 1 / scale));
  const y = PAGE.marginTop - RULE_LIFT[s];
  if (paper.kind === "blank") return {};
  const mask = `linear-gradient(${sheet}, ${sheet})`;
  const masks = {
    image: `${mask}, ${mask}`,
    size: `100% ${y}px, 100% ${PAGE.marginBottom - s + RULE_LIFT[s] - 1}px`,
    position: `0 0, 0 100%`,
    repeat: `no-repeat, no-repeat`,
  };
  const layer = (image: string, size: string, position: string) => ({
    backgroundImage: `${masks.image}, ${image}`,
    backgroundSize: `${masks.size}, ${size}`,
    backgroundPosition: `${masks.position}, ${position}`,
    backgroundRepeat: `${masks.repeat}, repeat`,
  });
  switch (paper.kind) {
    case "lined":
      return layer(`linear-gradient(to bottom, transparent ${s - t}px, ${rule} ${s - t}px)`, `100% ${s}px`, `0 ${y}px`);
    case "grid":
      // Columns are phased to the left margin so text starts on a grid line.
      return {
        backgroundImage: `${masks.image}, linear-gradient(to bottom, transparent ${s - t}px, ${rule} ${s - t}px), linear-gradient(to right, transparent ${s - t}px, ${rule} ${s - t}px)`,
        backgroundSize: `${masks.size}, ${s}px ${s}px, ${s}px ${s}px`,
        backgroundPosition: `${masks.position}, ${PAGE.marginX % s}px ${y}px, ${PAGE.marginX % s}px ${y}px`,
        backgroundRepeat: `${masks.repeat}, repeat, repeat`,
      };
    case "dots":
      return layer(
        `radial-gradient(circle at ${s - 1}px ${s - 1}px, ${dot} ${1.1 * t}px, transparent ${1.6 * t}px)`,
        `${s}px ${s}px`,
        `${(PAGE.marginX % s) + 1}px ${y + 1}px`,
      );
  }
}

/** Typography overrides that put the editor's blocks on the page's baseline grid. Scoped to
 *  `.nb-sheet[data-spacing="…"]`. Headings take one rule (two when the type is taller than
 *  the pitch); paragraphs lose their bottom margin, and a blank rule separates blocks only
 *  where the writer leaves one. */
export function paperTypographyCss(): string {
  return PAPER_SPACINGS.map((s) => {
    const sel = `.nb-sheet[data-spacing="${s}"] .ProseMirror`;
    const f = PAPER_FONT_PX[s];
    const h1 = 24 <= s - 4 ? s : s * 2;
    // Larger type sits lower in its line box; lift it so every baseline rests the same
    // distance above its rule as body text does.
    const lift = (size: number) => `position: relative; top: -${Math.round((size - f) * 0.35)}px;`;
    return `
${sel} { font-size: ${f}px; line-height: ${s}px; min-height: var(--nb-text-min, 0px); }
${sel} p, ${sel} ul, ${sel} ol, ${sel} blockquote { margin-top: 0; margin-bottom: 0; }
${sel} li > p { margin: 0; }
${sel} h1 { font-size: 24px; line-height: ${h1}px; margin: ${s}px 0 0; ${lift(24)} }
${sel} h2 { font-size: 20px; line-height: ${s}px; margin: ${s}px 0 0; ${lift(20)} }
${sel} h3, ${sel} h4, ${sel} h5, ${sel} h6 { font-size: ${f + 2}px; line-height: ${s}px; margin: ${s}px 0 0; ${lift(f + 2)} }
${sel} > :first-child { margin-top: 0; }
${sel} pre { margin: 0; padding: ${s / 2}px 10px; line-height: ${s}px; box-sizing: border-box; }
${sel} pre code { line-height: ${s}px; }
${sel} hr { margin: ${s / 2 - 1}px 0 ${s / 2}px; }
`;
  }).join("\n");
}

/** Round a content height up to a whole number of rules, never below the base page. */
export function sheetHeightFor(contentHeight: number, spacing: PaperSpacing): number {
  const needed = PAGE.marginTop + contentHeight + PAGE.marginBottom;
  if (needed <= PAGE.height) return PAGE.height;
  const extra = needed - PAGE.height;
  return PAGE.height + Math.ceil(extra / spacing) * spacing;
}

/** Notebook covers: a solid colour by default, or an uploaded image. The colours are fixed
 *  literals, not theme roles: a cover is an object the writer chose, and it should look the
 *  same in light and dark. */
export const COVER_COLORS: { id: string; label: string; hex: string }[] = [
  { id: "ink", label: "Ink", hex: "#26262a" },
  { id: "oxblood", label: "Oxblood", hex: "#7c2d2a" },
  { id: "orange", label: "Orange", hex: "#d9600f" },
  { id: "mustard", label: "Mustard", hex: "#c5952a" },
  { id: "forest", label: "Forest", hex: "#2f5d46" },
  { id: "teal", label: "Teal", hex: "#1f6f78" },
  { id: "navy", label: "Navy", hex: "#23395d" },
  { id: "plum", label: "Plum", hex: "#5b3a6e" },
  { id: "kraft", label: "Kraft", hex: "#b08d63" },
  { id: "stone", label: "Stone", hex: "#8b8b85" },
];

export function coverHex(id: string): string {
  return COVER_COLORS.find((c) => c.id === id)?.hex ?? COVER_COLORS[0].hex;
}
