import { createContext, useContext, type ReactNode } from "react";
import type { DocumentSource } from "@companion/editor";

// The platform's document embed provider (PLAN §6.9). It's built in the shell — it needs the
// platform blob store (OPFS on web) plus the documents.* core API — and distributed here so
// the note editor can offer file embedding without knowing the platform. Undefined on shells
// that don't support it yet (e.g. native), where the editor degrades to filename chips.
const DocumentSourceCtx = createContext<DocumentSource | undefined>(undefined);

export function DocumentSourceProvider({
  documentSource,
  children,
}: {
  documentSource?: DocumentSource;
  children: ReactNode;
}) {
  return <DocumentSourceCtx.Provider value={documentSource}>{children}</DocumentSourceCtx.Provider>;
}

/** The document embed provider, or undefined when the platform doesn't supply one. */
export function useDocumentSource(): DocumentSource | undefined {
  return useContext(DocumentSourceCtx);
}
