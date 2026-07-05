// The editor's cross-platform contract. `markdown` seeds the editor once (the editor
// owns its content thereafter); `onChangeMarkdown` reports serialized markdown back,
// debounced. The editor fills its parent, so size it from the outside.
export interface EditorProps {
  markdown: string;
  onChangeMarkdown: (markdown: string) => void;
  /** Optional provider for wikilink autocomplete (`[[`) and pasted-UUID resolution.
   * Omit it and those features stay dormant (input rules + chips still work). */
  linkSource?: LinkSource;
}

/** A link target the editor can offer or resolve — a slim projection, never a body. */
export interface LinkSuggestion {
  type: "note" | "task" | "habit" | "project";
  id: string;
  title: string;
}

/** The entity types the `[[` menu can scope its search to. */
export type LinkType = "note" | "task" | "habit" | "project";

/** How the editor reaches the host's object graph. Both calls are async so the native
 * WebView can satisfy them over the postMessage bridge. */
export interface LinkSource {
  /** Title search for the `[[` autocomplete menu. `type` scopes to one entity type;
   * omit (or pass "all") to search across all of them. */
  search(query: string, type?: LinkType | "all"): Promise<LinkSuggestion[]>;
  /** Resolve one id (any type) to its target, for turning a pasted UUID into a link. */
  lookup(id: string): Promise<LinkSuggestion | null>;
}
