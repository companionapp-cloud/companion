import type { ComponentType } from "react";
import type { IconName } from "@companion/design-system";
import { SyncSettings } from "./SyncSettings";
import { LlmSettings } from "./LlmSettings";
import { ObjectTypeSettings } from "./ObjectTypeSettings";
import { ToolSettings } from "./ToolSettings";
import { CalendarSettings } from "./CalendarSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { shortcutStore } from "./shortcuts";

export type SettingsSectionId = "sync" | "ai" | "objects" | "calendar" | "tools" | "shortcuts";

/** One entry in the settings navigation list (PLAN §3.1 shell). Each section is a
 *  self-contained component that reads its own data through the app providers, so the
 *  same registry drives the desktop master-detail page and the mobile list → detail. */
export interface SettingsSectionDef {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: IconName;
  Component: ComponentType;
  /** Sections that only apply to some shells (e.g. global shortcuts, which only the
   *  desktop app can register) gate themselves here. Omitted means "always shown". */
  available?: () => boolean;
}

export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  {
    id: "sync",
    label: "Sync",
    description: "Connect to a server and sync across devices",
    icon: "link",
    Component: SyncSettings,
  },
  {
    id: "ai",
    label: "AI",
    description: "Local and cloud LLM providers",
    icon: "chat",
    Component: LlmSettings,
  },
  {
    id: "objects",
    label: "Objects",
    description: "Archetypes that give notes and tasks structured fields",
    icon: "file",
    Component: ObjectTypeSettings,
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "Subscribe to ICS calendar feeds",
    icon: "calendar",
    Component: CalendarSettings,
  },
  {
    id: "tools",
    label: "Tools",
    description: "Which tools show in the sidebar on this device",
    icon: "panelLeft",
    Component: ToolSettings,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "System-wide keyboard shortcuts on this device",
    icon: "code",
    Component: ShortcutSettings,
    // Desktop only: a browser tab or a phone can't register an OS-wide hotkey, so the
    // section appears exactly where a shell injected a store to bind them through.
    available: () => shortcutStore() !== null,
  },
];

/** The sections to render in this shell — {@link SETTINGS_SECTIONS} minus the ones that
 *  don't apply here. Call at render time: availability depends on what the shell injected
 *  at startup, so this must not be hoisted into a module-level constant. */
export function visibleSettingsSections(): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter((s) => !s.available || s.available());
}

export function settingsSection(id: SettingsSectionId): SettingsSectionDef {
  const sections = visibleSettingsSections();
  return sections.find((s) => s.id === id) ?? sections[0];
}
