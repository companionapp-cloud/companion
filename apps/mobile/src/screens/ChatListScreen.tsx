import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Pressable } from 'react-native';
import { ChatList, useCore } from '@companion/app';
import { Icon, colors } from '@companion/design-system';
import type { Chat } from '@companion/core-bridge';
import type { RootStackParamList } from '../MobileShell';

// The mobile chat list: full-screen list of conversations that pushes to the conversation
// screen. A working chat shows a spinner here even while its reply generates in the
// background. "New chat" (header +) creates a chat and opens it.
export function ChatListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
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
  // Refresh when returning from a conversation (title/last-activity may have changed).
  useFocusEffect(useCallback(() => reload(), [reload]));

  const newChat = useCallback(async () => {
    const c = await chats.create();
    reload();
    nav.navigate('ChatConversation', { chatId: c.id });
  }, [chats, nav, reload]);

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Pressable onPress={newChat} accessibilityLabel="New chat" hitSlop={8}>
          <Icon name="plus" size={22} color={colors.accent} />
        </Pressable>
      ),
    });
  }, [nav, newChat]);

  return (
    <ChatList
      variant="full"
      chats={list}
      onSelect={(id) => nav.navigate('ChatConversation', { chatId: id })}
      onNew={newChat}
      onDelete={async (id) => {
        await chats.remove(id);
        reload();
      }}
    />
  );
}
