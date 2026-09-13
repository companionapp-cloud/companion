import { Center, SplitView, Text, layout } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useCanvases } from "./CanvasesProvider";
import { CanvasesList } from "./CanvasesList";
import { CanvasPane } from "./CanvasPane";

/** The root Canvases view (web/desktop): a browse column of every board beside the open
 *  board. The open board rides in the URL as /canvases/:id. */
export function CanvasesScreen() {
  const nav = useNav();
  const store = useCanvases();
  const canvasId = nav.current.kind === "canvases" ? nav.current.canvasId : undefined;

  const create = async () => {
    const c = await store.create();
    nav.openCanvas(c.id);
  };

  return (
    <SplitView
      storageKey="companion.canvases.listWidth"
      defaultWidth={layout.listW}
      minWidth={220}
      maxWidth={460}
      aside={<CanvasesList selectedId={canvasId ?? null} onSelect={nav.openCanvas} onCreate={() => void create()} />}
    >
      {canvasId ? (
        <CanvasPane key={canvasId} canvasId={canvasId} onDeleted={() => nav.goView("canvases")} />
      ) : (
        <Center>
          <Text tone="tertiary">Select a canvas, or start a new one.</Text>
        </Center>
      )}
    </SplitView>
  );
}
