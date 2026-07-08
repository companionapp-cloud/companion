import { colors } from "./tokens";

// Lucide-style outline icon paths (24x24 viewBox, 1.75 stroke, rounded caps/joins).
// Shared by the native (Icon.tsx, react-native-svg) and web (Icon.web.tsx, inline
// <svg>) implementations so the two platforms never drift.
export const ICON_PATHS = {
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  notes: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M9 13h6M9 17h4",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  today: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM12 15h.01",
  bell: "M10.3 21a1.9 1.9 0 0 0 3.4 0M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9Z",
  tasks: "M11 12H3m18-6H3m18 12H3M16 17l2 2 4-4",
  habits: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5Z",
  search: "M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  plus: "M12 5v14M5 12h14",
  folder: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6",
  chevronRight: "m9 18 6-6-6-6",
  chevronLeft: "m15 18-6-6 6-6",
  settings:
    "M12.2 2h-.4a2 2 0 0 0-2 2 1.7 1.7 0 0 1-1 1.5 1.7 1.7 0 0 1-1.9-.3 2 2 0 0 0-2.8 0l-.3.3a2 2 0 0 0 0 2.8 1.7 1.7 0 0 1 .3 1.9 1.7 1.7 0 0 1-1.5 1 2 2 0 0 0-2 2v.4a2 2 0 0 0 2 2 1.7 1.7 0 0 1 1.5 1 1.7 1.7 0 0 1-.3 1.9 2 2 0 0 0 0 2.8l.3.3a2 2 0 0 0 2.8 0 1.7 1.7 0 0 1 1.9-.3 1.7 1.7 0 0 1 1 1.5 2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2 1.7 1.7 0 0 1 1-1.5 1.7 1.7 0 0 1 1.9.3 2 2 0 0 0 2.8 0l.3-.3a2 2 0 0 0 0-2.8 1.7 1.7 0 0 1-.3-1.9 1.7 1.7 0 0 1 1.5-1 2 2 0 0 0 2-2v-.4a2 2 0 0 0-2-2 1.7 1.7 0 0 1-1.5-1 1.7 1.7 0 0 1 .3-1.9 2 2 0 0 0 0-2.8l-.3-.3a2 2 0 0 0-2.8 0 1.7 1.7 0 0 1-1.9.3A1.7 1.7 0 0 1 14.2 4a2 2 0 0 0-2-2Z",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5",
  panelLeft: "M9 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  panelRight: "M15 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  moreH: "M12 12h.01M19 12h.01M5 12h.01",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  close: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  dot: "M12 12h.01",
  graph: "M18 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  repeat: "M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3",
  // Text-formatting icons for the editor toolbar (Lucide-style outlines).
  bold: "M6 12h9a4 4 0 0 1 0 8H6zM6 4h7a4 4 0 0 1 0 8H6z",
  italic: "M19 4h-9M14 20H5M15 4 9 20",
  strikethrough: "M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  codeBlock: "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM10 9.5 8 12l2 2.5M14 9.5l2 2.5-2 2.5",
  quote: "M17 6H3M21 12H8M21 18H8M3 12v6",
  listBullet: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  listOrdered: "M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export const ICON_DEFAULT_COLOR = colors.textSecondary;
