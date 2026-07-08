import { useEffect, useState } from 'react';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';
import { Keyboard, KeyboardAvoidingView, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@companion/design-system';
import { ChatView } from '@companion/app';
import type { RootStackParamList } from '../MobileShell';

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
// Wikilink chips open the entity's editor via the native stack; the keyboard-avoiding wrapper
// keeps the floating composer above the keyboard, and the bottom safe-area inset (dropped
// while the keyboard is up) keeps it clear of the home bar.
export function ChatScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'ChatConversation'>>();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const headerHeight = useHeaderHeight();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.surfaceApp }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <View style={{ flex: 1 }}>
        <ChatView
          chatId={route.params.chatId}
          composer="floating"
          bottomInset={keyboardVisible ? 0 : insets.bottom}
          onOpenEntity={(type, id) => nav.navigate(type === 'task' ? 'TaskEditor' : 'NoteEditor', { id })}
          onConfigure={() => nav.navigate('SettingsSection', { section: 'ai' })}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
