// Custom Metro transformer: compiles `.md` docs into JS modules so they can be
// imported (and enumerated via require.context) like any other source file.
//
// A markdown file becomes:
//   module.exports = { slug, frontmatter, html, toc }
// where `frontmatter` is parsed from the leading `--- ... ---` block, `html` is the
// rendered body, and `toc` lists the `##` headings (each given a slugified id).
// Everything else is delegated to Expo's upstream Babel transformer unchanged.
//
// Docs can also group content into tabs (see content/docs/getting-the-apps.md):
//   :::: tabs
//   ::: tab macOS
//   …markdown…
//   :::
//   ::: tab Windows
//   …markdown…
//   :::
//   ::::

const path = require("path");
const MarkdownIt = require("markdown-it");
const upstreamTransformer = require("@expo/metro-config/babel-transformer");

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

function lineAt(state, line) {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trimEnd();
}

// `::: name info` … `:::` block containers, the markdown-it-container convention written
// out here rather than added as a dependency. A container closes on a bare fence with at
// least as many colons as opened it, which is how a `:::: tabs` group holds `::: tab` panels.
function container(name) {
  const opener = new RegExp(`^(:{3,})\\s*${name}(?:\\s+(.*))?$`);
  return (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const open = opener.exec(lineAt(state, startLine));
    if (!open) return false;
    if (silent) return true;

    let close = startLine + 1;
    for (; close < endLine; close++) {
      const fence = /^(:{3,})$/.exec(lineAt(state, close));
      if (fence && fence[1].length >= open[1].length && state.sCount[close] - state.blkIndent < 4) break;
    }

    const oldParent = state.parentType;
    const oldLineMax = state.lineMax;
    state.parentType = "container";
    // Keeps a paragraph's lazy continuation from swallowing the closing fence.
    state.lineMax = close;
    const token = state.push(`${name}_open`, "div", 1);
    token.block = true;
    token.info = (open[2] ?? "").trim();
    token.map = [startLine, close];
    state.md.block.tokenize(state, startLine + 1, close);
    state.push(`${name}_close`, "div", -1).block = true;
    state.parentType = oldParent;
    state.lineMax = oldLineMax;
    // Resume after the fence; an unclosed container runs to the end of its parent.
    state.line = Math.min(close + 1, endLine);
    return true;
  };
}

for (const name of ["tabs", "tab"]) {
  md.block.ruler.before("fence", name, container(name), { alt: ["paragraph", "reference", "blockquote", "list"] });
}

// Tabs render as a radio group because the article body is injected HTML that React never
// hydrates: each tab is a visually hidden radio, its label and its panel, and global.css
// lines the labels up as a tab bar and shows the panel after the checked radio. Radios
// also give keyboard (arrow keys) and screen reader support for free. The first tab starts
// selected; `name` is unique per group so several groups can share a page.
md.renderer.rules.tabs_open = (_tokens, _idx, _options, env) => {
  env.tabGroups = (env.tabGroups ?? 0) + 1;
  (env.tabStack ??= []).push({ name: `tabs-${env.tabGroups}`, count: 0 });
  return '<div class="tabs">\n';
};
md.renderer.rules.tabs_close = (_tokens, _idx, _options, env) => {
  env.tabStack.pop();
  return "</div>\n";
};
md.renderer.rules.tab_open = (tokens, idx, _options, env) => {
  const group = env.tabStack?.at(-1);
  if (!group) return "<div>\n"; // a stray `::: tab` outside a group is just a block
  const id = `${group.name}-${++group.count}`;
  const label = md.utils.escapeHtml(tokens[idx].info || `Tab ${group.count}`);
  const checked = group.count === 1 ? " checked" : "";
  return `<input type="radio" name="${group.name}" id="${id}"${checked}><label for="${id}">${label}</label>\n<div class="tab-panel">\n`;
};
md.renderer.rules.tab_close = () => "</div>\n";

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Minimal YAML-subset frontmatter parser (strings, numbers, booleans, inline arrays).
function parseFrontmatter(src) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!match) return { data: {}, body: src };

  const data = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (value === "true" || value === "false") {
      data[key] = value === "true";
    } else if (value !== "" && !Number.isNaN(Number(value)) && /^-?\d/.test(value)) {
      data[key] = Number(value);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: match[2] };
}

// Add ids to `##`/`###` headings and collect the `##` ones for the on-page nav.
function withHeadingIds(html) {
  const toc = [];
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_full, level, inner) => {
    const id = slugify(inner);
    if (level === "2") toc.push({ id, text: inner.replace(/<[^>]+>/g, "") });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, toc };
}

module.exports.transform = function transform({ src, filename, options }) {
  if (filename.endsWith(".md")) {
    const { data, body } = parseFrontmatter(src);
    const rendered = withHeadingIds(md.render(body));
    const slug = path.basename(filename).replace(/\.md$/, "");
    const mod = { slug, frontmatter: data, html: rendered.html, toc: rendered.toc };
    src = `module.exports = ${JSON.stringify(mod)};`;
  }
  return upstreamTransformer.transform({ src, filename, options });
};
