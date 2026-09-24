-- A pomodoro is a 25-minute block that can take several tasks in turn: finishing its task
-- inside the window counts toward it and frees it for the next one (task_id goes empty until
-- one is picked). tasks_done is how many were finished in it; the pomodoro counts, when its
-- window runs out, if that is at least one.
ALTER TABLE pomodoros ADD COLUMN tasks_done INTEGER NOT NULL DEFAULT 0;
