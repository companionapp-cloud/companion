// Custom Metro transformer: compiles `.md` docs into JS modules so they can be
// imported (and enumerated via require.context) like any other source file.
//
// A markdown file becomes:
//   module.exports = { slug, frontmatter, html, toc }
// where `frontmatter` is parsed from the leading `--- ... ---` block, `html` is the
// rendered body, and `toc` lists the `##` headings (each given a slugified id).
// Everything else is delegated to Expo's upstream Babel transformer unchanged.

const path = require("path");
const MarkdownIt = require("markdown-it");
const upstreamTransformer = require("@expo/metro-config/babel-transformer");

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

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
