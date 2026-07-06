import { Paths } from 'expo-file-system';
import { createNativeBridge } from '@companion/core-bridge/native';
import type { CoreBridge } from '@companion/core-bridge';
import CompanionCore from '../modules/companion-core';

// The on-device core is opened once per process and shared. The foreground app and the
// background reminder task both go through openCore() so, when the task happens to run in
// the live app's JS runtime, they don't initialize (and lock) the SQLite file twice. When
// the app is killed and the task runs headless, it's a fresh process and opens its own.
let bridge: CoreBridge | null = null;

// gomobile's Core.New wants a filesystem path, not a file:// URI.
function toFsPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

export function openCore(): CoreBridge {
  if (bridge) return bridge;
  const dbPath = `${toFsPath(Paths.document.uri).replace(/\/$/, '')}/companion.db`;
  CompanionCore.initialize(dbPath);
  bridge = createNativeBridge({ module: CompanionCore, emitter: CompanionCore });
  return bridge;
}
