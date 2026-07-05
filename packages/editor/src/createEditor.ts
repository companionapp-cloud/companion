import { EditorState, type Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
// Schema/parser/serializer extended with wikilink support (chips + un-escaped [[…]]).
import { schema, parser, serializer, wikilinkInputRules, wikilinkNode } from "./wikilink";
import { commonmarkInputRules } from "./inputrules";
import { wikilinkAutocomplete } from "./autocomplete";
import { wikilinkHostAutocomplete, type HostAutocompleteBridge } from "./hostAutocomplete";
import type { LinkSource } from "./types";

// The shared ProseMirror setup — pure DOM, no framework. Used directly on web/desktop
// (Editor.web.tsx) and inside the WebView on native (webview/main.ts). Content is
// markdown in / markdown out to match the note model.
export interface EditorHandle {
  destroy(): void;
}

export interface CreateEditorOptions {
  /** Coalesce edits: emit at most this often (ms). Also flushes on blur. */
  debounceMs?: number;
  /** Flush a pending edit on destroy. Safe on web; the WebView host leaves it false
   * so it never calls the bridge during teardown. */
  flushOnDestroy?: boolean;
  /** Object-graph access for `[[` autocomplete and pasted-UUID resolution. When omitted,
   * those features stay off; input rules and chips still work. */
  linkSource?: LinkSource;
  /** When set, `[[` delegates to a native host modal instead of the in-editor DOM popup
   * (mobile). `linkSource` is still used for pasted-UUID resolution. */
  hostAutocomplete?: HostAutocompleteBridge;
  /** Notified when the editor gains/loses focus. The native host uses it to show a
   * keyboard toolbar only while the document (not some other field) is focused. */
  onFocusChange?: (focused: boolean) => void;
}

// A bare UUID on the clipboard becomes a wikilink (its type resolved via linkSource).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function createEditor(
  mount: HTMLElement,
  initialMarkdown: string,
  onChange: (markdown: string) => void,
  options: CreateEditorOptions = {},
): EditorHandle {
  const debounceMs = options.debounceMs ?? 400;
  const { linkSource, hostAutocomplete } = options;

  const doc = initialMarkdown ? parser.parse(initialMarkdown) ?? undefined : undefined;
  // Order matters: input rules and the autocomplete menu must see keys before the base
  // keymap so Enter/Tab/Backspace can be intercepted while a menu or rule is in play.
  const plugins: Plugin[] = [
    history(),
    commonmarkInputRules(schema),
    wikilinkInputRules(),
    // Native delegates `[[` to a host modal; web/desktop use the in-editor DOM popup.
    ...(hostAutocomplete
      ? [wikilinkHostAutocomplete(hostAutocomplete)]
      : linkSource
        ? [wikilinkAutocomplete(linkSource)]
        : []),
    keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
    keymap(baseKeymap),
  ];
  const state = EditorState.create({ schema, doc, plugins });

  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending !== null) {
      onChange(pending);
      pending = null;
    }
  };

  const view = new EditorView(mount, {
    state,
    handleDOMEvents: {
      focus: () => {
        options.onFocusChange?.(true);
        return false;
      },
      blur: () => {
        flush();
        options.onFocusChange?.(false);
        return false;
      },
    },
    handlePaste(_view, event) {
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (!text || !UUID_RE.test(text)) return false;
      const { from, to } = view.state.selection;
      const insert = (type: string, alias: string | null) => {
        try {
          view.dispatch(view.state.tr.replaceRangeWith(from, to, wikilinkNode({ type, id: text, alias })).scrollIntoView());
        } catch {
          /* view torn down before the async resolve landed */
        }
      };
      if (linkSource) {
        linkSource
          .lookup(text)
          .then((hit) => insert(hit?.type ?? "note", hit?.title ?? null))
          .catch(() => insert("note", null));
      } else {
        insert("note", null);
      }
      return true;
    },
    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      if (tr.docChanged) {
        pending = serializer.serialize(next.doc);
        if (!timer) timer = setTimeout(flush, debounceMs);
      }
    },
  });

  return {
    destroy() {
      if (options.flushOnDestroy) flush();
      else if (timer) clearTimeout(timer);
      view.destroy();
    },
  };
}
