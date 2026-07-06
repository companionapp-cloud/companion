import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Schema } from "prosemirror-model";
import { wikilinkNode } from "./wikilink";
import { detectTrigger, triggerKey as key, type Trigger } from "./wikilinkTrigger";

// Native `[[` autocomplete. A DOM popup inside the WebView is cramped and fights the
// on-screen keyboard, so on mobile the picker is a native modal (see Editor.tsx). This
// plugin is the WebView half of that: it detects the `[[` trigger and tells the host to
// open its modal, and exposes window.__insertRef / window.__cancelRef so the host can
// drop the chosen reference into the document (or cancel and leave the `[[` as text).

/** How the WebView notifies the native host that the `[[` picker should open or close. */
export interface HostAutocompleteBridge {
  open(embed: boolean): void;
  close(): void;
}

/** The payload the host injects back when the user picks a target. */
export interface InsertRefPayload {
  type: string;
  id: string;
  title?: string | null;
  embed?: boolean;
}

interface RefWindow {
  __insertRef?: (payload: InsertRefPayload) => void;
  __cancelRef?: () => void;
}

export function wikilinkHostAutocomplete(bridge: HostAutocompleteBridge, schema: Schema): Plugin {
  // The recorded `[[` range (null when the picker was opened from the toolbar button, i.e.
  // "insert at the cursor"). Kept outside plugin state because the editor is blurred while
  // the modal is up, so no transactions arrive to carry it.
  let range: { from: number; to: number; embed: boolean } | null = null;
  let dismissedFrom: number | null = null;
  let view: EditorView | null = null;

  const insert = (payload: InsertRefPayload) => {
    if (!view) return;
    const node = wikilinkNode(schema, {
      type: payload.type,
      id: payload.id,
      alias: payload.title ?? null,
      embed: payload.embed ?? range?.embed ?? false,
    });
    const from = range ? range.from : view.state.selection.from;
    const to = range ? range.to : view.state.selection.to;
    try {
      view.dispatch(view.state.tr.replaceRangeWith(from, to, node).scrollIntoView());
    } catch {
      /* view torn down */
    }
    range = null;
    dismissedFrom = null;
    view.focus();
  };

  const cancel = () => {
    dismissedFrom = range ? range.from : null;
    range = null;
    view?.focus();
  };

  return new Plugin<Trigger | null>({
    key,
    state: {
      init: () => null,
      apply: (_tr, _prev, _old, next) => detectTrigger(next),
    },
    view() {
      const w = window as unknown as RefWindow;
      w.__insertRef = insert;
      w.__cancelRef = cancel;
      return {
        update(v) {
          view = v;
          const t = key.getState(v.state);
          if (!t) {
            if (range) {
              range = null;
              bridge.close();
            }
            dismissedFrom = null;
            return;
          }
          if (t.from === dismissedFrom) return;
          if (!range) {
            // A fresh `[[`: record its range and ask the host to open the modal.
            range = { from: t.from, to: t.to, embed: t.embed };
            bridge.open(t.embed);
          } else {
            // Still the same trigger (query grew before the editor blurred).
            range.to = t.to;
          }
        },
        destroy() {
          const ww = window as unknown as RefWindow;
          if (ww.__insertRef === insert) delete ww.__insertRef;
          if (ww.__cancelRef === cancel) delete ww.__cancelRef;
        },
      };
    },
  });
}

/** Insert a reference at the current cursor, no `[[` trigger required (the toolbar
 * button path). Exposed so Editor.tsx can drive it via the same injected globals. */
export const HOST_INSERT_GLOBAL = "__insertRef";
export const HOST_CANCEL_GLOBAL = "__cancelRef";
