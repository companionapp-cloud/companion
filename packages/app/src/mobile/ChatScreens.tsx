import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { Chat } from "@companion/core-bridge";
import { colors } from "@companion/design-system";
import { ChatList, ChatView } from "../ChatScreen";
import { useCore } from "../CoreContext";
import { useNav } from "../nav-context";
import { Fab } from "./ui";

// Mobile web chat — ports of the native app's ChatListScreen/ChatScreen: a full-screen
// list of conversations that pushes to the conversation screen. A working chat shows a
// spinner in the list even while its reply generates in the background.

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

  return (
    <View style={styles.root}>
      <ChatList
        variant="full"
        chats={list}
        onSelect={(id) => navigation.navigate("chatConversation", { chatId: id })}
        onNew={() => void newChat()}
        onDelete={async (id) => {
          await chats.remove(id);
          reload();
        }}
      />
      <Fab label="New chat" onPress={() => void newChat()} />
    </View>
  );
}

export function ChatConversationScreen() {
  const nav = useNav();
  const navigation = useNavigation<NavLike>();
  const { chatId } = (useRoute().params ?? {}) as { chatId?: string };
  if (!chatId) return null;
  return (
    <View style={styles.root}>
      <ChatView
        chatId={chatId}
        composer="floating"
        onOpenEntity={(type, id) => (type === "task" ? nav.openTask(id) : nav.openNote(id))}
        onConfigure={() => navigation.navigate("settingsSection", { section: "ai" })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
});
