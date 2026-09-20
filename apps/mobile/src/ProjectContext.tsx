import { createContext, useContext } from 'react';

/** The project a screen is scoped to, or null for the global (all-items) view. The
 * project-scoped tab navigator provides an id; global section screens leave it null.
 * Screens like the notes list read this to filter to a project's members and to add
 * newly-created items to that project. */
export const ProjectContext = createContext<string | null>(null);

export function useProjectScope(): string | null {
  return useContext(ProjectContext);
}

/** The area a screen is scoped to (PLAN-areas.md §2), provided by the area's tab navigator. An
 * area-scoped list shows the area's whole tree — what is filed directly in it plus what its
 * projects hold — and files what it creates in the area itself. */
export const AreaContext = createContext<string | null>(null);

export function useAreaScope(): string | null {
  return useContext(AreaContext);
}
