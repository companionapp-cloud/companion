import { Schema, type Node } from "prosemirror-model";
import { schema as baseSchema } from "prosemirror-markdown";
import { wikilinkSpec, LINK_TYPES } from "./wikilink";

// The "simple" editor: plain-text paragraphs plus wikilink reference chips — nothing else.
// No headings, lists, task items, blockquotes, code, or marks. Used for task notes and the
// chat composer, where the full document editor is overkill. Everything a user types is
// literal text except `[[type:id]]` references (matching how those fields behaved when they
// were plain text inputs); there is deliberately no markdown parsing or escaping.
export const simpleSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    // Reuse the base paragraph/text specs so behavior matches the full editor's paragraphs.
    paragraph: baseSchema.spec.nodes.get("paragraph")!,
    text: baseSchema.spec.nodes.get("text")!,
    // The exact same atomic chip node as the full schema (see wikilink.ts).
    wikilink: wikilinkSpec,
  },
  marks: {},
});

// Scan a run of text for wikilinks. Mirrors the input rule's grammar (see INPUT_RE in
// wikilink.ts) but global, so we can split a paragraph into text + chip runs.
const SCAN =
  /(!?)\[\[\s*([a-zA-Z]+)\s*:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/g;

// Turn one paragraph's text into inline nodes: literal text interleaved with chips. A
// `[[…]]` whose type isn't a known link type is left as literal text (not a chip).
function parseInline(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN.exec(text)) !== null) {
    const [full, bang, type, id, alias] = m;
    if (!LINK_TYPES.has(type)) continue; // leave unknown types in the trailing text slice
    if (m.index > last) nodes.push(simpleSchema.text(text.slice(last, m.index)));
    nodes.push(
      simpleSchema.nodes.wikilink.create({ embed: bang === "!", type, id, alias: alias || null }),
    );
    last = m.index + full.length;
  }
  if (last < text.length) nodes.push(simpleSchema.text(text.slice(last)));
  return nodes;
}

/** Parse a plain-text-with-wikilinks string into a simpleSchema doc. Blank lines separate
 * paragraphs; a single newline stays inside its paragraph. Empty input yields one empty
 * paragraph (the schema requires at least one). */
export function parseSimple(md: string): Node {
  const blocks = md.split(/\n{2,}/);
  const paras = blocks.map((text) => simpleSchema.nodes.paragraph.create(null, parseInline(text)));
  if (paras.length === 0) paras.push(simpleSchema.nodes.paragraph.create());
  return simpleSchema.nodes.doc.create(null, paras);
}

/** Serialize a simpleSchema doc back to the plain-text-with-wikilinks string. Paragraphs
 * are joined by a blank line; text is written verbatim (no escaping); chips round-trip to
 * `[[type:id|alias]]` (matching wikilink.ts's serializer). */
export function serializeSimple(doc: Node): string {
  const paras: string[] = [];
  doc.forEach((para) => {
    let s = "";
    para.forEach((child) => {
      if (child.type.name === "wikilink") {
        const { embed, type, id, alias } = child.attrs as {
          embed: boolean;
          type: string;
          id: string;
          alias: string | null;
        };
        s += `${embed ? "!" : ""}[[${type}:${id}${alias ? `|${alias}` : ""}]]`;
      } else if (child.isText) {
        s += child.text ?? "";
      }
    });
    paras.push(s);
  });
  return paras.join("\n\n");
}
