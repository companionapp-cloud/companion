import type { CoreBridge } from "@companion/core-bridge";
import type { DocumentSource } from "@companion/editor";
import { CoreProvider } from "./CoreContext";
import { DocumentSourceProvider } from "./DocumentSourceContext";
import { SyncProvider } from "./SyncProvider";
import { NotesProvider } from "./NotesProvider";
import { TasksProvider } from "./TasksProvider";
import { ProjectsProvider } from "./ProjectsProvider";
import { ObjectTypesProvider } from "./ObjectTypesProvider";
import { AppShell } from "./AppShell";
import type { NotificationScheduler } from "./RemindersProvider";
import { FocusView } from "./FocusView";
import { focusTarget } from "./focus";

/**
 * App is the shared root. The platform shell creates the CoreBridge (wasm on web,
 * HTTP on desktop) and passes it in, along with any chrome insets. SyncProvider wraps
 * everything so sync runs on load / mutation / navigation / idle. When the URL requests
 * ?note=<id> or ?task=<id>, the app renders that document in chrome-less focus mode
 * (wrapped in the data providers so its editor — membership picker, dates, etc. — works).
 */
export function App({
  core,
  topInset,
  notificationScheduler,
  documentSource,
}: {
  core: CoreBridge;
  topInset?: number;
  /** Platform reminder scheduler (PLAN §6.4). Desktop/mobile shells inject a native
   *  one; omitted, RemindersProvider falls back to the best-effort web scheduler. */
  notificationScheduler?: NotificationScheduler;
  /** Platform document embed provider (PLAN §6.9): the web shell builds it from its OPFS
   *  blob store + the documents API. Omitted on shells without file embedding. */
  documentSource?: DocumentSource;
}) {
  const target = focusTarget();
  return (
    <CoreProvider core={core}>
      <DocumentSourceProvider documentSource={documentSource}>
        <SyncProvider>
        {target ? (
          <NotesProvider>
            <TasksProvider>
              <ProjectsProvider>
                <ObjectTypesProvider>
                  <FocusView target={target} topInset={topInset} />
                </ObjectTypesProvider>
              </ProjectsProvider>
            </TasksProvider>
          </NotesProvider>
        ) : (
          <AppShell topInset={topInset} notificationScheduler={notificationScheduler} />
        )}
        </SyncProvider>
      </DocumentSourceProvider>
    </CoreProvider>
  );
}
