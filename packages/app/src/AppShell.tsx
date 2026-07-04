import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import {
  NavigationContainer,
  StackActions,
  StackRouter,
  createNavigatorFactory,
  useNavigationBuilder,
  useRoute,
  type LinkingOptions,
  type ParamListBase,
} from "@react-navigation/native";
import {
  Avatar,
  Frame,
  Icon,
  IconButton,
  RailItem,
  Text,
  colors,
  dragRegion,
  layout,
  radius,
  space,
  type IconName,
} from "@companion/design-system";
import { NavContext, useNav, type NavLocation, type Navigator, type ViewId } from "./nav-context";
import { NotesProvider } from "./NotesProvider";
import { AppToolbar } from "./AppToolbar";
import { NotesScreen } from "./NotesScreen";
import { SettingsPanel } from "./SettingsPanel";
import { useSync } from "./SyncProvider";

const NAV: { id: ViewId; label: string; icon: IconName }[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "notes", label: "Notes", icon: "notes" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
];

const PLACEHOLDER: Record<"chat" | "calendar" | "tasks", string> = {
  chat: "Chat lands here soon. For now, your notes are just to the left.",
  calendar: "A calendar is coming. Time keeps happening in the meantime.",
  tasks: "Tasks are on the way. Until then, a note that says “do the thing” works.",
};

export interface AppShellProps {
  topInset?: number;
}

// ---------------------------------------------------------------------------
// React Navigation is the router (routes + URL deep-linking). A custom navigator
// renders our own chrome; a thin layer on top of the router state adds open-note
// tabs and a forward-history stack (which React Navigation doesn't model natively).
// ---------------------------------------------------------------------------

/** URL linking, web only (http/https). On desktop the webview scheme varies, so nav
 * stays in-memory there — still React Navigation, just without URL sync. */
function webLinking(): LinkingOptions<ParamListBase> | undefined {
  if (typeof window === "undefined" || !/^https?:$/.test(window.location.protocol)) return undefined;
  return {
    prefixes: [window.location.origin],
    config: { screens: { chat: "chat", calendar: "calendar", tasks: "tasks", notes: "notes/:id?" } },
  };
}

function NotesRouteScreen() {
  const route = useRoute();
  const id = (route.params as { id?: string } | undefined)?.id ?? null;
  return <NotesScreen activeNoteId={id} />;
}

function ViewScreen() {
  const route = useRoute();
  return <ComingSoon view={route.name as "chat" | "calendar" | "tasks"} />;
}

function CompanionNavigator({
  initialRouteName,
  children,
  screenOptions,
  topInset,
}: {
  initialRouteName?: string;
  children: ReactNode;
  screenOptions?: unknown;
  topInset: number;
}) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder(StackRouter, {
    initialRouteName,
    children,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screenOptions: screenOptions as any,
  });
  const route = state.routes[state.index];
  return (
    <NavigationContent>
      <NavBridge state={state} navigation={navigation} topInset={topInset}>
        {descriptors[route.key].render()}
      </NavBridge>
    </NavigationContent>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createCompanionNavigator = createNavigatorFactory(CompanionNavigator as any);
const Nav = createCompanionNavigator();

interface RouteLike {
  key: string;
  name: string;
  params?: { id?: string };
}
interface StateLike {
  index: number;
  routes: RouteLike[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavLike = any;

/** Builds the useNav() API from the router state plus tab/forward state, and renders
 * the shell around the current screen. */
function NavBridge({
  state,
  navigation,
  topInset,
  children,
}: {
  state: StateLike;
  navigation: NavLike;
  topInset: number;
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<{ name: string; params?: { id?: string } }[]>([]);

  const route = state.routes[state.index];
  const routeName = route.name as ViewId;
  const current: NavLocation =
    routeName === "notes"
      ? route.params?.id
        ? { kind: "note", id: route.params.id }
        : { kind: "notes" }
      : { kind: "view", view: routeName };

  const nav = useMemo<Navigator>(() => {
    const goto = (name: string, params?: { id?: string }) => {
      setForwardStack([]);
      navigation.dispatch(StackActions.push(name, params));
    };
    return {
      current,
      tabs,
      activeView: routeName === "notes" ? "notes" : routeName,
      canBack: state.index > 0,
      canForward: forwardStack.length > 0,
      back: () => {
        const top = state.routes[state.index];
        setForwardStack((f) => [...f, { name: top.name, params: top.params }]);
        navigation.goBack();
      },
      forward: () => {
        setForwardStack((f) => {
          if (!f.length) return f;
          const r = f[f.length - 1];
          navigation.dispatch(StackActions.push(r.name, r.params));
          return f.slice(0, -1);
        });
      },
      goView: (view) => {
        if (routeName === view && !(view === "notes" && current.kind === "note")) return;
        goto(view);
      },
      openNote: (id) => {
        setTabs((t) => (t.includes(id) ? t : [...t, id]));
        goto("notes", { id });
      },
      closeTab: (id) => {
        setTabs((t) => t.filter((x) => x !== id));
        if (current.kind === "note" && current.id === id) {
          const remaining = tabs.filter((x) => x !== id);
          goto("notes", remaining.length ? { id: remaining[remaining.length - 1] } : undefined);
        }
      },
    };
  }, [current, tabs, routeName, state, forwardStack, navigation]);

  return (
    <NavContext.Provider value={nav}>
      <Shell topInset={topInset}>{children}</Shell>
    </NavContext.Provider>
  );
}

export function AppShell({ topInset = 0 }: AppShellProps) {
  const linking = useMemo(webLinking, []);
  return (
    <NotesProvider>
      <NavigationContainer linking={linking} documentTitle={{ enabled: false }}>
        <Nav.Navigator initialRouteName="notes" topInset={topInset}>
          <Nav.Screen name="chat" component={ViewScreen} />
          <Nav.Screen name="calendar" component={ViewScreen} />
          <Nav.Screen name="notes" component={NotesRouteScreen} />
          <Nav.Screen name="tasks" component={ViewScreen} />
        </Nav.Navigator>
      </NavigationContainer>
    </NotesProvider>
  );
}

/** The persistent chrome: hover-reveal rail + inset Frame(toolbar) around the current
 * screen (children). */
function Shell({ topInset, children }: { topInset: number; children: ReactNode }) {
  const nav = useNav();
  const sync = useSync();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pinned, setPinned] = usePersistentBoolean("companion.sidebar.pinned", false);
  const expanded = open || pinned;

  // Sync on navigation (§5.4). Key on the location so param-only changes still fire.
  const locKey = nav.current.kind + (nav.current.kind === "note" ? nav.current.id : "");
  useEffect(() => {
    sync.trigger();
  }, [locKey, sync]);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surfaceApp }}>
      <View
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        style={[
          dragRegion,
          {
            width: expanded ? layout.railOpenW : layout.railW,
            flexShrink: 0,
            paddingHorizontal: space.md,
            paddingTop: space.md + topInset,
            paddingBottom: space.md,
            overflow: "hidden",
            transitionProperty: "width",
            transitionDuration: "200ms",
            transitionTimingFunction: "cubic-bezier(0.2, 0, 0, 1)",
          },
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, height: 40, paddingHorizontal: space.sm, marginBottom: space.md }}>
          <Mark />
          {expanded ? (
            <>
              <Text variant="title" style={{ flex: 1 }} numberOfLines={1}>
                companion
              </Text>
              <IconButton label={pinned ? "Unpin sidebar" : "Pin sidebar"} size="sm" active={pinned} onPress={() => setPinned((p) => !p)}>
                <Icon name="panelLeft" size={16} color={pinned ? colors.accentHover : colors.textSecondary} />
              </IconButton>
            </>
          ) : null}
        </View>

        <View style={{ gap: 3, flex: 1 }}>
          {NAV.map((n) => (
            <RailItem
              key={n.id}
              icon={<Icon name={n.icon} size={19} color={nav.activeView === n.id ? colors.accentHover : colors.textSecondary} />}
              label={n.label}
              active={nav.activeView === n.id}
              expanded={expanded}
              onPress={() => nav.goView(n.id)}
            />
          ))}
        </View>

        <View style={{ gap: space.sm, paddingTop: space.md }}>
          <RailItem
            icon={<Icon name="settings" size={18} color={settingsOpen ? colors.accentHover : colors.textSecondary} />}
            label="Settings"
            active={settingsOpen}
            expanded={expanded}
            onPress={() => setSettingsOpen(true)}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.sm, height: 32 }}>
            <Avatar name="You" size="sm" />
            {expanded ? (
              <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
                you@companion.so
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Frame toolbar={<AppToolbar />}>{children}</Frame>
      </View>

      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </View>
  );
}

function ComingSoon({ view }: { view: "chat" | "calendar" | "tasks" }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl }}>
      <Text tone="tertiary" style={{ textAlign: "center", maxWidth: 360, lineHeight: 22 }}>
        {PLACEHOLDER[view]}
      </Text>
    </View>
  );
}

function Mark({ size = 26 }: { size?: number }) {
  const dot = Math.round(size * 0.3);
  return (
    <View style={{ width: size, height: size, borderRadius: radius.lg, backgroundColor: colors.accent, flexShrink: 0 }}>
      <View style={{ position: "absolute", width: dot, height: dot, borderRadius: radius.full, backgroundColor: colors.gray0, top: Math.round(size * 0.2), left: Math.round(size * 0.2) }} />
    </View>
  );
}

function usePersistentBoolean(key: string, initial: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored == null ? initial : stored === "true";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        try {
          globalThis.localStorage?.setItem(key, String(resolved));
        } catch {
          /* storage unavailable */
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, set] as const;
}
