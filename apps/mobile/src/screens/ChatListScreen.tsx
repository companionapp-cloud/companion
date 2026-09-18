import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatList, useCore } from '@companion/app';
import { colors } from '@companion/design-system';
import type { Chat } from '@companion/core-bridge';
import type { RootStackParamList } from '../MobileShell';
import { Fab } from '../ui/native';

// The mobile chat list: full-screen list of conversations that pushes to the conversation
// screen. A working chat shows a spinner here even while its reply generates in the
// background. The "New chat" FAB creates a chat and opens it.
export function ChatListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
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

  return (
    <View style={styles.root}>
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
      <Fab label="New chat" onPress={() => void newChat()} bottomInset={insets.bottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
});
