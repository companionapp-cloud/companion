import { createContext, useContext, type ReactNode } from "react";

/** "pointer" is the dense desktop/web metric set (24px rows, 26px controls). "touch" is
 * for phone surfaces: rows never drop below 44px and controls default to the `lg` size.
 * Type, colour, radii and mono metadata are identical in both. */
export type Density = "pointer" | "touch";

const DensityContext = createContext<Density>("pointer");

/** Sets the density for every primitive beneath it. The mobile shells mount this once
 * at their root; nothing else needs to. */
export function DensityProvider({ density, children }: { density: Density; children?: ReactNode }) {
  return <DensityContext.Provider value={density}>{children}</DensityContext.Provider>;
}

export function useDensity(): Density {
  return useContext(DensityContext);
}
