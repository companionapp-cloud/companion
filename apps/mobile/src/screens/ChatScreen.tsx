import { useEffect, useLayoutEffect, useState } from 'react';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';
import { Keyboard, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@companion/design-system';
import { ChatView, useCore } from '@companion/app';
import type { RootStackParamList } from '../MobileShell';
import { NavAction } from '../ui/native';

// Tracks whether the on-screen keyboard is visible, so the composer can drop its home-bar
// safe-area padding while the keyboard covers that region.
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvt, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

// Mobile conversation screen: the shared ChatView for one chat, pushed from the chat list.
// The nav bar carries the conversation's title (which the core fills in after the first
// reply) and the model-settings action. Wikilink chips open the entity's editor via the native stack; the keyboard-avoiding wrapper
// keeps the floating composer above the keyboard, and the bottom safe-area inset (dropped
// while the keyboard is up) keeps it clear of the home bar.
export function ChatScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'ChatConversation'>>();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const headerHeight = useHeaderHeight();
  const { chats } = useCore();
  const chatId = route.params.chatId;

  const [title, setTitle] = useState('');
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      chats
        .list()
        .then((all) => {
          if (!cancelled) setTitle(all.find((c) => c.id === chatId)?.title ?? '');
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

  useLayoutEffect(() => {
    nav.setOptions({
      title: title || 'New chat',
      headerRight: () => (
        <NavAction icon="settings" label="Model settings" onPress={() => nav.navigate('SettingsSection', { section: 'ai' })} />
      ),
    });
  }, [nav, title]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.surfaceApp }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <View style={{ flex: 1 }}>
        <ChatView
          chatId={chatId}
          composer="floating"
          bottomInset={keyboardVisible ? 0 : insets.bottom}
          onOpenEntity={(type, id) => nav.navigate(type === 'task' ? 'TaskEditor' : 'NoteEditor', { id })}
          onConfigure={() => nav.navigate('SettingsSection', { section: 'ai' })}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
