import { createContext } from "react";
import type { CalendarItem } from "@companion/core-bridge";

/** OpenEntityContext lets wikilink chips and inline previews navigate without threading the
 *  shell's navigator through every component; each shell supplies its own handler. Types are the
 *  graph's: note, task, canvas, project. */
export const OpenEntityContext = createContext<((type: string, id: string) => void) | undefined>(undefined);

/** How an event preview opens its event. Events aren't graph entities with a screen of their own,
 *  so each shell decides: the calendar on its week (desktop), a detail screen or sheet (mobile). */
export const OpenEventContext = createContext<((event: CalendarItem) => void) | undefined>(undefined);

/** How messages are drawn. "transcript" is the desktop thread — a 640px column of avatar +
 *  mono speaker label + prose, no bubbles. "bubbles" is the touch layout the floating
 *  composer pairs with. */
export type ThreadLayout = "transcript" | "bubbles";
export const ThreadLayoutContext = createContext<ThreadLayout>("transcript");
