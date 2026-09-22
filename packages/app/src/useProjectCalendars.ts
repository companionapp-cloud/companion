import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarAccount, CalendarFeed, ProjectMember } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useCalendar } from "./CalendarProvider";
import { useProjects } from "./ProjectsProvider";

// Calendars in projects (PLAN §6.6). A project holds calendars through ordinary memberships: a
// "calendar" is one calendar — a CalDAV calendar or an ICS subscription — and a
// "calendar_account" is a whole account, every calendar it has now or later. The project's
// calendar is `calendar.range` with its id: those calendars' events plus its own tasks and notes.

type CalendarMemberType = "calendar" | "calendar_account";

const isCalendarMember = (m: ProjectMember): m is ProjectMember & { entityType: CalendarMemberType } =>
  m.entityType === "calendar" || m.entityType === "calendar_account";

export interface ProjectCalendars {
  /** False until the project's memberships have loaded. */
  loaded: boolean;
  /** Accounts filed whole: every calendar they have is in the project, including ones found later. */
  accounts: CalendarAccount[];
  /** Calendars filed one by one — CalDAV calendars and ICS subscriptions. */
  calendars: CalendarFeed[];
  /** Every calendar whose events the project shows. */
  feeds: CalendarFeed[];
  /** The ones among them a new event can go in. */
  writableFeeds: CalendarFeed[];
  accountIds: ReadonlySet<string>;
  feedIds: ReadonlySet<string>;
  /** File or unfile an account or a calendar. Shown at once; reverted if the core refuses. */
  toggle: (type: CalendarMemberType, id: string) => Promise<void>;
}

/** The calendars a project holds, resolved against the calendar provider. A membership whose
 *  calendar is gone (removed on another device, not synced here yet) is left out. */
export function useProjectCalendars(projectId: string | null | undefined): ProjectCalendars {
  const { core } = useCore();
  const { membershipsForProject, addMember, removeMember } = useProjects();
  const { feeds, accounts } = useCalendar();
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  // The project the latest answer is for, so a slow reply for the previous one is dropped.
  const current = useRef(projectId);
  current.current = projectId;

  const load = useCallback(async () => {
    if (!projectId) return;
    const rows = await membershipsForProject(projectId);
    if (current.current === projectId) setMembers(rows.filter(isCalendarMember));
  }, [projectId, membershipsForProject]);

  // Fresh as memberships change here or arrive by sync — the same signals ProjectView follows.
  useEffect(() => {
    setMembers(projectId ? null : []);
    if (!projectId) return;
    const reload = () => void load().catch(() => undefined);
    reload();
    const offNav = core.on("nav.changed", reload);
    const offData = core.on("data.changed", reload);
    return () => {
      offNav();
      offData();
    };
  }, [projectId, load, core]);

  const accountIds = useMemo(
    () => new Set((members ?? []).filter((m) => m.entityType === "calendar_account").map((m) => m.entityId)),
    [members],
  );
  const feedIds = useMemo(
    () => new Set((members ?? []).filter((m) => m.entityType === "calendar").map((m) => m.entityId)),
    [members],
  );

  const toggle = useCallback(
    async (type: CalendarMemberType, id: string) => {
      if (!projectId) return;
      const on = (type === "calendar_account" ? accountIds : feedIds).has(id);
      // Optimistic: flip the row now; the reload after the core call settles it either way.
      setMembers((prev) => {
        const rest = (prev ?? []).filter((m) => !(m.entityType === type && m.entityId === id));
        if (on) return rest;
        const now = new Date().toISOString();
        return [...rest, { id: `pending:${type}:${id}`, projectId, entityType: type, entityId: id, createdAt: now, updatedAt: now, version: 0, dirty: true }];
      });
      try {
        if (on) await removeMember(projectId, type, id);
        else await addMember(projectId, type, id);
      } finally {
        await load().catch(() => undefined);
      }
    },
    [projectId, accountIds, feedIds, addMember, removeMember, load],
  );

  return useMemo(() => {
    const filedAccounts = accounts.filter((a) => accountIds.has(a.id));
    const filedCalendars = feeds.filter((f) => feedIds.has(f.id));
    const all = feeds.filter((f) => feedIds.has(f.id) || (!!f.accountId && accountIds.has(f.accountId)));
    return {
      loaded: members !== null,
      accounts: filedAccounts,
      calendars: filedCalendars,
      feeds: all,
      writableFeeds: all.filter((f) => f.kind === "caldav" && !f.readOnly),
      accountIds,
      feedIds,
      toggle,
    };
  }, [accounts, feeds, accountIds, feedIds, members, toggle]);
}
