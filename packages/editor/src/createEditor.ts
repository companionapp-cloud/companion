import { EditorState, Plugin } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, splitBlock } from "prosemirror-commands";
import { splitListItemKeepingType, liftListItem, sinkListItem } from "./listCommands";
// Schema/parser/serializer extended with wikilink support (chips + un-escaped [[…]]).
import { schema, parser, serializer, wikilinkInputRules, wikilinkNode } from "./wikilink";
// The restricted plain-text-plus-references schema and its round-trip (see simpleSchema.ts).
import { simpleSchema, parseSimple, serializeSimple } from "./simpleSchema";
import { commonmarkInputRules } from "./inputrules";
import { wikilinkAutocomplete } from "./autocomplete";
import { wikilinkHostAutocomplete, type HostAutocompleteBridge } from "./hostAutocomplete";
import { wikilinkNodeView, type WikilinkView } from "./wikilinkView";
import { buildFormatCommands, computeFormatState, type FormatName, type FormatState } from "./formatCommands";
import type { LinkRef, LinkSource } from "./types";

// The shared ProseMirror setup — pure DOM, no framework. Used directly on web/desktop
// (Editor.web.tsx) and inside the WebView on native (webview/main.ts). Content is
// markdown in / markdown out to match the note model.
export interface EditorHandle {
  destroy(): void;
  /** Re-hydrate every `[[task:…]]` chip from the host. Call when task data changed
   * elsewhere while the editor stayed open, so the chips reflect it. */
  refreshLinks(): void;
  /** Replace the whole document with fresh content (not added to the undo history). Used
   * by the chat composer to reset after sending. */
  setContent(markdown: string): void;
  /** Empty the document. Shorthand for `setContent("")`. */
  clear(): void;
  /** Run a formatting toggle (bold, list, blockquote, …) on the current selection and
   * refocus the editor. No-op in the simple variant (it has no marks/blocks). */
  format(name: FormatName): void;
  /** Open the `[[` reference picker at the cursor (inserts the trigger, which the
   * autocomplete plugin turns into the web popup or the native host modal). */
  insertReference(): void;
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
  /** Notified after every selection/content change with the formatting-toolbar snapshot
   * (which actions apply / are active). Full variant only; the simple editor never emits. */
  onFormatStateChange?: (state: FormatState) => void;
  /** Open a referenced entity when its chip is clicked (after it's selected). Wired to the
   * host's navigation (web opens a new tab; native posts the ref to the shell). */
  onOpenRef?: (ref: LinkRef) => void;
  /** "full" is the document editor (headings, lists, task items, marks …). "simple" is a
   * plain-text-plus-references editor for task notes and the chat composer. Default "full". */
  variant?: "full" | "simple";
  /** Placeholder shown while the document is empty (simple variant). */
  placeholder?: string;
  /** When set, Enter submits (calls this with the current content) instead of inserting a
   * newline, and Shift-Enter makes a new paragraph — the chat composer's send behavior. The
   * markdown is passed so the host sends exactly what's shown, not a debounced draft. Simple
   * variant only. */
  onSubmit?: (markdown: string) => void;
}

// Show placeholder text over an empty document. Decorates the single empty paragraph with a
// class + the text (rendered via CSS ::before), the standard ProseMirror placeholder trick.
function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc } = state;
        const only = doc.childCount === 1 ? doc.firstChild : null;
        if (!only || !only.isTextblock || only.content.size > 0) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, only.nodeSize, { class: "pm-empty", "data-placeholder": text }),
        ]);
      },
    },
  });
}

// A bare UUID on the clipboard becomes a wikilink (its type resolved via linkSource).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Toggle a task item when its checkbox is clicked. The box is contentEditable=false, so
// mousedown doesn't move the selection; we resolve the enclosing list_item and flip its
// `checked` attr. preventDefault keeps the caret from jumping into the item.
function taskCheckboxPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          const target = event.target as HTMLElement | null;
          const box = target?.closest?.(".pm-task-checkbox");
          if (!box) return false;
          event.preventDefault();
          const $pos = view.state.doc.resolve(view.posAtDOM(box, 0));
          for (let d = $pos.depth; d > 0; d--) {
            const node = $pos.node(d);
            if (node.type.name === "list_item" && node.attrs.checked !== null) {
              view.dispatch(view.state.tr.setNodeMarkup($pos.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }));
              return true;
            }
          }
          return false;
        },
      },
    },
  });
}

export function createEditor(
  mount: HTMLElement,
  initialMarkdown: string,
  onChange: (markdown: string) => void,
  options: CreateEditorOptions = {},
): EditorHandle {
  const debounceMs = options.debounceMs ?? 400;
  const { linkSource, hostAutocomplete } = options;
  const simple = options.variant === "simple";
  // Each variant owns its schema and markdown round-trip. The simple editor is plain text
  // plus reference chips; the full editor is the document schema (headings, lists, marks …).
  const activeSchema = simple ? simpleSchema : schema;
  const parse = (md: string): Node | undefined =>
    simple ? parseSimple(md) : md ? parser.parse(md) ?? undefined : undefined;
  const serialize = (d: Node): string => (simple ? serializeSimple(d) : serializer.serialize(d));

  const doc = parse(initialMarkdown);
  // Order matters: input rules and the autocomplete menu must see keys before the base
  // keymap so Enter/Tab/Backspace can be intercepted while a menu or rule is in play.
  const autocompletePlugins = hostAutocomplete
    ? [wikilinkHostAutocomplete(hostAutocomplete, activeSchema)]
    : linkSource
      ? [wikilinkAutocomplete(linkSource, activeSchema)]
      : [];
  const plugins: Plugin[] = simple
    ? [
        history(),
        wikilinkInputRules(activeSchema),
        // Native delegates `[[` to a host modal; web/desktop use the in-editor DOM popup.
        ...autocompletePlugins,
        keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
        ...(options.placeholder ? [placeholderPlugin(options.placeholder)] : []),
        // Composer send: Enter submits, Shift-Enter drops to a new paragraph. Without an
        // onSubmit (task notes), Enter falls through to baseKeymap and splits normally.
        ...(options.onSubmit
          ? [
              keymap({
                Enter: (state) => {
                  options.onSubmit!(serialize(state.doc));
                  return true;
                },
                "Shift-Enter": splitBlock,
              }),
            ]
          : []),
        keymap(baseKeymap),
      ]
    : [
        history(),
        commonmarkInputRules(schema),
        wikilinkInputRules(activeSchema),
        taskCheckboxPlugin(),
        // Native delegates `[[` to a host modal; web/desktop use the in-editor DOM popup.
        ...autocompletePlugins,
        keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
        // List editing (before baseKeymap so Enter/Tab are intercepted inside a list): Enter
        // splits the item, or leaves the list when the item is empty; Tab / Shift-Tab nest.
        keymap({
          Enter: chainCommands(splitListItemKeepingType(schema.nodes.list_item), liftListItem(schema.nodes.list_item)),
          Tab: sinkListItem(schema.nodes.list_item),
          "Shift-Tab": liftListItem(schema.nodes.list_item),
        }),
        keymap(baseKeymap),
      ];
  const state = EditorState.create({ schema: activeSchema, doc, plugins });

  // Formatting toggles for the toolbar (full editor only — the simple schema has no marks,
  // lists, or blocks to toggle).
  const formatCommands = simple ? null : buildFormatCommands(schema);
  const emitFormatState = () => {
    if (formatCommands && options.onFormatStateChange)
      options.onFormatStateChange(computeFormatState(view.state, formatCommands, schema));
  };

  // Live task chips register here so refreshLinks() can re-hydrate them on demand.
  const linkViews = new Set<WikilinkView>();

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
    // Task chips hydrate from the host and are clickable; other links keep the plain pill.
    nodeViews: {
      wikilink: wikilinkNodeView({
        linkSource,
        onOpenRef: options.onOpenRef,
        register: (v) => {
          linkViews.add(v);
          return () => linkViews.delete(v);
        },
      }),
    },
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
          view.dispatch(view.state.tr.replaceRangeWith(from, to, wikilinkNode(activeSchema, { type, id: text, alias })).scrollIntoView());
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
        pending = serialize(next.doc);
        if (!timer) timer = setTimeout(flush, debounceMs);
      }
      // The toolbar tracks both content and selection changes (marks active, what's enabled).
      if (tr.docChanged || tr.selectionSet) emitFormatState();
    },
  });

  // Seed the toolbar with the initial selection's state.
  emitFormatState();

  // Swap the whole document for freshly parsed content, off the undo history. Emits a
  // change like any edit (the composer's onChange resets its draft).
  const setContent = (markdown: string) => {
    const parsed = parse(markdown);
    const content = parsed ? parsed.content : activeSchema.topNodeType.createAndFill()!.content;
    try {
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, content).setMeta("addToHistory", false));
    } catch {
      /* view torn down */
    }
  };

  return {
    destroy() {
      if (options.flushOnDestroy) flush();
      else if (timer) clearTimeout(timer);
      view.destroy();
    },
    refreshLinks() {
      linkViews.forEach((v) => v.rehydrate());
    },
    setContent,
    clear() {
      setContent("");
    },
    format(name: FormatName) {
      if (!formatCommands) return;
      formatCommands[name](view.state, view.dispatch, view);
      view.focus();
    },
    insertReference() {
      // Insert the `[[` trigger at the cursor; the autocomplete plugin (web popup or native
      // host modal) picks it up from there, exactly as if the user had typed it.
      try {
        view.dispatch(view.state.tr.insertText("[["));
        view.focus();
      } catch {
        /* view torn down */
      }
    },
  };
}
