import { useMemo } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { documentsApi } from '@companion/core-bridge';
import { useCore } from '@companion/app';
import type { DocumentSource } from '@companion/editor';

// The mobile document embed provider (PLAN §6.9). Ingestion is host-initiated: tapping the
// editor's Attach button opens the OS-native document picker, the chosen file is staged into
// the on-device blob store by the core (documents.ingestFile), and only the new id crosses
// into the WebView editor. Rendering reads the stored bytes back by path and hands the
// WebView a data URL, since it can't reach the filesystem itself.
//
// Data URLs are simplest and work for typical images/short audio; very large files are a
// known limitation (they cross the RN bridge as a base64 string). A local file server is the
// documented upgrade.
export function useNativeDocumentSource(): DocumentSource {
  const { core } = useCore();
  return useMemo<DocumentSource>(() => {
    const documents = documentsApi(core);
    return {
      resolveUrl: async (id) => {
        const info = await documents.localPath(id);
        if (!info.present || !info.path) return null;
        try {
          const base64 = await FileSystem.readAsStringAsync(fileUri(info.path), {
            encoding: FileSystem.EncodingType.Base64,
          });
          const mime = info.mime || 'application/octet-stream';
          return { url: `data:${mime};base64,${base64}`, mime, filename: info.filename };
        } catch {
          return null;
        }
      },
      pick: async () => {
        const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        if (res.canceled || !res.assets?.length) return null;
        const asset = res.assets[0];
        const path = toFsPath(asset.uri);
        const doc = await documents.ingestFile(path, asset.name ?? 'file', asset.mimeType ?? '');
        return { id: doc.id, filename: doc.filename };
      },
    };
  }, [core]);
}

// The core returns a plain filesystem path (from the blob store); expo-file-system reads a
// file:// URI.
function fileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

// The document picker hands back a file:// URI; the core's ingestFile wants a plain path
// (gomobile opens it with os.Open), mirroring core.ts's toFsPath for the database path.
function toFsPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}
