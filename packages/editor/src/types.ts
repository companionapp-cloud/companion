// The editor's cross-platform contract. `markdown` seeds the editor once (the editor
// owns its content thereafter); `onChangeMarkdown` reports serialized markdown back,
// debounced. The editor fills its parent, so size it from the outside.
export interface EditorProps {
  markdown: string;
  onChangeMarkdown: (markdown: string) => void;
  /** Optional provider for wikilink autocomplete (`[[`) and pasted-UUID resolution.
   * Omit it and those features stay dormant (input rules + chips still work). */
  linkSource?: LinkSource;
  /** Called when the reader opens a wikilink chip (select it, then click again). The host
   * decides how — e.g. open the target in a new workspace tab. Omit and chips only select. */
  onOpenRef?: (ref: LinkRef) => void;
  /** Change this value's identity to re-hydrate `[[task:…]]` chips against the latest task
   * data (via {@link LinkSource.lookup}). The editor otherwise hydrates a chip only when it
   * mounts, so a task edited elsewhere while the note stays open would look stale. Only
   * touches already-rendered chips; the document itself is unchanged. */
  linkRevision?: unknown;
}

/** A reference to open — the payload of {@link EditorProps.onOpenRef}. */
export interface LinkRef {
  type: LinkType;
  id: string;
}

/** A link target the editor can offer or resolve — a slim projection, never a body. */
export interface LinkSuggestion {
  type: "note" | "task" | "habit" | "project";
  id: string;
  title: string;
  /** Task-only extras, so a `[[task:…]]` chip can render like a todo (done state + dates).
   * Left undefined for other types (and for hosts that don't supply them). */
  status?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
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
