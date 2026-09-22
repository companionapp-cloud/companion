import { useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Center, Spinner, Text, colors, layout, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useDocumentSource } from "../DocumentSourceContext";
import { useCoverUrl } from "../ContainerOverview";
import { NotebookShelf } from "./NotebookShelf";
import { NotebookEditor } from "./NotebookEditor";
import { CoverDialog } from "./CoverDialog";
import { useNotebooks } from "./NotebooksProvider";
import { useNotebookHost } from "./useNotebookHost";
import type { Notebook, NotebookSummary } from "@companion/core-bridge";
import type { Notebook as ShelfNotebook } from "./host";

// The notebooks tool on the desktop shell (PLAN-notebooks.md §2): a full-width shelf, and a
// full-width editor when a notebook is open. No split view. The open notebook rides in the
// tab's view `section` (the URL /notebooks/:id), the way a Settings section does.

export function parseNotebookSection(section: string | undefined): [string | undefined, number | undefined] {
  if (!section) return [undefined, undefined];
  const at = section.indexOf("@");
  if (at === -1) return [section, undefined];
  const page = Number(section.slice(at + 1));
  return [section.slice(0, at), Number.isFinite(page) && page > 0 ? page : undefined];
}

export function toShelfNotebook(n: NotebookSummary): ShelfNotebook {
  return {
    id: n.id,
    title: n.title,
    cover: n.coverDocumentId ? { kind: "image", color: n.coverColor, documentId: n.coverDocumentId } : { kind: "color", color: n.coverColor },
    guides: [],
    pageCount: n.pageCount,
    updatedAt: n.updatedAt,
  };
}

/** One cover's image URL, resolved lazily. Rendered per shelf cell so each resolves on its own. */
export function useShelfCoverUrls(notebooks: NotebookSummary[]): Record<string, string | null> {
  // Covers with images are rare enough that resolving each in its own hook instance (via
  // ShelfCover) would be cleaner, but the shelf takes a map; resolve the first handful here.
  const documentSource = useDocumentSource();
  const withImage = notebooks.filter((n) => n.coverDocumentId).slice(0, 12);
  const a = useCoverUrl(documentSource, withImage[0]?.coverDocumentId);
  const b = useCoverUrl(documentSource, withImage[1]?.coverDocumentId);
  const c = useCoverUrl(documentSource, withImage[2]?.coverDocumentId);
  const d = useCoverUrl(documentSource, withImage[3]?.coverDocumentId);
  const e = useCoverUrl(documentSource, withImage[4]?.coverDocumentId);
  const f = useCoverUrl(documentSource, withImage[5]?.coverDocumentId);
  return useMemo(() => {
    const out: Record<string, string | null> = {};
    [a, b, c, d, e, f].forEach((url, i) => {
      if (withImage[i]) out[withImage[i].id] = url;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, c, d, e, f, withImage.map((n) => n.id).join(",")]);
}

export function NotebooksScreen() {
  const nav = useNav();
  const notebooks = useNotebooks();
  const host = useNotebookHost();
  const [editId, setEditId] = useState<string | null>(null);
  // The section is the notebook id, optionally "@<page>" from a search hit.
  const [openId, initialPage] = parseNotebookSection(nav.current.kind === "view" && nav.current.view === "notebooks" ? nav.current.section : undefined);
  const open = openId ? notebooks.byId(openId) : undefined;
  const shelf = useMemo(() => notebooks.notebooks.map(toShelfNotebook), [notebooks.notebooks]);
  const coverUrls = useShelfCoverUrls(notebooks.notebooks);

  const openNotebook = (id: string) => nav.openRef({ kind: "view", view: "notebooks", section: id });
  const backToShelf = () => nav.replaceRef({ kind: "view", view: "notebooks" });
  const create = async () => {
    const nb: Notebook = await notebooks.create();
    setEditId(nb.id);
  };

  if (openId && notebooks.loading) return <Spinner label="Opening your notebook…" />;
  if (open) return <NotebookEditor key={open.id} host={host} notebookId={open.id} onBack={backToShelf} initialPage={initialPage} />;
  if (openId) {
    return (
      <Center>
        <Text tone="tertiary">This notebook is gone.</Text>
        <Button variant="ghost" size="sm" label="Back to notebooks" onPress={backToShelf} />
      </Center>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceApp }}>
      <View style={styles.topBar}>
        <Text variant="title">Notebooks</Text>
        <Text variant="mono" tone="quaternary">
          {notebooks.notebooks.length}
        </Text>
        <View style={{ flex: 1 }} />
        <Button size="sm" label="New notebook" onPress={() => void create()} />
      </View>
      {notebooks.loading ? (
        <Spinner label="Loading your notebooks…" />
      ) : (
        <NotebookShelf notebooks={shelf} coverUrls={coverUrls} onOpen={openNotebook} onCreate={() => void create()} onEdit={setEditId} />
      )}
      {editId ? <CoverDialog notebookId={editId} onClose={() => setEditId(null)} /> : null}
    </View>
  );
}

const styles = {
  topBar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: layout.toolbarH,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
};
