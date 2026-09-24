-- A pomodoro's clock can stop: paused_at is when it stopped (NULL while it runs), and
-- paused_sec is how long it has spent stopped before, which pushes its end out by as much.
-- It stops when its task is finished (until the next one is picked) or when the user pauses it.
ALTER TABLE pomodoros ADD COLUMN paused_at TEXT;
ALTER TABLE pomodoros ADD COLUMN paused_sec INTEGER NOT NULL DEFAULT 0;
