import { useRef } from "react";
import { View } from "react-native";
import { useNav } from "../nav-context";
import { useDropTarget } from "../DndContext";
import { useCanvasHost } from "./useCanvasHost";
import { useCanvases } from "./CanvasesProvider";
import type { CanvasRefKind } from "./host";
import { CanvasView, type CanvasViewHandle } from "./CanvasView.web";
import { useTourAnchor } from "../onboarding/anchors";

/** Web/desktop canvas editor: the React Flow view straight in the DOM over the shared
 *  host (PLAN-canvases.md §3.2). Also a drop target for the app's drag layer, so a note or
 *  task dragged from the toolbar tab strip lands on the board as a card under the pointer. */
export function CanvasEditor({ canvasId, onOpenRef }: { canvasId: string; onOpenRef?: (ref: { type: CanvasRefKind; id: string }) => void }) {
  const nav = useNav();
  const store = useCanvases();
  const view = useRef<CanvasViewHandle>(null);
  const { host, dialogs } = useCanvasHost({
    onOpenRef: (ref) => {
      if (onOpenRef) return onOpenRef(ref);
      if (ref.type === "note" || ref.type === "task") nav.openInNewTab({ kind: ref.type, id: ref.id });
      else nav.goView("calendar");
    },
    onNewCanvas: () => {
      void store.create().then((c) => nav.openCanvas(c.id));
    },
  });
  // The board's add tools, for the canvases tutorial to point at.
  const toolsRef = useTourAnchor("canvas.tools");
  const drop = useDropTarget(
    `canvas:${canvasId}`,
    (payload, x, y) => {
      if (payload.kind === "note" || payload.kind === "task") view.current?.addRefAt({ type: payload.kind, id: payload.id }, x, y);
    },
    // A card dragged off this board by its grip isn't added back to it.
    { accepts: (payload) => (payload.kind === "note" || payload.kind === "task") && payload.source !== `canvas:${canvasId}` },
  );

  return (
    <View ref={drop.ref} style={{ flex: 1, minHeight: 0 }}>
      <CanvasView ref={view} host={host} canvasId={canvasId} toolsRef={toolsRef} />
      {dialogs}
    </View>
  );
}
