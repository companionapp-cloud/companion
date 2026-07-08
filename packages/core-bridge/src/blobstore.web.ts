// Web blob store for document bytes (PLAN §6.9): content-addressed storage in the Origin
// Private File System (OPFS) plus fetch-based transfer to/from the server's blob endpoints.
// This is the web counterpart to the Go FSStore on desktop/mobile. It runs on the main
// thread using OPFS's async file API (no cross-origin-isolation headers required — unlike
// the OPFS *sync* access handle wa-sqlite would need), so raw bytes never cross the JS↔wasm
// bridge: the Go core only calls has/upload/download/delete, and the shell uses put/read/
// objectUrl to ingest and render.

/** The blob store the shell injects into the wasm core and uses for ingest/render. The Go
 *  core calls only has/upload/download/delete (PLAN §6.9); put/read/objectUrl are for the
 *  UI (staging a picked file, rendering an embed). */
export interface WebBlobStore {
  /** Is the blob for sha256 present in OPFS? */
  has(sha256: string): Promise<boolean>;
  /** Stream the local bytes for sha256 to the server (PUT url, bearer token). */
  upload(sha256: string, url: string, token: string): Promise<void>;
  /** Fetch sha256's bytes from the server (GET url) into OPFS, verifying the content hash. */
  download(sha256: string, url: string, token: string): Promise<void>;
  /** Remove the local bytes for sha256 (idempotent). */
  delete(sha256: string): Promise<void>;
  /** Stage bytes into OPFS, returning their content address and size (shell ingest). */
  put(data: Blob | ArrayBuffer | Uint8Array): Promise<{ sha256: string; size: number }>;
  /** Read a blob back as a File/Blob, or null if absent (shell render). */
  read(sha256: string): Promise<Blob | null>;
  /** An object URL for a stored blob, or null if absent. The caller must revokeObjectURL. */
  objectUrl(sha256: string): Promise<string | null>;
}

export interface OpfsBlobStoreOptions {
  /** OPFS subdirectory holding the blobs (default "blobs"). */
  dirName?: string;
}

/** Reports whether this browser can back the web blob store (OPFS + WebCrypto in a secure
 *  context). Use to degrade gracefully — documents can still sync as metadata, but bytes
 *  can't be stored or rendered locally. */
export function isWebBlobStoreAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage?.getDirectory &&
    typeof crypto !== "undefined" &&
    !!crypto.subtle
  );
}

const SHA_RE = /^[0-9a-f]{64}$/;

/** createOpfsBlobStore builds an OPFS-backed WebBlobStore. Throws if OPFS/WebCrypto are
 *  unavailable (check isWebBlobStoreAvailable first). */
export function createOpfsBlobStore(opts: OpfsBlobStoreOptions = {}): WebBlobStore {
  if (!isWebBlobStoreAvailable()) {
    throw new Error("OPFS blob store unavailable: needs a secure context with OPFS + WebCrypto");
  }
  const dirName = opts.dirName ?? "blobs";

  async function dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(dirName, { create: true });
  }

  async function toArrayBuffer(data: Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
    if (data instanceof Blob) return data.arrayBuffer();
    if (data instanceof Uint8Array) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }
    return data;
  }

  async function hashHex(buf: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function writeBlob(sha256: string, buf: ArrayBuffer): Promise<void> {
    const d = await dir();
    const handle = await d.getFileHandle(sha256, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(buf);
    } finally {
      await writable.close();
    }
  }

  async function readFile(sha256: string): Promise<File | null> {
    try {
      const d = await dir();
      const handle = await d.getFileHandle(sha256, { create: false });
      return await handle.getFile();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  const store: WebBlobStore = {
    async has(sha256) {
      return (await readFile(sha256)) !== null;
    },

    async put(data) {
      const buf = await toArrayBuffer(data);
      const sha256 = await hashHex(buf);
      if (!(await store.has(sha256))) await writeBlob(sha256, buf);
      return { sha256, size: buf.byteLength };
    },

    read: (sha256) => readFile(sha256),

    async objectUrl(sha256) {
      const file = await readFile(sha256);
      return file ? URL.createObjectURL(file) : null;
    },

    async delete(sha256) {
      try {
        const d = await dir();
        await d.removeEntry(sha256);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    async upload(sha256, url, token) {
      const file = await readFile(sha256);
      if (!file) throw new Error(`blob ${sha256} not present locally`);
      const resp = await fetch(url, {
        method: "PUT",
        body: file,
        headers: authHeaders(token, "application/octet-stream"),
      });
      if (!resp.ok) throw new Error(`blob upload ${sha256}: ${resp.status} ${await safeText(resp)}`);
    },

    async download(sha256, url, token) {
      if (!SHA_RE.test(sha256)) throw new Error(`invalid content address ${sha256}`);
      if (await store.has(sha256)) return; // idempotent
      const resp = await fetch(url, { method: "GET", headers: authHeaders(token) });
      if (!resp.ok) throw new Error(`blob download ${sha256}: ${resp.status} ${await safeText(resp)}`);
      const buf = await resp.arrayBuffer();
      const got = await hashHex(buf);
      if (got !== sha256) throw new Error(`blob download hash mismatch: got ${got} want ${sha256}`);
      await writeBlob(sha256, buf);
    },
  };
  return store;
}

function authHeaders(token: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return "";
  }
}
