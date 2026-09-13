import type { ReactNode } from "react";

/** Native variant of Overlay (see Overlay.web.tsx): there is no DOM to portal into, and an
 *  absolutely-positioned scrim inside a full-screen route already covers the screen, so the
 *  children render in place. */
export function Overlay({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
