import { useCallback, useEffect } from 'react';
import { useTasks, useProjects, useCalendar, useCore } from '@companion/app';
import { addWatchMessageListener, respondToWatch } from '../modules/watch-bridge';
import { buildWatchSnapshot, sendWatchSnapshot, watchDueAt, formatDuePreview } from './watch';

// How far ahead the watch's Calendar list looks.
const EVENT_WINDOW_DAYS = 7;

// Strip the parsed date phrase out of a title ("buy milk tomorrow" → "buy milk"); keep the
// original if removing it would leave nothing.
function stripMatched(title: string, matched: string): string {
  if (!matched) return title;
  const cleaned = title.replace(matched, '').replace(/\s+/g, ' ').trim();
  return cleaned || title;
}

// Bridges the phone's data to the watch and back. Mounted inside Tasks + Projects + Calendar
// providers so it sees the same data the UI does. Renders nothing — it's a side-effect bridge,
// iOS-only in practice (the watch-bridge module is a no-op elsewhere). See src/watch.ts.
export function WatchTasksBridge() {
  const { tasks, create, setStatus } = useTasks();
  const { projects, membershipsForProject } = useProjects();
  const { range, revision } = useCalendar();
  const { dates } = useCore();

  // Rebuild + push the snapshot to the watch. Project membership and the calendar window each
  // need an async core lookup, so this is async. Called when data changes and when the watch
  // asks for a refresh (e.g. it just launched).
  const pushSnapshot = useCallback(async () => {
    const membersByProject = new Map<string, Set<string>>();
    const now = new Date();
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + EVENT_WINDOW_DAYS);

    const [events] = await Promise.all([
      range(from.toISOString(), to.toISOString()).catch(() => []),
      Promise.all(
        projects.map(async (p) => {
          try {
            const members = await membershipsForProject(p.id);
            membersByProject.set(
              p.id,
              new Set(members.filter((m) => m.entityType === 'task').map((m) => m.entityId)),
            );
          } catch {
            // Skip a project whose membership lookup fails; its section just won't populate.
          }
        }),
      ),
    ]);

    sendWatchSnapshot(buildWatchSnapshot(tasks, projects, membersByProject, events, now));
  }, [tasks, projects, membershipsForProject, range, revision]);

  // Phone → watch: push whenever tasks, projects, or calendar change.
  useEffect(() => {
    void pushSnapshot();
  }, [pushSnapshot]);

  // Create a task from a watch quick-add. We always auto-detect a date written into the title
  // (e.g. "call bob friday 3pm") — if found, it wins and is stripped from the title. Otherwise
  // the watch's Today/Tomorrow choice is the fallback.
  const createFromWatch = useCallback(
    async (rawTitle: string, due: string) => {
      let title = rawTitle.trim();
      if (!title) return;
      let dueAt: string | undefined;
      const parsed = await dates.parse(title).catch(() => null);
      if (parsed) {
        dueAt = parsed.at;
        title = stripMatched(title, parsed.matched);
      } else if (due === 'tomorrow') {
        dueAt = watchDueAt('tomorrow');
      } else if (due === 'none') {
        dueAt = undefined; // "Someday" — no due date
      } else {
        dueAt = watchDueAt('today');
      }
      await create({ title, dueAt });
    },
    [create, dates],
  );

  // Watch → phone: react to messages from the watch.
  useEffect(() => {
    const sub = addWatchMessageListener((message) => {
      if (message.type === 'requestSnapshot') {
        void pushSnapshot();
      } else if (message.type === 'createTask') {
        const title = typeof message.title === 'string' ? message.title : '';
        const due = typeof message.due === 'string' ? message.due : 'today';
        void createFromWatch(title, due);
      } else if (message.type === 'completeTask') {
        const id = typeof message.id === 'string' ? message.id : '';
        if (id) void setStatus(id, 'done').catch(() => {});
      } else if (message.type === 'parseDate') {
        // Live Add-Task preview: parse a date out of the title and reply with a short label.
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const title = typeof message.title === 'string' ? message.title.trim() : '';
        void (async () => {
          const parsed = title ? await dates.parse(title).catch(() => null) : null;
          if (requestId) {
            respondToWatch(requestId, parsed ? { dueLabel: formatDuePreview(parsed.at) } : {});
          }
        })();
      }
    });
    return () => sub?.remove();
  }, [pushSnapshot, createFromWatch, setStatus, dates]);

  return null;
}
