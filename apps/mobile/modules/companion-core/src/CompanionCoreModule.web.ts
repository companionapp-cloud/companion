import { registerWebModule, NativeModule } from 'expo';

import { CompanionCoreModuleEvents } from './CompanionCore.types';

// Web has no gomobile core — it runs the WASM bridge (@companion/core-bridge/wasm)
// instead. This stub exists only so imports resolve on web; calling it is a bug.
class CompanionCoreModule extends NativeModule<CompanionCoreModuleEvents> {
  initialize(_dbPath: string): void {
    throw new Error('CompanionCore is native-only; use the WASM bridge on web');
  }
  async invoke(_method: string, _payloadJson: string): Promise<string> {
    throw new Error('CompanionCore is native-only; use the WASM bridge on web');
  }
}

export default registerWebModule(CompanionCoreModule, 'CompanionCoreModule');
