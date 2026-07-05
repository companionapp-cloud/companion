import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema, defaultMarkdownParser, defaultMarkdownSerializer } from "prosemirror-markdown";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";

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
}

export function createEditor(
  mount: HTMLElement,
  initialMarkdown: string,
  onChange: (markdown: string) => void,
  options: CreateEditorOptions = {},
): EditorHandle {
  const debounceMs = options.debounceMs ?? 400;

  const doc = initialMarkdown ? defaultMarkdownParser.parse(initialMarkdown) ?? undefined : undefined;
  const state = EditorState.create({
    schema,
    doc,
    plugins: [
      history(),
      keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
      keymap(baseKeymap),
    ],
  });

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
      blur: () => {
        flush();
        return false;
      },
    },
    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      if (tr.docChanged) {
        pending = defaultMarkdownSerializer.serialize(next.doc);
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
