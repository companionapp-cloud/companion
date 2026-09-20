import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createEditor, type EditorHandle } from "./createEditor";
import { ensureEditorStyles } from "./styles";
import type { EditorController, EditorProps } from "./types";

// Web/desktop editor: ProseMirror mounted straight into the DOM (react-native-web is
// real DOM, so no WebView is needed — Vite resolves this via .web.tsx). It grows to
// its content; the note view's ScrollView provides the scroll and document column.
export const Editor = forwardRef<EditorController, EditorProps>(function Editor(
  { markdown, onChangeMarkdown, linkSource, documentSource, onOpenRef, onQuickCreate, linkRevision, variant, inline, placeholder, onSubmit, clearSignal, minHeight, maxHeight, debounceMs, onFormatStateChange, onFocusChange, tableMenuPresenter, ink },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const onChangeRef = useRef(onChangeMarkdown);
  onChangeRef.current = onChangeMarkdown;
  const initialMarkdown = useRef(markdown).current;
  // Kept in a ref so the editor (built once) always calls the latest provider.
  const linkSourceRef = useRef(linkSource);
  linkSourceRef.current = linkSource;
  const documentSourceRef = useRef(documentSource);
  documentSourceRef.current = documentSource;
  const onOpenRefRef = useRef(onOpenRef);
  onOpenRefRef.current = onOpenRef;
  const onQuickCreateRef = useRef(onQuickCreate);
  onQuickCreateRef.current = onQuickCreate;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onFormatStateRef = useRef(onFormatStateChange);
  onFormatStateRef.current = onFormatStateChange;
  const onFocusChangeRef = useRef(onFocusChange);
  onFocusChangeRef.current = onFocusChange;
  // Drawing (PLAN-drawing.md): on or off for the editor's lifetime, callbacks via a ref.
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const hasInk = useRef(!!ink).current;

  // The host's selection bar drives the editor through this ref.
  useImperativeHandle(
    ref,
    (): EditorController => ({
      format: (name) => handleRef.current?.format(name),
      insertReference: () => handleRef.current?.insertReference(),
      insertTable: () => handleRef.current?.insertTable(),
      insertDocument: () => handleRef.current?.insertDocument(),
      resolveQuickCreate: (target) => handleRef.current?.resolveQuickCreate(target),
      inkUndo: () => handleRef.current?.inkUndo(),
      inkRedo: () => handleRef.current?.inkRedo(),
    }),
    [],
  );

  useEffect(() => {
    ensureEditorStyles();
    const mount = mountRef.current;
    if (!mount) return;
    const handle = createEditor(mount, initialMarkdown, (md) => onChangeRef.current(md), {
      flushOnDestroy: true,
      variant,
      placeholder,
      debounceMs,
      onSubmit: onSubmit ? (md) => onSubmitRef.current?.(md) : undefined,
      onFormatStateChange: (state) => onFormatStateRef.current?.(state),
      onFocusChange: (focused) => onFocusChangeRef.current?.(focused),
      linkSource: linkSourceRef.current
        ? {
            search: (q, type) => linkSourceRef.current!.search(q, type),
            lookup: (id) => linkSourceRef.current!.lookup(id),
          }
        : undefined,
      // The shell builds this once and keeps it stable, so pass it straight through (unlike
      // linkSource, no per-call ref indirection is needed).
      documentSource: documentSourceRef.current,
      onOpenRef: (ref) => onOpenRefRef.current?.(ref),
      onQuickCreate: (req) => onQuickCreateRef.current?.(req),
      // Desktop injects a Wails-backed native menu presenter; web leaves it undefined (the
      // editor falls back to its built-in HTML popup). Captured once at mount, like documentSource.
      tableMenuPresenter,
      ink: hasInk
        ? {
            onSave: (groups) => inkRef.current?.onSave(groups),
            onDelete: (ids) => inkRef.current?.onDelete(ids),
            onStateChange: (state) => inkRef.current?.onStateChange?.(state),
            onExitRequest: () => inkRef.current?.onExitRequest?.(),
          }
        : undefined,
    });
    handleRef.current = handle;
    if (inkRef.current) {
      handle.setInkGroups(inkRef.current.groups);
      handle.setInkTool(inkRef.current.tool);
    }
    return () => {
      handleRef.current = null;
      handle.destroy();
    };
    // Mount once; the note view keys this by note id, so a different note remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-hydrate task chips when the host signals task data changed (skips the initial mount,
  // where chips already hydrate themselves on creation).
  const firstRevision = useRef(true);
  useEffect(() => {
    if (firstRevision.current) {
      firstRevision.current = false;
      return;
    }
    handleRef.current?.refreshLinks();
  }, [linkRevision]);

  // Follow the host's ink: groups as they load or sync in, and the drawing tool (both were
  // applied at mount). Harmless to repeat, so these run on every change.
  const inkGroups = ink?.groups;
  useEffect(() => {
    if (inkGroups) handleRef.current?.setInkGroups(inkGroups);
  }, [inkGroups]);
  const inkTool = ink?.tool ?? null;
  useEffect(() => {
    handleRef.current?.setInkTool(inkTool);
  }, [inkTool]);

  // Empty the editor when the host bumps clearSignal (chat composer, post-send). Compares with
  // the last value rather than skipping the first run: Fast Refresh re-runs every effect, and
  // a first-run flag would then wipe the open document (and autosave the empty note).
  const lastClear = useRef(clearSignal);
  useEffect(() => {
    if (Object.is(lastClear.current, clearSignal)) return;
    lastClear.current = clearSignal;
    handleRef.current?.clear();
  }, [clearSignal]);

  // The simple field hugs its content; cap it at maxHeight (scrolling past it) and reserve
  // minHeight so an empty composer/note still has a comfortable tap target.
  const style =
    variant === "simple" || inline
      ? { minHeight, maxHeight, overflowY: maxHeight ? ("auto" as const) : undefined }
      : undefined;
  const className = variant === "simple" ? "companion-editor pm-simple" : inline ? "companion-editor pm-inline" : "companion-editor";
  return <div ref={mountRef} className={className} style={style} />;
});
