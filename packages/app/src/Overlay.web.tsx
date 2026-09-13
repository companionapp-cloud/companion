import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Renders `children` at the document root (web). A modal rendered in place would be
 *  trapped inside whichever ancestor forms a stacking context or containing block — the
 *  toolbar's z-index, a transformed row, a clipped pane — and paint underneath the chrome.
 *  Portaling to `document.body` sidesteps all of that. Native has no such problem, so the
 *  non-web variant renders children inline. */
export function Overlay({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}
