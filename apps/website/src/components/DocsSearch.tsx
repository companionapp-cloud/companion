import { useState, type ReactNode } from "react";
import { usePostHog } from "posthog-js/react";
import { getSearchIndex } from "../content/docs";

// Live docs search on the support page. The index is derived from the markdown
// frontmatter (title + excerpt) so it stays in sync with the content automatically.

const ARTICLES = getSearchIndex();

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const idx = lower.indexOf(query, i);
    if (idx === -1) {
      nodes.push(text.slice(i));
      break;
    }
    if (idx > i) nodes.push(text.slice(i, idx));
    nodes.push(
      <span key={k++} className="hl">
        {text.slice(idx, idx + query.length)}
      </span>,
    );
    i = idx + query.length;
  }
  return nodes;
}

export function DocsSearch() {
  const posthog = usePostHog();
  const [raw, setRaw] = useState("");
  const q = raw.trim();
  const ql = q.toLowerCase();
  const matches = q ? ARTICLES.filter((a) => `${a.title} ${a.excerpt}`.toLowerCase().includes(ql)).slice(0, 8) : [];

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 520, marginTop: 32 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          height: 52,
          padding: "0 20px",
          background: "#ffffff",
          border: "1px solid #e0e0dc",
          borderRadius: 999,
          boxShadow: "0 4px 14px rgba(17,17,16,0.06)",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7" stroke="#a7a7a1" strokeWidth="2" />
          <path d="m20 20-3-3" stroke="#a7a7a1" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          placeholder="Search the docs…"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          autoComplete="off"
          style={{
            border: "none",
            outline: "none",
            flex: 1,
            fontFamily: "'Geist', sans-serif",
            fontSize: 16,
            color: "#1a1a18",
            background: "transparent",
          }}
        />
      </div>

      {q.length > 0 ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            right: 0,
            zIndex: 20,
            background: "#ffffff",
            border: "1px solid #e0e0dc",
            borderRadius: 16,
            boxShadow: "0 18px 40px rgba(17,17,16,0.16), 0 3px 10px rgba(17,17,16,0.06)",
            padding: 6,
            textAlign: "left",
            maxHeight: 400,
            overflowY: "auto",
          }}
        >
          {matches.length === 0 ? (
            <div style={{ padding: "16px 16px", fontFamily: "'Geist', sans-serif", fontSize: 15, color: "#7b7b75" }}>
              No results for <span style={{ color: "#1a1a18", fontWeight: 600 }}>“{q}”</span>
            </div>
          ) : (
            <>
              <div
                style={{
                  fontFamily: "'Geist', sans-serif",
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#a7a7a1",
                  padding: "10px 14px 6px",
                }}
              >
                {matches.length} {matches.length === 1 ? "result" : "results"}
              </div>
              {matches.map((a) => (
                <a
                  key={a.slug}
                  href={`/docs/${a.slug}`}
                  className="sr"
                  onClick={() =>
                    posthog.capture("docs_search_result_clicked", {
                      query: q,
                      result_slug: a.slug,
                      result_title: a.title,
                      result_position: matches.indexOf(a),
                      total_results: matches.length,
                    })
                  }
                >
                  <div
                    style={{
                      fontFamily: "'Geist Mono', monospace",
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#a7a7a1",
                      marginBottom: 3,
                    }}
                  >
                    {a.group}
                  </div>
                  <div style={{ fontFamily: "'Geist', sans-serif", fontSize: 16, fontWeight: 600, color: "#1a1a18", marginBottom: 2 }}>
                    {highlight(a.title, ql)}
                  </div>
                  <div style={{ fontFamily: "'Geist', sans-serif", fontSize: 14, lineHeight: 1.45, color: "#7b7b75" }}>
                    {highlight(a.excerpt, ql)}
                  </div>
                </a>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
