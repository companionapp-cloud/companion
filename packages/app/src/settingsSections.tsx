import type { ComponentType } from "react";
import type { IconName } from "@companion/design-system";
import { SyncSettings } from "./SyncSettings";
import { LlmSettings } from "./LlmSettings";
import { ObjectTypeSettings } from "./ObjectTypeSettings";
import { ToolSettings } from "./ToolSettings";
import { CalendarSettings } from "./CalendarSettings";

export type SettingsSectionId = "sync" | "ai" | "objects" | "calendar" | "tools";

/** One entry in the settings navigation list (PLAN §3.1 shell). Each section is a
 *  self-contained component that reads its own data through the app providers, so the
 *  same registry drives the desktop master-detail page and the mobile list → detail. */
export interface SettingsSectionDef {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: IconName;
  Component: ComponentType;
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
];

export function settingsSection(id: SettingsSectionId): SettingsSectionDef {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0];
}
