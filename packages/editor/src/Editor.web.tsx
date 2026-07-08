import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createEditor, type EditorHandle } from "./createEditor";
import { ensureEditorStyles } from "./styles";
import type { EditorController, EditorProps } from "./types";

// Web/desktop editor: ProseMirror mounted straight into the DOM (react-native-web is
// real DOM, so no WebView is needed — Vite resolves this via .web.tsx). It grows to
// its content; the note view's ScrollView provides the scroll and document column.
export const Editor = forwardRef<EditorController, EditorProps>(function Editor(
  { markdown, onChangeMarkdown, linkSource, onOpenRef, linkRevision, variant, placeholder, onSubmit, clearSignal, minHeight, maxHeight, debounceMs, onFormatStateChange },
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
  const onOpenRefRef = useRef(onOpenRef);
  onOpenRefRef.current = onOpenRef;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onFormatStateRef = useRef(onFormatStateChange);
  onFormatStateRef.current = onFormatStateChange;

  // The host's selection bar drives the editor through this ref.
  useImperativeHandle(
    ref,
    (): EditorController => ({
      format: (name) => handleRef.current?.format(name),
      insertReference: () => handleRef.current?.insertReference(),
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
      linkSource: linkSourceRef.current
        ? {
            search: (q, type) => linkSourceRef.current!.search(q, type),
            lookup: (id) => linkSourceRef.current!.lookup(id),
          }
        : undefined,
      onOpenRef: (ref) => onOpenRefRef.current?.(ref),
    });
    handleRef.current = handle;
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

  // Empty the editor when the host bumps clearSignal (chat composer, post-send). Skips mount.
  const firstClear = useRef(true);
  useEffect(() => {
    if (firstClear.current) {
      firstClear.current = false;
      return;
    }
    handleRef.current?.clear();
  }, [clearSignal]);

  // The simple field hugs its content; cap it at maxHeight (scrolling past it) and reserve
  // minHeight so an empty composer/note still has a comfortable tap target.
  const style =
    variant === "simple"
      ? { minHeight, maxHeight, overflowY: maxHeight ? ("auto" as const) : undefined }
      : undefined;
  return <div ref={mountRef} className={variant === "simple" ? "companion-editor pm-simple" : "companion-editor"} style={style} />;
});
