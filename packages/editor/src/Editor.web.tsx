import { useEffect, useRef } from "react";
import { createEditor } from "./createEditor";
import { ensureEditorStyles } from "./styles";
import type { EditorProps } from "./types";

// Web/desktop editor: ProseMirror mounted straight into the DOM (react-native-web is
// real DOM, so no WebView is needed — Vite resolves this via .web.tsx). It grows to
// its content; the note view's ScrollView provides the scroll and document column.
export function Editor({ markdown, onChangeMarkdown, linkSource }: EditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChangeMarkdown);
  onChangeRef.current = onChangeMarkdown;
  const initialMarkdown = useRef(markdown).current;
  // Kept in a ref so the editor (built once) always calls the latest provider.
  const linkSourceRef = useRef(linkSource);
  linkSourceRef.current = linkSource;

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
    });
    return () => handle.destroy();
    // Mount once; the note view keys this by note id, so a different note remounts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={mountRef} className="companion-editor" />;
}
