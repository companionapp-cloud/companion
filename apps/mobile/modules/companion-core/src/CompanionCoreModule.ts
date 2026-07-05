import { NativeModule, requireNativeModule } from 'expo';

import { CompanionCoreModuleEvents } from './CompanionCore.types';

// The native module (Swift/Kotlin) that wraps the gomobile-bound Go core. Instances
// are EventEmitters, so this object doubles as both the `module` and `emitter` that
// `@companion/core-bridge/native`'s createNativeBridge expects.
declare class CompanionCoreModule extends NativeModule<CompanionCoreModuleEvents> {
  /** Open (or create) the SQLite database at `dbPath`. Call once before `invoke`. */
  initialize(dbPath: string): void;
  /** Dispatch a core method; resolves to the JSON-encoded result string. */
  invoke(method: string, payloadJson: string): Promise<string>;
}

export default requireNativeModule<CompanionCoreModule>('CompanionCore');
