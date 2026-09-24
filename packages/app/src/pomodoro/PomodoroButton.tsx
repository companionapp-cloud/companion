import { pomodoroRemainingMs } from "@companion/core-bridge";
import { Icon, IconButton, type IconButtonSize, colors } from "@companion/design-system";
import { useCore } from "../CoreContext";
import { formatCountdown, pomodoroHost } from "./host";
import { usePomodoro } from "./usePomodoro";
import { usePomodoroEnabled } from "./usePomodoroEnabled";

/** The stopwatch in a task's toolbar: starts a pomodoro on the task, moves the running one over
 *  to it, or — while it's already on this task — brings up the timer. Only where a shell hosts the timer (the desktop app), and
 *  only once the tool is switched on in Settings › Tools. */
export function PomodoroButton({ taskId, done, size, glyph }: { taskId: string; done: boolean; size?: IconButtonSize; glyph: number }) {
  const { enabled } = usePomodoroEnabled();
  if (!enabled || done) return null;
  return <PomodoroButtonInner taskId={taskId} size={size} glyph={glyph} />;
}

function PomodoroButtonInner({ taskId, size, glyph }: { taskId: string; size?: IconButtonSize; glyph: number }) {
  const { pomodoro } = useCore();
  const { state, now, apply } = usePomodoro();
  const running = state?.running?.taskId === taskId ? state.running : null;

  const onPress = () => {
    if (running) {
      pomodoroHost()?.showTimer();
      return;
    }
    pomodoro.start(taskId).then(apply, (err) => console.warn("pomodoro: start", err));
  };

  const label = running
    ? `Pomodoro running, ${formatCountdown(pomodoroRemainingMs(running, now))} left — show timer`
    : state?.running?.taskId
      ? "Move the running pomodoro to this task"
      : state?.running
        ? "Continue the pomodoro with this task"
        : "Start a pomodoro";
  return (
    <IconButton label={label} size={size} active={!!running} onPress={onPress}>
      <Icon name="timer" size={glyph} color={running ? colors.textAccent : colors.textSecondary} />
    </IconButton>
  );
}
