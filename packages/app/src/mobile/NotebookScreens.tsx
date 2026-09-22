import { useMemo, useState } from "react";
import { View } from "react-native";
import { Spinner, colors } from "@companion/design-system";
import { useNav } from "../nav-context";
import { NavAction, NavBar } from "./ui";
import { NotebookShelf } from "../notebooks/NotebookShelf";
import { NotebookEditor } from "../notebooks/NotebookEditor";
import { CoverDialog } from "../notebooks/CoverDialog";
import { useNotebooks } from "../notebooks/NotebooksProvider";
import { useNotebookHost } from "../notebooks/useNotebookHost";
import { parseNotebookSection, toShelfNotebook, useShelfCoverUrls } from "../notebooks/NotebooksScreen";

// Notebooks on the mobile shell (PLAN-notebooks.md): the shelf as a pushed route, one
// notebook per row on a phone, and the editor as a full-screen route with the nav bar's back.

export function NotebooksListScreen() {
  const notebooks = useNotebooks();
  const nav = useNav();
  const [editId, setEditId] = useState<string | null>(null);
  const shelf = useMemo(() => notebooks.notebooks.map(toShelfNotebook), [notebooks.notebooks]);
  const coverUrls = useShelfCoverUrls(notebooks.notebooks);
  const open = (id: string) => nav.openRef({ kind: "view", view: "notebooks", section: id });
  const create = async () => {
    const nb = await notebooks.create();
    setEditId(nb.id);
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceApp }}>
      <NavBar title="Notebooks" right={<NavAction icon="plus" label="New notebook" onPress={() => void create()} />} />
      {notebooks.loading ? <Spinner label="Loading your notebooks…" /> : <NotebookShelf notebooks={shelf} coverUrls={coverUrls} onOpen={open} onCreate={() => void create()} onEdit={setEditId} />}
      {editId ? <CoverDialog notebookId={editId} onClose={() => setEditId(null)} /> : null}
    </View>
  );
}

export function NotebookScreen({ id }: { id: string }) {
  const notebooks = useNotebooks();
  const nav = useNav();
  const host = useNotebookHost();
  const [cover, setCover] = useState(false);
  const [nbId, initialPage] = parseNotebookSection(id);
  const nb = nbId ? notebooks.byId(nbId) : undefined;
  if (notebooks.loading) return <Spinner label="Opening your notebook…" />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceApp }}>
      <NavBar title={nb?.title || "Untitled"} right={<NavAction icon="moreH" label="Title and cover" onPress={() => setCover(true)} />} />
      <NotebookEditor key={nbId} host={host} notebookId={nbId ?? ""} onBack={nav.back} showTopBar={false} initialPage={initialPage} />
      {cover ? <CoverDialog notebookId={nbId ?? ""} onClose={() => setCover(false)} /> : null}
    </View>
  );
}
