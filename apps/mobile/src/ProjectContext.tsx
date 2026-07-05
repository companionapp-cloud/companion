import { createContext, useContext } from 'react';

/** The project a screen is scoped to, or null for the global (all-items) view. The
 * project-scoped tab navigator provides an id; global section screens leave it null.
 * Screens like the notes list read this to filter to a project's members and to add
 * newly-created items to that project. */
export const ProjectContext = createContext<string | null>(null);

export function useProjectScope(): string | null {
  return useContext(ProjectContext);
}
