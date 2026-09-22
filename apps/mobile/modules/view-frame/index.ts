import { requireOptionalNativeModule } from 'expo';

// Thin wrapper over the iOS-only ViewFrame module: a view's box in its window, measured by UIKit.
// The optional require yields null elsewhere, and measureViewInWindow then answers undefined so
// the caller falls back to React Native's own measureInWindow.

interface ViewFrameNativeModule {
  measureInWindow(tag: number): Promise<number[] | null>;
}

const ViewFrame = requireOptionalNativeModule<ViewFrameNativeModule>('ViewFrame');

export type ViewBox = { x: number; y: number; w: number; h: number };

/** The view's box in window points; null when it isn't on screen, undefined without the module. */
export async function measureViewInWindow(tag: number): Promise<ViewBox | null | undefined> {
  if (!ViewFrame) return undefined;
  const r = await ViewFrame.measureInWindow(tag);
  if (!r || r.length < 4) return null;
  return { x: r[0], y: r[1], w: r[2], h: r[3] };
}
