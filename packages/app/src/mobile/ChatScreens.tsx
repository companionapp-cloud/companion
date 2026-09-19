import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { Chat } from "@companion/core-bridge";
import { Icon, IconButton, Spinner, colors, space } from "@companion/design-system";
import { ChatView } from "../ChatScreen";
import { useCore } from "../CoreContext";
import { useCalendarItemSheet } from "./CalendarScreens";
import { useNav } from "../nav-context";
import { timeAgo } from "../NotificationRow";
import { Card, CardRow, EmptyCaption, FAB_CLEARANCE, Fab, NavAction, NavBar, ROW_ICON_INSET, RowIcon } from "./ui";

// Mobile web chat — ports of the native app's ChatListScreen/ChatScreen: a full-screen
// grouped list of conversations that pushes to the conversation screen. A working chat
// shows a spinner in the list even while its reply generates in the background.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavLike = any;

export function ChatListScreen() {
  const navigation = useNavigation<NavLike>();
  const { chats } = useCore();
  const [list, setList] = useState<Chat[]>([]);

  const reload = useCallback(() => {
    chats.list().then(setList).catch(() => {});
  }, [chats]);
  useEffect(() => {
    reload();
    const a = chats.onChanged(() => reload());
    const b = chats.onWorking(() => reload());
    return () => {
      a();
      b();
    };
  }, [chats, reload]);

  const newChat = useCallback(async () => {
    const c = await chats.create();
    reload();
    navigation.navigate("chatConversation", { chatId: c.id });
  }, [chats, navigation, reload]);

  const remove = async (id: string) => {
    await chats.remove(id);
    reload();
  };

  return (
    <View style={styles.root}>
      <NavBar title="Chat" />
      <ScrollView contentContainerStyle={styles.list}>
        {list.length ? (
          <Card>
            {list.map((c, i) => (
              <CardRow
                key={c.id}
                leading={<RowIcon name="chat" />}
                separatorInset={ROW_ICON_INSET}
                title={c.title || "New chat"}
                subtitle={`Last message ${timeAgo(c.updatedAt)}`}
                trailing={
                  c.working ? (
                    <View style={styles.working}>
                      <Spinner inline size={13} />
                    </View>
                  ) : (
                    <IconButton label="Delete chat" onPress={() => void remove(c.id)}>
                      <Icon name="trash" size={15} color={colors.textTertiary} />
                    </IconButton>
                  )
                }
                showChevron={false}
                isLast={i === list.length - 1}
                onPress={() => navigation.navigate("chatConversation", { chatId: c.id })}
              />
            ))}
          </Card>
        ) : (
          <EmptyCaption>No chats yet. Start one.</EmptyCaption>
        )}
      </ScrollView>
      <Fab label="New chat" onPress={() => void newChat()} />
    </View>
  );
}

export function ChatConversationScreen() {
  const nav = useNav();
  const navigation = useNavigation<NavLike>();
  // An event preview opens the same read-only sheet as a calendar agenda row.
  const { openItem: openEvent, sheet: eventSheet } = useCalendarItemSheet();
  const { chats } = useCore();
  const { chatId } = (useRoute().params ?? {}) as { chatId?: string };
  // The bar carries the conversation's title, which the core fills in after the first reply.
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    const load = () =>
      chats
        .list()
        .then((all) => {
          if (!cancelled) setTitle(all.find((c) => c.id === chatId)?.title ?? "");
        })
        .catch(() => {});
    load();
    const off = chats.onChanged((e) => {
      if (e.chatId === chatId) load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [chats, chatId]);

  if (!chatId) return null;
  const configure = () => navigation.navigate("settingsSection", { section: "ai" });
  return (
    <View style={styles.root}>
      <NavBar title={title || "New chat"} right={<NavAction icon="settings" label="Model settings" onPress={configure} />} />
      <View style={styles.thread}>
        <ChatView
          chatId={chatId}
          composer="floating"
          onOpenEntity={(type, id) => {
            if (type === "task") nav.openTask(id);
            else if (type === "canvas") nav.openCanvas(id);
            else if (type === "project") nav.openProject(id);
            else nav.openNote(id);
          }}
          onOpenEvent={openEvent}
          onConfigure={configure}
        />
      </View>
      {eventSheet}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { paddingHorizontal: space.ml, paddingTop: space.ml, paddingBottom: FAB_CLEARANCE, flexGrow: 1 },
  // Matches the delete button's box so rows don't shift when a reply starts generating.
  working: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  thread: { flex: 1, minHeight: 0 },
});
