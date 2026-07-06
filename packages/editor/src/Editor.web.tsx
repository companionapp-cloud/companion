import { useEffect, useRef } from "react";
import { createEditor, type EditorHandle } from "./createEditor";
import { ensureEditorStyles } from "./styles";
import type { EditorProps } from "./types";

// Web/desktop editor: ProseMirror mounted straight into the DOM (react-native-web is
// real DOM, so no WebView is needed — Vite resolves this via .web.tsx). It grows to
// its content; the note view's ScrollView provides the scroll and document column.
export function Editor({ markdown, onChangeMarkdown, linkSource, onOpenRef, linkRevision }: EditorProps) {
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

  useEffect(() => {
    ensureEditorStyles();
    const mount = mountRef.current;
    if (!mount) return;
    const handle = createEditor(mount, initialMarkdown, (md) => onChangeRef.current(md), {
      flushOnDestroy: true,
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

  return <div ref={mountRef} className="companion-editor" />;
}
