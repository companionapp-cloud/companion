import { useEffect, useState } from "react";
import type { AiStatus } from "@companion/core-bridge";
import { useCore } from "../CoreContext";

/** Whether the note editor's writing assists can run on this device ("AI is enabled": an agent
 *  this device can reach, with its key). Follows agents being installed, removed or going
 *  offline. Null until the first answer. */
export function useAiStatus(): AiStatus | null {
  const { ai, agents } = useCore();
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      ai
        .status()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus({ enabled: false }));
    void load();
    const off = agents.onChanged(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, [ai, agents]);
  return status;
}
