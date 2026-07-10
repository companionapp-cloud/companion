import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import type { Command } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, splitBlock } from "prosemirror-commands";
import { tableEditing, goToNextCell, isInTable } from "prosemirror-tables";
import { splitListItemKeepingType, liftListItem, sinkListItem } from "./listCommands";
import { tableMenuPlugin, type TableMenuPresenter } from "./tableMenu";
import { createTable, tableFromGrid, tableFromMarkdownCommand } from "./tables";
import type { ClipboardWriter } from "./tableCommands";
// Schema/parser/serializer extended with wikilink support (chips + un-escaped [[…]]).
import { schema, parser, serializer, wikilinkInputRules, wikilinkNode } from "./wikilink";
// The restricted plain-text-plus-references schema and its round-trip (see simpleSchema.ts).
import { simpleSchema, parseSimple, serializeSimple } from "./simpleSchema";
import { commonmarkInputRules } from "./inputrules";
import { wikilinkAutocomplete } from "./autocomplete";
import { emptyWikilinkPlugin, type EmptyLink } from "./emptyWikilink";
import { wikilinkHostAutocomplete, type HostAutocompleteBridge } from "./hostAutocomplete";
import { wikilinkNodeView, type WikilinkView } from "./wikilinkView";
import { documentNodeView, isDocumentEmbed } from "./documentView";
import { buildFormatCommands, computeFormatState, type FormatName, type FormatState } from "./formatCommands";
import type { DocumentSource, LinkRef, LinkSource, QuickCreateRequest, QuickCreateTarget } from "./types";

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
  /** Open the OS file picker and embed the chosen file(s) as `![[doc:<id>]]` (PLAN §6.9).
   * No-op unless a documentSource is wired. */
  insertDocument(): void;
  /** Insert an embed for an already-ingested document at the selection. Used by native
   * shells that ingest via an OS picker outside the editor, then place the embed. */
  insertDocumentEmbed(id: string, filename: string): void;
  /** Run a formatting toggle (bold, list, blockquote, …) on the current selection and
   * refocus the editor. No-op in the simple variant (it has no marks/blocks). */
  format(name: FormatName): void;
  /** Open the `[[` reference picker at the cursor (inserts the trigger, which the
   * autocomplete plugin turns into the web popup or the native host modal). */
  insertReference(): void;
  /** Insert a blank 2×2 GFM table (header row + one body row) at the cursor. Full variant
   * only; a no-op in the simple editor. */
  insertTable(): void;
  /** Complete (or cancel) a quick-create started from an empty `[[label]]` link: replace the
   * raw text with a resolved chip for `target`, or leave it untouched when `target` is null. */
  resolveQuickCreate(target: QuickCreateTarget | null): void;
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
  /** Host store for embedding + rendering files (PLAN §6.9). When set, the editor accepts
   * dropped/pasted files and the file picker (insertDocument), and renders `![[doc:…]]`
   * embeds inline. Omitted, embeds fall back to a filename chip. */
  documentSource?: DocumentSource;
  /** Notified when the editor gains/loses focus. The native host uses it to show a
   * keyboard toolbar only while the document (not some other field) is focused. */
  onFocusChange?: (focused: boolean) => void;
  /** Notified after every selection/content change with the formatting-toolbar snapshot
   * (which actions apply / are active). Full variant only; the simple editor never emits. */
  onFormatStateChange?: (state: FormatState) => void;
  /** Open a referenced entity when its chip is clicked (after it's selected). Wired to the
   * host's navigation (web opens a new tab; native posts the ref to the shell). */
  onOpenRef?: (ref: LinkRef) => void;
  /** Notified when an unresolved `[[label]]` link is double-clicked, so the host can offer a
   * quick-create. The host answers via {@link EditorHandle.resolveQuickCreate}. */
  onQuickCreate?: (req: QuickCreateRequest) => void;
  /** "full" is the document editor (headings, lists, task items, marks …). "simple" is a
   * plain-text-plus-references editor for task notes and the chat composer. Default "full". */
  variant?: "full" | "simple";
  /** Placeholder shown while the document is empty (simple variant). */
  placeholder?: string;
  /** Present the table cell menu natively instead of the built-in HTML popup. Injected by the
   * desktop (Wails) and iOS shells; omitted on web. Full variant only. */
  tableMenuPresenter?: TableMenuPresenter;
  /** Host clipboard writer for the table copy actions (iOS WebView can't use navigator.clipboard
   * reliably). Web/desktop leave this off and fall back to navigator.clipboard. */
  clipboard?: ClipboardWriter;
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

// Enter inside a table cell inserts a hard line break (cells are multiline; splitting the block
// would make a broken table). Serializes as `<br>` — see tables.ts. Returns true only in a table,
// so the keymap chain falls through to normal Enter handling elsewhere.
const enterInCell: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
};

// Some blocks have no keyboard way to escape below them when they end the document — a table, a
// code block (Enter just adds a line inside), or a blockquote. Keep an empty trailing paragraph
// after any of them so the caret can always land past it. Runs reactively on any transaction
// (including the selection change from clicking in, and the toolbar insert), so the escape hatch is
// always present. Only appends when missing, so it can't loop; the empty paragraph serializes to
// nothing, so it doesn't churn the note.
//
// Lists are intentionally excluded: they already have a natural keyboard exit — pressing Enter in
// an empty last item lifts it out of the list (splitListItemKeepingType → liftListItem). A trailing
// paragraph there would just leave a redundant blank line after that lift.
const TRAILING_ESCAPE_BLOCKS = new Set(["table", "code_block", "blockquote"]);
function trailingParagraphPlugin(): Plugin {
  return new Plugin({
    appendTransaction(_trs, _oldState, newState) {
      const last = newState.doc.lastChild;
      if (last && TRAILING_ESCAPE_BLOCKS.has(last.type.name)) {
        const para = schema.nodes.paragraph.createAndFill();
        if (para) return newState.tr.insert(newState.doc.content.size, para);
      }
      return null;
    },
  });
}

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
  // Empty `[[label]]` links: double-clicking one asks the host to quick-create a note/task
  // (options.onQuickCreate). Stash the clicked range so resolveQuickCreate can swap it for a
  // resolved chip once the host answers. Only installed when a host handler is wired.
  let pendingQuickCreate: { from: number; to: number; label: string } | null = null;
  const emptyLinkPlugins = options.onQuickCreate
    ? [
        emptyWikilinkPlugin((link: EmptyLink) => {
          pendingQuickCreate = { from: link.from, to: link.to, label: link.label };
          options.onQuickCreate!({ label: link.label, embed: false });
        }),
      ]
    : [];
  const plugins: Plugin[] = simple
    ? [
        history(),
        wikilinkInputRules(activeSchema),
        // Native delegates `[[` to a host modal; web/desktop use the in-editor DOM popup.
        ...autocompletePlugins,
        ...emptyLinkPlugins,
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
        // Table cell selection + arrow-key navigation, and the per-cell menu (hover ellipsis /
        // right-click / long-press). The menu presents natively on desktop/iOS when a presenter
        // is injected, else the built-in HTML popup.
        tableEditing(),
        trailingParagraphPlugin(),
        tableMenuPlugin({ presenter: options.tableMenuPresenter, clipboard: options.clipboard }),
        // Native delegates `[[` to a host modal; web/desktop use the in-editor DOM popup.
        ...autocompletePlugins,
        ...emptyLinkPlugins,
        keymap({ "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo }),
        // List + table editing (before baseKeymap so Enter/Tab are intercepted first): Enter
        // splits a list item or leaves the list, but is swallowed inside a table cell (GFM cells
        // are single-line). Tab / Shift-Tab move between cells in a table, else nest list items.
        keymap({
          Enter: chainCommands(
            // A GFM header+delimiter typed by hand becomes a table (before the cell guard, so it
            // can fire while the caret is still in the delimiter paragraph).
            tableFromMarkdownCommand(schema),
            enterInCell,
            splitListItemKeepingType(schema.nodes.list_item),
            liftListItem(schema.nodes.list_item),
          ),
          Tab: chainCommands(goToNextCell(1), sinkListItem(schema.nodes.list_item)),
          "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(schema.nodes.list_item)),
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

  // Two renderers share the wikilink node type: a plain link/task chip, and (for `![[doc:…]]`)
  // a rich document embed. The per-node factory below dispatches by node shape.
  const wlView = wikilinkNodeView({
    linkSource,
    onOpenRef: options.onOpenRef,
    register: (v) => {
      linkViews.add(v);
      return () => linkViews.delete(v);
    },
  });
  const docView = documentNodeView({ documentSource: options.documentSource });

  // Insert a document embed node (`![[doc:<id>]]`) at the current selection (PLAN §6.9). The
  // filename rides as the alias so the chip has a readable label; the core's link extractor
  // ignores it. Also the host-facing entry point for native shells that ingest a file outside
  // the editor (their OS picker) and then tell the editor to place the embed.
  const insertDocEmbed = (id: string, filename: string): void => {
    const node = wikilinkNode(activeSchema, { type: "document", id, alias: filename, embed: true });
    try {
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.replaceRangeWith(from, to, node).scrollIntoView());
    } catch {
      /* view torn down mid-insert */
    }
  };

  // Ingest File objects (web: drag-drop / paste / the in-editor picker) into documents and
  // embed each in order; a failed ingest skips just that file. No-op without File ingestion.
  const embedFiles = async (files: File[]): Promise<void> => {
    const ingest = options.documentSource?.ingest;
    if (!ingest || files.length === 0) return;
    for (const file of files) {
      try {
        const doc = await ingest(file);
        insertDocEmbed(doc.id, doc.filename);
      } catch {
        /* ingest failed; skip this file */
      }
    }
  };

  // Attach a file. Native shells provide `pick` (an OS-native picker that ingests and returns
  // the new document); web shells provide `ingest`, so a transient hidden <input type=file>
  // supplies the File. Keeps the editor framework-free (no React needed for the picker).
  const pickAndEmbed = async (): Promise<void> => {
    const src = options.documentSource;
    if (!src) return;
    if (src.pick) {
      try {
        const doc = await src.pick();
        if (doc) insertDocEmbed(doc.id, doc.filename);
      } catch {
        /* picker cancelled/failed */
      }
      return;
    }
    if (!src.ingest) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = input.files ? Array.from(input.files) : [];
      input.remove();
      if (files.length) void embedFiles(files);
      view.focus();
    });
    document.body.appendChild(input);
    input.click();
  };

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

  // External file drag-and-drop for document embeds (PLAN §6.9). The browser only lets a
  // drop land on a contenteditable if dragover's default is prevented — otherwise it opens
  // the file instead — so we handle the whole gesture explicitly. A depth counter keeps the
  // drop highlight stable across the dragenter/dragleave that fire for every child element.
  let dragDepth = 0;
  const dragHasFiles = (event: DragEvent): boolean =>
    !!options.documentSource?.ingest && !!event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files");
  const setDropActive = (active: boolean): void => {
    mount.classList.toggle("pm-drop-active", active);
  };

  const view = new EditorView(mount, {
    state,
    // Task chips hydrate from the host and are clickable; `![[doc:…]]` renders a rich media
    // embed; other links keep the plain pill.
    nodeViews: {
      wikilink: (node, nodeView, getPos) =>
        isDocumentEmbed(node) ? docView(node, nodeView, getPos) : wlView(node, nodeView, getPos),
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
      dragenter: (_v, event) => {
        if (!dragHasFiles(event)) return false;
        dragDepth++;
        setDropActive(true);
        return false;
      },
      dragover: (_v, event) => {
        if (!dragHasFiles(event)) return false;
        // Permit the drop (and show the copy cursor) instead of the browser opening the file.
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        return false;
      },
      dragleave: (_v, event) => {
        if (!dragHasFiles(event)) return false;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) setDropActive(false);
        return false;
      },
      // A dropped file becomes a document embed at the drop point (PLAN §6.9).
      drop: (_v, event) => {
        if (!dragHasFiles(event)) return false;
        dragDepth = 0;
        setDropActive(false);
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        if (at != null) {
          try {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
          } catch {
            /* out-of-range coords: fall back to the current selection */
          }
        }
        void embedFiles(Array.from(files));
        return true;
      },
    },
    handlePaste(_view, event) {
      // Pasted files (e.g. an image on the clipboard) embed as documents.
      const files = event.clipboardData?.files;
      if (files && files.length > 0 && options.documentSource?.ingest) {
        void embedFiles(Array.from(files));
        return true;
      }
      // A tab-delimited grid pasted as plain text (a spreadsheet selection with no HTML) becomes
      // a table. When the clipboard carries HTML the default parser already builds the table from
      // the schema's parseDOM, so only the plain-text-only case is handled, and only in the full
      // editor (the simple variant has no table nodes).
      if (!simple) {
        const html = event.clipboardData?.getData("text/html");
        const raw = event.clipboardData?.getData("text/plain");
        if (!html && raw && raw.includes("\t") && /\r?\n/.test(raw.trim())) {
          const grid = raw
            .replace(/\r\n/g, "\n")
            .replace(/\n+$/, "")
            .split("\n")
            .map((l) => l.split("\t"));
          if (grid.length >= 1 && grid.every((r) => r.length >= 2)) {
            const table = tableFromGrid(activeSchema, grid);
            if (table) {
              try {
                const { from, to } = view.state.selection;
                view.dispatch(view.state.tr.replaceRangeWith(from, to, table).scrollIntoView());
                return true;
              } catch {
                /* view torn down */
              }
            }
          }
        }
      }
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
    insertDocument() {
      void pickAndEmbed();
    },
    insertDocumentEmbed(id: string, filename: string) {
      insertDocEmbed(id, filename);
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
    insertTable() {
      // A blank 2×2 GFM table (header row + one body row). Full editor only; the simple schema
      // has no table nodes.
      if (simple) return;
      try {
        view.dispatch(view.state.tr.replaceSelectionWith(createTable(activeSchema, 2, 2)).scrollIntoView());
        view.focus();
      } catch {
        /* view torn down */
      }
    },
    resolveQuickCreate(target: QuickCreateTarget | null) {
      const pending = pendingQuickCreate;
      pendingQuickCreate = null;
      if (!pending || !target) return;
      // Guard against staleness: only replace if the range still reads a `[[…]]` link (the
      // doc may have been edited while the host's quick-create UI was open).
      try {
        const text = view.state.doc.textBetween(pending.from, pending.to, undefined, "￼");
        if (!text.startsWith("[[") || !text.endsWith("]]")) return;
        const node = wikilinkNode(activeSchema, { type: target.type, id: target.id, alias: target.title });
        view.dispatch(view.state.tr.replaceRangeWith(pending.from, pending.to, node).scrollIntoView());
        view.focus();
      } catch {
        /* view torn down or range out of sync */
      }
    },
  };
}
