import { Center, Icon, SplitView, Text, colors } from "@companion/design-system";
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
      defaultWidth={220}
      minWidth={180}
      maxWidth={360}
      aside={<CanvasesList selectedId={canvasId ?? null} onSelect={nav.openCanvas} onCreate={() => void create()} />}
    >
      {canvasId ? (
        <CanvasPane key={canvasId} canvasId={canvasId} onDeleted={() => nav.goView("canvases")} />
      ) : (
        <Center style={{ backgroundColor: colors.surfaceCard }}>
          <Icon name="canvas" size={18} color={colors.textQuaternary} />
          <Text variant="title">Nothing selected</Text>
          <Text variant="caption" tone="tertiary" style={{ maxWidth: 300, textAlign: "center", lineHeight: 18 }}>
            Pick a canvas from the list, or start a new one.
          </Text>
        </Center>
      )}
    </SplitView>
  );
}
