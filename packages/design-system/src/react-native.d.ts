// Minimal ambient types for the react-native primitives the design system builds on.
// On web these resolve to react-native-web at bundle time (alias); on native
// (milestone 3) the real react-native types replace this shim. Loose by design.
//
// This is the canonical shim for the monorepo's UI layer: packages/app and the web
// and desktop shells reference it via their tsconfig "include".

declare module "react-native" {
  import type { ComponentType, ReactNode, Ref, ComponentType as CT } from "react";

  export type Style = Record<string, unknown>;
  // Generic to match real react-native's StyleProp<T>; the default keeps the shim
  // loose (design-system code is the source of truth for the element type).
  export type StyleProp<T = Style> = T | StyleProp<T>[] | false | null | undefined;
  export type ViewStyle = Style;
  export type TextStyle = Style;
  export type ImageStyle = Style;

  interface ViewProps {
    style?: StyleProp<ViewStyle>;
    children?: ReactNode;
    ref?: Ref<unknown>;
    pointerEvents?: "auto" | "none" | "box-none" | "box-only";
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
    onPointerDown?: (event: { clientX?: number; nativeEvent?: { clientX?: number } }) => void;
    "aria-label"?: string;
  }
  interface ScrollViewProps extends ViewProps {
    contentContainerStyle?: StyleProp<ViewStyle>;
    horizontal?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    showsVerticalScrollIndicator?: boolean;
  }
  interface TextProps extends ViewProps {
    numberOfLines?: number;
    onPress?: (event: GestureResponderEvent) => void;
  }
  // Loose stand-in for RN's key event. On web the nativeEvent is the DOM KeyboardEvent.
  export interface TextInputKeyPressEvent {
    nativeEvent: { key: string; shiftKey?: boolean; [key: string]: unknown };
    preventDefault?: () => void;
  }
  interface TextInputProps {
    style?: StyleProp<TextStyle>;
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    placeholderTextColor?: string;
    multiline?: boolean;
    editable?: boolean;
    autoFocus?: boolean;
    secureTextEntry?: boolean;
    autoCapitalize?: "none" | "sentences" | "words" | "characters";
    keyboardType?: string;
    onChangeText?: (text: string) => void;
    onKeyPress?: (event: TextInputKeyPressEvent) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onSubmitEditing?: () => void;
    returnKeyType?: string;
  }
  interface PressableState {
    pressed: boolean;
    hovered?: boolean; // react-native-web extension
  }
  // Loose stand-in for RN's press event. On web (react-native-web) the nativeEvent is
  // the DOM MouseEvent, so keyboard-modifier flags are available for Cmd/Ctrl-click.
  export interface GestureResponderEvent {
    nativeEvent: { metaKey?: boolean; ctrlKey?: boolean; [key: string]: unknown };
  }
  interface PressableProps {
    style?: StyleProp | ((state: PressableState) => StyleProp);
    onPress?: (event: GestureResponderEvent) => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    disabled?: boolean;
    children?: ReactNode | ((state: PressableState) => ReactNode);
    "aria-label"?: string;
  }
  interface ModalProps extends ViewProps {
    visible?: boolean;
    transparent?: boolean;
    animationType?: "none" | "slide" | "fade";
    onRequestClose?: () => void;
  }
  interface FlatListProps<T> {
    data: readonly T[];
    renderItem: (info: { item: T; index: number }) => ReactNode;
    keyExtractor?: (item: T, index: number) => string;
    style?: StyleProp;
    contentContainerStyle?: StyleProp;
    ListEmptyComponent?: ReactNode;
  }

  // Layout + gesture types for drag-and-drop (SortableList). Loose stand-ins.
  export interface LayoutChangeEvent {
    nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
  }
  export interface PanResponderGestureState {
    dx: number;
    dy: number;
    moveX: number;
    moveY: number;
    vx: number;
    vy: number;
  }
  export type GestureResponderHandlers = Record<string, unknown>;
  interface PanResponderInstance {
    panHandlers: GestureResponderHandlers;
  }
  interface PanResponderCallbacks {
    onStartShouldSetPanResponder?: (e: GestureResponderEvent, g: PanResponderGestureState) => boolean;
    onMoveShouldSetPanResponder?: (e: GestureResponderEvent, g: PanResponderGestureState) => boolean;
    onPanResponderGrant?: (e: GestureResponderEvent, g: PanResponderGestureState) => void;
    onPanResponderMove?: (e: GestureResponderEvent, g: PanResponderGestureState) => void;
    onPanResponderRelease?: (e: GestureResponderEvent, g: PanResponderGestureState) => void;
    onPanResponderTerminate?: (e: GestureResponderEvent, g: PanResponderGestureState) => void;
    onPanResponderTerminationRequest?: (e: GestureResponderEvent, g: PanResponderGestureState) => boolean;
  }
  export const PanResponder: { create(config: PanResponderCallbacks): PanResponderInstance };

  export const View: ComponentType<ViewProps>;
  export const ScrollView: ComponentType<ScrollViewProps>;
  export const Text: ComponentType<TextProps>;
  export const TextInput: ComponentType<TextInputProps>;
  export const Pressable: ComponentType<PressableProps>;
  export const ActivityIndicator: ComponentType<{ size?: "small" | "large"; color?: string }>;
  export const Modal: ComponentType<ModalProps>;
  export function FlatList<T>(props: FlatListProps<T>): ReactNode;

  export function useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number };

  export const StyleSheet: {
    create<T extends Record<string, Style>>(styles: T): T;
    flatten(style: StyleProp): Style;
    hairlineWidth: number;
  };
  export const Platform: { OS: string; select<T>(spec: Record<string, T>): T };

  export const AppRegistry: {
    registerComponent(appKey: string, getComponent: () => CT<unknown>): void;
    runApplication(appKey: string, params: { rootTag: Element | null }): void;
  };

  // Animated: just the surface SortableList uses (a JS-driven value, a spring, and an
  // animatable View that accepts onLayout). Loose by design.
  export namespace Animated {
    class Value {
      constructor(value: number);
      setValue(value: number): void;
    }
    interface CompositeAnimation {
      start(callback?: () => void): void;
    }
    interface SpringConfig {
      toValue: number;
      useNativeDriver?: boolean;
      bounciness?: number;
      speed?: number;
    }
    function spring(value: Value, config: SpringConfig): CompositeAnimation;
    const View: ComponentType<ViewProps & { onLayout?: (e: LayoutChangeEvent) => void }>;
  }
}
