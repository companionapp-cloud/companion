import { useCallback, useEffect, useState } from "react";
import { useCore } from "../CoreContext";
import { POMODORO_ENABLED_EVENT, pomodoroHost } from "./host";

/** Whether the pomodoro tool is available here (a shell hosts the timer) and switched on for
 *  this device. Kept in step across windows by the shell's POMODORO_ENABLED_EVENT. */
export function usePomodoroEnabled() {
  const { core } = useCore();
  const host = pomodoroHost();
  const [enabled, setEnabledState] = useState(false);
  // Whether the setting has been read yet, so a surface that changes shape with it can wait.
  const [ready, setReady] = useState(host == null);

  useEffect(() => {
    if (!host) return;
    let live = true;
    host.isEnabled().then(
      (on) => {
        if (!live) return;
        setEnabledState(on);
        setReady(true);
      },
      (err) => {
        console.warn("pomodoro: read setting", err);
        if (live) setReady(true);
      },
    );
    const off = core.on(POMODORO_ENABLED_EVENT, (payload) => {
      setEnabledState(!!(payload as { enabled?: boolean } | null)?.enabled);
    });
    return () => {
      live = false;
      off();
    };
  }, [core, host]);

  const setEnabled = useCallback(
    (on: boolean) => {
      if (!host) return;
      setEnabledState(on);
      host.setEnabled(on).then(setEnabledState, (err) => {
        console.warn("pomodoro: save setting", err);
        setEnabledState(!on);
      });
    },
    [host],
  );

  return { available: host != null, ready, enabled: host != null && enabled, setEnabled };
}
