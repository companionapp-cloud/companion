import { createContext, useCallback, useContext, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

// Tour anchors: the elements a tour step can spotlight. A screen marks an element with
// <TourAnchor id="…"> (or the hook, for a View it already renders) and the registry keeps the
// mounted nodes by id. Nothing here re-renders when a tour starts or moves; the overlay reads
// the registry and measures the nodes itself. Outside the desktop shell there is no registry,
// so anchors cost nothing there (the mobile screens share several of these components).
//
// One id can have several nodes: every desktop tab's surface stays mounted (a background tab is
// display:none and measures empty), and a native stack keeps the screens under the top one. So
// nodes come newest first, and the overlay takes the first that is on screen: on a phone the
// newest mount is the screen on top.

export interface AnchorRegistry {
  /** Register a node under an id; returns the unregister function. */
  add: (id: string, node: unknown) => () => void;
  /** Every mounted node for an id, newest first. */
  nodes: (id: string) => unknown[];
}

export function createAnchorRegistry(): AnchorRegistry {
  const byId = new Map<string, Set<unknown>>();
  return {
    add: (id, node) => {
      let set = byId.get(id);
      if (!set) byId.set(id, (set = new Set()));
      set.add(node);
      return () => {
        set.delete(node);
        if (set.size === 0 && byId.get(id) === set) byId.delete(id);
      };
    },
    nodes: (id) => [...(byId.get(id) ?? [])].reverse(),
  };
}

export const AnchorRegistryContext = createContext<AnchorRegistry | null>(null);

/** A ref callback that registers the element it is attached to as tour anchor `id`. Returns a
 *  cleanup, React 19 style, so the node unregisters when it unmounts. A no-op outside a tour host. */
export function useTourAnchor(id: string): (node: unknown) => (() => void) | undefined {
  const registry = useContext(AnchorRegistryContext);
  return useCallback(
    (node: unknown) => {
      if (!registry || !node) return undefined;
      return registry.add(id, node);
    },
    [registry, id],
  );
}

/** A View that registers itself as tour anchor `id`. Pass the style the element would have had,
 *  so wrapping it leaves the layout alone. */
export function TourAnchor({ id, style, children }: { id: string; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const ref = useTourAnchor(id);
  return (
    <View ref={ref as never} style={style} {...unflattened}>
      {children}
    </View>
  );
}

// Native flattens layout-only Views away, which would leave nothing to measure. Not in this RN
// typing, hence the cast; web ignores it.
const unflattened = { collapsable: false } as Record<string, unknown>;

/** A rectangle in window coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The on-screen box of a node, or null when it isn't laid out (unmounted, or inside a hidden
 *  tab). Web only, where a View's ref is its DOM element; native measures asynchronously
 *  (`measureAnchors`). */
export function rectOf(node: unknown): Rect | null {
  const el = node as { getBoundingClientRect?: () => DOMRect; isConnected?: boolean } | null;
  if (!el || typeof el.getBoundingClientRect !== "function" || el.isConnected === false) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The visible box of an anchor: the first of its nodes that is on screen. */
export function anchorRect(registry: AnchorRegistry, id: string): Rect | null {
  for (const node of registry.nodes(id)) {
    const r = rectOf(node);
    if (r) return r;
  }
  return null;
}

/** The box around several anchors (a step can spotlight two controls at once); null when none
 *  of them is on screen. */
export function unionRect(registry: AnchorRegistry, ids: readonly string[]): Rect | null {
  let out: Rect | null = null;
  for (const id of ids) {
    const r = anchorRect(registry, id);
    if (!r) continue;
    if (!out) {
      out = r;
      continue;
    }
    const x = Math.min(out.x, r.x);
    const y = Math.min(out.y, r.y);
    out = { x, y, w: Math.max(out.x + out.w, r.x + r.w) - x, h: Math.max(out.y + out.h, r.y + r.h) - y };
  }
  return out;
}

/** Scroll an anchor's node into view if it sits outside its scroller (web only). */
export function revealAnchor(registry: AnchorRegistry, id: string): void {
  for (const node of registry.nodes(id)) {
    if (!rectOf(node)) continue;
    const el = node as { scrollIntoView?: (opts: ScrollIntoViewOptions) => void };
    el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return;
  }
}

/** Native: the box around several anchors, measured in window coordinates. Each anchor is its
 *  newest node that has a size. */
export async function measureAnchors(registry: AnchorRegistry, ids: readonly string[]): Promise<Rect | null> {
  const boxes: Rect[] = [];
  for (const id of ids) {
    for (const node of registry.nodes(id)) {
      const r = await measureInWindow(node);
      if (r) {
        boxes.push(r);
        break;
      }
    }
  }
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Measures a node for the native app: its box in window points, null when it isn't on screen, or
 *  undefined to leave it to React Native's measureInWindow. */
export type TourMeasurer = (node: unknown) => Promise<Rect | null | undefined>;

let tourMeasurer: TourMeasurer | null = null;

/** The iOS app measures with UIKit (apps/mobile/src/tourMeasure.ts): React Native reads the shadow
 *  tree, which puts an item in a native stack header at the window's top-left corner. */
export function setTourMeasurer(fn: TourMeasurer | null): void {
  tourMeasurer = fn;
}

async function measureInWindow(node: unknown): Promise<Rect | null> {
  if (tourMeasurer) {
    const r = await tourMeasurer(node);
    if (r !== undefined) return r && (r.w > 0 || r.h > 0) ? r : null;
  }
  const view = node as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
  if (!view || typeof view.measureInWindow !== "function") return null;
  return new Promise((resolve) => {
    view.measureInWindow!((x, y, w, h) => resolve(w > 0 || h > 0 ? { x, y, w, h } : null));
  });
}
