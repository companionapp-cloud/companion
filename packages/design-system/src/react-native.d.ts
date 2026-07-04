// Minimal ambient types for the react-native primitives the design system builds on.
// On web these resolve to react-native-web at bundle time (alias); on native
// (milestone 3) the real react-native types replace this shim. Loose by design.
//
// This is the canonical shim for the monorepo's UI layer: packages/app and the web
// and desktop shells reference it via their tsconfig "include".

declare module "react-native" {
  import type { ComponentType, ReactNode, Ref, ComponentType as CT } from "react";

  export type Style = Record<string, unknown>;
  export type StyleProp = Style | StyleProp[] | false | null | undefined;

  interface ViewProps {
    style?: StyleProp;
    children?: ReactNode;
    ref?: Ref<unknown>;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
    onPointerDown?: (event: { clientX?: number; nativeEvent?: { clientX?: number } }) => void;
    "aria-label"?: string;
  }
  interface ScrollViewProps extends ViewProps {
    contentContainerStyle?: StyleProp;
    horizontal?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    showsVerticalScrollIndicator?: boolean;
  }
  interface TextProps extends ViewProps {
    numberOfLines?: number;
  }
  interface TextInputProps {
    style?: StyleProp;
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    placeholderTextColor?: string;
    multiline?: boolean;
    autoFocus?: boolean;
    secureTextEntry?: boolean;
    autoCapitalize?: "none" | "sentences" | "words" | "characters";
    keyboardType?: string;
    onChangeText?: (text: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
  }
  interface PressableState {
    pressed: boolean;
    hovered?: boolean; // react-native-web extension
  }
  interface PressableProps {
    style?: StyleProp | ((state: PressableState) => StyleProp);
    onPress?: () => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    disabled?: boolean;
    children?: ReactNode | ((state: PressableState) => ReactNode);
    "aria-label"?: string;
  }
  interface FlatListProps<T> {
    data: readonly T[];
    renderItem: (info: { item: T; index: number }) => ReactNode;
    keyExtractor?: (item: T, index: number) => string;
    style?: StyleProp;
    contentContainerStyle?: StyleProp;
    ListEmptyComponent?: ReactNode;
  }

  export const View: ComponentType<ViewProps>;
  export const ScrollView: ComponentType<ScrollViewProps>;
  export const Text: ComponentType<TextProps>;
  export const TextInput: ComponentType<TextInputProps>;
  export const Pressable: ComponentType<PressableProps>;
  export const ActivityIndicator: ComponentType<{ size?: "small" | "large"; color?: string }>;
  export function FlatList<T>(props: FlatListProps<T>): ReactNode;

  export const StyleSheet: {
    create<T extends Record<string, Style>>(styles: T): T;
    flatten(style: StyleProp): Style;
  };
  export const Platform: { OS: string; select<T>(spec: Record<string, T>): T };

  export const AppRegistry: {
    registerComponent(appKey: string, getComponent: () => CT<unknown>): void;
    runApplication(appKey: string, params: { rootTag: Element | null }): void;
  };
}
