import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCore, useNotes, useTasks, MembershipPicker, ConfirmDialog, NoteConflictDialog, useNoteSyncGuard, useQuickCreateLink, ArchetypeChip, ObjectMetadataPanel, timeAgo, useNoteInk, useDrawingTool, DrawingBar, DocTitleField } from '@companion/app';
import { Center, Icon, IconButton, Text, colors, space } from '@companion/design-system';
import type { ObjectProps } from '@companion/core-bridge';
import { Editor, type EditorController, type InkState, type LinkRef, type LinkSource } from '@companion/editor';
import type { RootStackParamList } from '../MobileShell';
import { useNativeDocumentSource } from '../useNativeDocumentSource';
import { NavAction, NavActions, SheetSurface } from '../ui/native';

// Full-screen editor for one note (pushed above the tab bar): a mono edited line and a
// native title field over the ProseMirror body (a WebView) — the same editor the desktop
// tabs render; only the chrome differs. Note-scoped actions are icons in the nav bar.
export function NoteEditorScreen() {
  const store = useNotes();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'NoteEditor'>>();
  const noteId = params.id;
  const note = store.byId(noteId);
  const { width: windowWidth } = useWindowDimensions();
  const [title, setTitle] = useState(note?.title ?? '');
  const [showProjects, setShowProjects] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Seed the editor from `seed.content`; the WebView owns its content after mount and
  // reports changes back out (a changing markdown prop re-injects on every keystroke and
  // crashes the DOM view). `seed.key` remounts the WebView when the sync guard silently
  // adopts a server version.
  const [seed, setSeed] = useState(() => ({ key: 0, content: note?.contentMd ?? '' }));
  // The editor's latest reported markdown, read when saving local edits as a new note.
  const contentRef = useRef(note?.contentMd ?? '');

  // `store` gets a new identity on every save (its useMemo tracks `notes`), so route
  // through a ref and give the DOM component / header callbacks stable identities that
  // depend only on the note id.
  const storeRef = useRef(store);
  storeRef.current = store;
  const onChangeMarkdown = useCallback(
    (md: string) => {
      contentRef.current = md;
      storeRef.current.save(noteId, { contentMd: md });
    },
    [noteId],
  );

  // Reconcile the open editor with incoming synced versions (PLAN §7.3 editor UX).
  const guard = useNoteSyncGuard({
    noteId,
    getEditorContent: () => ({ title, contentMd: contentRef.current }),
    onReseed: (n) => {
      setTitle(n.title);
      contentRef.current = n.contentMd;
      setSeed((s) => ({ key: s.key + 1, content: n.contentMd }));
    },
    onGone: () => nav.goBack(),
    onCreatedNote: (id) => nav.push('NoteEditor', { id }),
  });

  // Wikilink autocomplete ([[) + pasted-UUID resolution search the object graph. Stable
  // identity (graph is memoized on the core) so it doesn't reload the WebView. A task
  // lookup also carries its done state + dates so a `[[task:…]]` chip renders like a todo;
  // tasks come through a ref so fresher data doesn't change the linkSource identity.
  const { graph } = useCore();
  const tasks = useTasks();
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const linkSource = useMemo<LinkSource>(
    () => ({
      search: async (q, type) =>
        (await graph.search(q, type)).map((n) => ({ type: n.type, id: n.id, title: n.title })),
      lookup: async (id) => {
        const n = await graph.lookup(id);
        if (!n) return null;
        const base = { type: n.type, id: n.id, title: n.title };
        if (n.type === 'task') {
          const t = tasksRef.current.byId(id);
          if (t) return { ...base, status: t.status, dueAt: t.dueAt, reminders: t.reminders };
          return { ...base, status: n.status ?? null };
        }
        return base;
      },
    }),
    [graph],
  );

  // File embedding (PLAN §6.9): the Attach button opens the OS-native document picker.
  const documentSource = useNativeDocumentSource();

  // Empty `[[label]]` links: double-tapping one opens a quick-create dialog that makes a
  // note/task and swaps in a real chip (via the editor's imperative handle).
  const editorRef = useRef<EditorController>(null);
  const quickCreate = useQuickCreateLink(editorRef);

  // Drawing over the note (PLAN-drawing.md): the pen is a nav bar action; while drawing, the
  // drawing bar sits under the note and the editor takes touches and the Pencil as ink.
  const ink = useNoteInk(noteId);
  const [drawing, setDrawing] = useState(false);
  const [tool, setTool] = useDrawingTool();
  const [inkState, setInkState] = useState<InkState | null>(null);
  const inkTool = drawing ? tool : null;

  // Clicking a chip pushes its target onto the stack (tasks and notes have screens).
  const onOpenRef = useCallback(
    (ref: LinkRef) => {
      if (ref.type === 'task') nav.push('TaskEditor', { id: ref.id });
      else if (ref.type === 'note') nav.push('NoteEditor', { id: ref.id });
      else if (ref.type === 'canvas') nav.push('Canvas', { id: ref.id });
    },
    [nav],
  );

  // Memoized so parent re-renders (title state, optimistic store updates) don't reload
  // the WebView; it's built once from the initial content and reports edits back out.
  const body = useMemo(
    () => (
      <Editor
        key={seed.key}
        ref={editorRef}
        markdown={seed.content}
        onChangeMarkdown={onChangeMarkdown}
        linkSource={linkSource}
        documentSource={documentSource}
        onOpenRef={onOpenRef}
        onQuickCreate={quickCreate.onQuickCreate}
        ink={{
          groups: ink.groups,
          tool: inkTool,
          onSave: ink.save,
          onDelete: ink.remove,
          onStateChange: setInkState,
          onExitRequest: () => setDrawing(false),
        }}
      />
    ),
    [seed.key, seed.content, onChangeMarkdown, linkSource, documentSource, onOpenRef, quickCreate.onQuickCreate, ink.groups, ink.save, ink.remove, inkTool],
  );

  // Deps exclude note/store so content edits don't re-run setOptions; only the title
  // (shown in the header) does.
  useLayoutEffect(() => {
    nav.setOptions({
      title: title || 'Untitled',
      headerRight: () => (
        <NavActions>
          <NavAction icon="folder" label="Add to projects" onPress={() => setShowProjects(true)} />
          <NavAction icon="pen" label={drawing ? 'Stop drawing' : 'Draw on note'} active={drawing} onPress={() => setDrawing((v) => !v)} />
          <NavAction icon="graph" label="Show note graph" onPress={() => nav.navigate('NoteGraph', { id: noteId })} />
          <NavAction icon="panelRight" label="Show metadata" onPress={() => setShowMeta(true)} />
          <NavAction icon="trash" label="Delete note" onPress={() => setConfirmDelete(true)} />
        </NavActions>
      ),
    });
  }, [nav, noteId, title, drawing]);

  if (!note) {
    return (
      <Center>
        <Text tone="tertiary">This note is gone.</Text>
      </Center>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.title, { paddingHorizontal: windowWidth > 640 ? 28 : 20 }]}>
        <Text variant="mono" tone="quaternary" style={styles.edited}>
          edited {timeAgo(note.updatedAt)}
        </Text>
        {/* Wraps onto more lines rather than scrolling; 20px under touch density. */}
        <DocTitleField
          value={title}
          placeholder="Untitled"
          onChangeText={(t) => {
            setTitle(t);
            store.save(noteId, { title: t });
          }}
        />
      </View>
      {body}
      {drawing ? (
        <DrawingBar
          tool={tool}
          onChange={setTool}
          state={inkState}
          onUndo={() => editorRef.current?.inkUndo()}
          onRedo={() => editorRef.current?.inkRedo()}
          onDone={() => setDrawing(false)}
        />
      ) : null}
      {quickCreate.dialog}
      {showProjects ? (
        <MembershipPicker entityType="note" entityId={noteId} onClose={() => setShowProjects(false)} />
      ) : null}
      {showMeta ? (
        <NoteMetadataSheet
          objectTypeId={note.objectTypeId}
          props={note.props}
          onSetType={(typeId) => void store.update(noteId, { objectTypeId: typeId })}
          onClearType={() => void store.update(noteId, { clearObjectType: true, props: {} })}
          onChangeProps={(next) => void store.update(noteId, { props: next })}
          onClose={() => setShowMeta(false)}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete note?"
          message="This note moves to the Trash and is permanently deleted after 30 days. You can restore it from the Trash until then."
          confirmLabel="Delete note"
          onConfirm={async () => {
            await storeRef.current.remove(noteId);
            nav.goBack();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
      {guard.conflict ? (
        <NoteConflictDialog
          kind={guard.conflict}
          onDiscard={guard.discard}
          onSaveAsNew={guard.saveAsNewNote}
          onRestore={guard.restore}
        />
      ) : null}
    </View>
  );
}

// A bottom sheet holding the object type selector + its structured-props form (PLAN §6.3).
// The note body is a full-screen WebView, so unlike the task editor (which shows metadata
// inline) mobile notes surface it in a sheet toggled from the nav bar. It stays in the
// screen's own view tree (not a Modal) so the type menu it opens layers over it.
function NoteMetadataSheet({
  objectTypeId,
  props,
  onSetType,
  onClearType,
  onChangeProps,
  onClose,
}: {
  objectTypeId?: string | null;
  props?: ObjectProps;
  onSetType: (typeId: string) => void;
  onClearType: () => void;
  onChangeProps: (next: ObjectProps) => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.sheetLayer}>
      <SheetSurface onClose={onClose} maxHeight="80%">
        <View style={styles.sheetHeader}>
          <Text variant="title" style={styles.sheetTitle}>
            Metadata
          </Text>
          <IconButton label="Close" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
        <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
          <ArchetypeChip
            kind="note"
            objectTypeId={objectTypeId}
            onSetType={onSetType}
            onClearType={onClearType}
          />
          <ObjectMetadataPanel objectTypeId={objectTypeId} props={props} onChangeProps={onChangeProps} />
        </ScrollView>
      </SheetSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceCard },
  // Centered in the same 720px column as the editor body (.pm-wrap in
  // packages/editor/src/styles.ts), with its 20px / 28px inset (wider above 640px), so the
  // title lines up with the content beneath it on a phone and an iPad alike.
  title: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingTop: space.lg },
  edited: { marginBottom: space.md },
  sheetLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingBottom: space.md },
  sheetTitle: { flex: 1 },
  sheetBody: { gap: space.lg, paddingBottom: space.md },
});
