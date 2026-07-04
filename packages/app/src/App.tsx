import type { CoreBridge } from "@companion/core-bridge";
import { CoreProvider } from "./CoreContext";
import { SyncProvider } from "./SyncProvider";
import { AppShell } from "./AppShell";
import { FocusView } from "./FocusView";
import { focusNoteId } from "./focus";

/**
 * App is the shared root. The platform shell creates the CoreBridge (wasm on web,
 * HTTP on desktop) and passes it in, along with any chrome insets. SyncProvider wraps
 * everything so sync runs on load / mutation / navigation / idle. When the URL
 * requests ?note=<id>, the app renders that note in chrome-less focus mode.
 */
export function App({ core, topInset }: { core: CoreBridge; topInset?: number }) {
  const focusId = focusNoteId();
  return (
    <CoreProvider core={core}>
      <SyncProvider>
        {focusId ? <FocusView id={focusId} topInset={topInset} /> : <AppShell topInset={topInset} />}
      </SyncProvider>
    </CoreProvider>
  );
}
