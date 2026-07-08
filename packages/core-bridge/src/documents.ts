import type { CoreBridge, Document } from "./types";

/** Metadata for a new document (PLAN §6.9). The shell has already staged the bytes into the
 *  blob store and computed sha256/size; the core only records this row. */
export interface CreateDocumentInput {
  filename: string;
  /** MIME type; defaults to application/octet-stream when empty. */
  mime?: string;
  size: number;
  /** Lowercase 64-char hex content address returned by the blob store's put(). */
  sha256: string;
}

/** Result of documents.ensureLocal: whether the bytes are present locally after a possible
 *  lazy download, plus the content address so the shell can resolve a render URL from its
 *  own blob store (PLAN §6.9). Bytes never cross the bridge — only this answer does. */
export interface EnsureLocalResult {
  present: boolean;
  downloaded: boolean;
  sha256: string;
}

/** Result of documents.localPath: the absolute filesystem path to a present document's bytes,
 *  for shells that render from a file rather than a URL (mobile reads the path and hands the
 *  WebView a data URL). `path` is empty when the bytes aren't present locally. Filesystem blob
 *  store only (desktop/mobile). */
export interface LocalPathResult {
  present: boolean;
  path: string;
  sha256: string;
  mime: string;
  filename: string;
}

/** Result of documents.dataUrl: a present document's bytes as a base64 data URL (desktop),
 *  ready for an <img>/<audio> src or download link. `url` is absent when the bytes aren't
 *  present locally. */
export interface DataUrlResult {
  present: boolean;
  url?: string;
  mime?: string;
  filename?: string;
}

/** Typed wrappers over the documents.* core methods (PLAN §6.9). A document is a file embed
 *  in a note: metadata syncs here while its bytes live in the platform BlobStore. Deleting a
 *  document moves it to the Trash (like notes/tasks); restore / delete-forever go through the
 *  trash.* API. */
export function documentsApi(core: CoreBridge) {
  return {
    list: () => core.invoke<Document[]>("documents.list"),
    get: (id: string) => core.invoke<Document>("documents.get", { id }),
    /** Record a new document from already-staged bytes (see BlobStore.put). */
    create: (input: CreateDocumentInput) => core.invoke<Document>("documents.create", input),
    /** Rename a document (its only mutable field — the bytes are immutable). */
    rename: (id: string, filename: string) => core.invoke<Document>("documents.rename", { id, filename }),
    /** Move a document to the Trash. */
    remove: (id: string) => core.invoke<{ ok: boolean }>("documents.delete", { id }),
    /** Ensure a document's bytes are present locally, downloading lazily on first render. */
    ensureLocal: (id: string) => core.invoke<EnsureLocalResult>("documents.ensureLocal", { id }),
    /** Stage a file at a native filesystem path (from an OS picker) into a new document
     *  (mobile). The core hashes + stores the bytes; only metadata is created here. */
    ingestFile: (path: string, filename: string, mime: string) =>
      core.invoke<Document>("documents.ingestFile", { path, filename, mime }),
    /** Stage base64-encoded bytes into a new document (desktop: the webview has a File but no
     *  filesystem path, so it sends the bytes over the invoke bridge). */
    ingestBytes: (data: string, filename: string, mime: string) =>
      core.invoke<Document>("documents.ingestBytes", { data, filename, mime }),
    /** Ensure a document's bytes are local and return their filesystem path (mobile), for a
     *  shell that reads the file to render it. */
    localPath: (id: string) => core.invoke<LocalPathResult>("documents.localPath", { id }),
    /** Ensure a document's bytes are local and return them as a base64 data URL (desktop),
     *  for a webview that can't reach the filesystem. */
    dataUrl: (id: string) => core.invoke<DataUrlResult>("documents.dataUrl", { id }),
  };
}

export type DocumentsApi = ReturnType<typeof documentsApi>;
