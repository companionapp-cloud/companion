import { useCallback, useState, type ReactElement, type RefObject } from "react";
import type { EditorController, QuickCreateRequest } from "@companion/editor";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { QuickCreateLinkDialog } from "./QuickCreateLinkDialog";

/** Wires an editor's empty-link quick-create to the notes/tasks stores. Give it the editor's
 *  imperative ref; spread `onQuickCreate` onto `<Editor>` and render `dialog` alongside it.
 *  Double-clicking an unresolved `[[label]]` opens the dialog; creating makes the entity and
 *  tells the editor (via {@link EditorController.resolveQuickCreate}) to swap in a real chip. */
export function useQuickCreateLink(editorRef: RefObject<EditorController | null>): {
  onQuickCreate: (req: QuickCreateRequest) => void;
  dialog: ReactElement | null;
} {
  const notes = useNotes();
  const tasks = useTasks();
  const [request, setRequest] = useState<QuickCreateRequest | null>(null);

  const onQuickCreate = useCallback((req: QuickCreateRequest) => setRequest(req), []);

  const cancel = useCallback(() => {
    editorRef.current?.resolveQuickCreate(null);
    setRequest(null);
  }, [editorRef]);

  const create = useCallback(
    async (kind: "note" | "task", title: string) => {
      if (kind === "note") {
        const note = await notes.create({ title });
        editorRef.current?.resolveQuickCreate({ type: "note", id: note.id, title: note.title });
      } else {
        const task = await tasks.create({ title });
        editorRef.current?.resolveQuickCreate({ type: "task", id: task.id, title: task.title });
      }
      setRequest(null);
    },
    [notes, tasks, editorRef],
  );

  const dialog = request ? (
    <QuickCreateLinkDialog label={request.label} onCreate={create} onCancel={cancel} />
  ) : null;

  return { onQuickCreate, dialog };
}
