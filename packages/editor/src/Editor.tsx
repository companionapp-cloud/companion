import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Icon, type IconName } from "@companion/design-system";
import { EDITOR_JS } from "./editorBundle.generated";
import { EDITOR_CSS } from "./styles";
import type { FormatName, FormatState } from "./formatCommands";
import type { DocumentSource, EditorController, EditorProps, LinkSource, LinkSuggestion, LinkType } from "./types";

// The formatting toolbar's buttons, in order. Each format button injects window.__format;
// the reference button opens the native `[[` picker (it needs a linkSource).
const FORMAT_BUTTONS: { name: FormatName; icon: IconName; label: string }[] = [
  { name: "bold", icon: "bold", label: "Bold" },
  { name: "italic", icon: "italic", label: "Italic" },
  { name: "strike", icon: "strikethrough", label: "Strikethrough" },
  { name: "code", icon: "code", label: "Code" },
  { name: "codeBlock", icon: "codeBlock", label: "Code block" },
  { name: "blockquote", icon: "quote", label: "Blockquote" },
  { name: "bulletList", icon: "listBullet", label: "Bulleted list" },
  { name: "orderedList", icon: "listOrdered", label: "Numbered list" },
];

// Native editor: ProseMirror hosted in a plain react-native-webview. The editor code is
// bundled offline into EDITOR_JS (`npm run build:editor`) and embedded below. A raw
// WebView is used rather than Expo's `use dom`, whose DomWebView crashes on mount on
// Android + the New Architecture. Web/desktop resolve Editor.web.tsx instead (DOM).
//
// The WebView can't reach the Go core directly, so wikilink search / UUID-lookup run over
// a tiny postMessage RPC (linkSearch / linkLookup, answered by window.__resolveLink). And
// because a DOM popup fights the on-screen keyboard, `[[` opens a *native* picker here:
// the WebView posts linkTrigger, this host shows a modal, and injects window.__insertRef /
// __cancelRef with the result. A keyboard toolbar offers the same via an explicit button.
function buildHtml(
  markdown: string,
  hasLinkSource: boolean,
  opts: { simple: boolean; placeholder?: string; submitOnEnter: boolean; debounceMs?: number; hasDocumentSource: boolean },
): string {
  // Escape `<` so note content can't break out of the <script> (e.g. "</script>").
  const initial = JSON.stringify(markdown).replace(/</g, "\\u003c");
  const placeholder = JSON.stringify(opts.placeholder ?? "").replace(/</g, "\\u003c");
  const debounce = typeof opts.debounceMs === "number" ? String(opts.debounceMs) : "undefined";
  // The full document editor is a full-screen page (min-height:100%, roomy .pm-wrap). The
  // simple editor is an inline field that hugs its content, so the host can size the WebView
  // to it (see the height message) — no min-height, tight padding.
  const bodyCss = opts.simple
    ? "html,body{margin:0;padding:0;background:transparent;}"
    : "html,body{margin:0;padding:0;min-height:100%;background:#ffffff;}";
  const mountClass = opts.simple ? "pm-compact" : "pm-wrap";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>${bodyCss}${EDITOR_CSS}</style>
</head>
<body>
<div id="editor" class="${mountClass}"></div>
<script>window.__INITIAL_MARKDOWN__ = ${initial}; window.__HAS_LINK_SOURCE__ = ${hasLinkSource ? "true" : "false"}; window.__HAS_DOCUMENT_SOURCE__ = ${opts.hasDocumentSource ? "true" : "false"}; window.__EDITOR_VARIANT__ = ${opts.simple ? '"simple"' : '"full"'}; window.__PLACEHOLDER__ = ${placeholder}; window.__SUBMIT_ON_ENTER__ = ${opts.submitOnEnter ? "true" : "false"}; window.__DEBOUNCE_MS__ = ${debounce};</script>
<script>${EDITOR_JS}</script>
</body>
</html>`;
}

const TYPES: { value: LinkType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "note", label: "Notes" },
  { value: "task", label: "Tasks" },
  { value: "habit", label: "Habits" },
  { value: "project", label: "Projects" },
];

interface PickerState {
  open: boolean;
  fromTrigger: boolean; // opened by a typed `[[` (vs. the toolbar button)
  embed: boolean;
}

export const Editor = forwardRef<EditorController, EditorProps>(function Editor(
  { markdown, onChangeMarkdown, linkSource, documentSource, onOpenRef, linkRevision, variant, placeholder, onSubmit, clearSignal, minHeight, maxHeight, debounceMs, onFormatStateChange },
  ref,
) {
  const simple = variant === "simple";
  const onChangeRef = useRef(onChangeMarkdown);
  onChangeRef.current = onChangeMarkdown;
  const onFormatStateRef = useRef(onFormatStateChange);
  onFormatStateRef.current = onFormatStateChange;
  const linkSourceRef = useRef<LinkSource | undefined>(linkSource);
  linkSourceRef.current = linkSource;
  const documentSourceRef = useRef<DocumentSource | undefined>(documentSource);
  documentSourceRef.current = documentSource;
  const onOpenRefRef = useRef(onOpenRef);
  onOpenRefRef.current = onOpenRef;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const webRef = useRef<WebView>(null);

  const [editorFocused, setEditorFocused] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);
  const [picker, setPicker] = useState<PickerState>({ open: false, fromTrigger: false, embed: false });
  // Latest formatting snapshot from the WebView, so the toolbar can show active states.
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  // Simple variant: the WebView is sized to its reported content height, between the host's
  // min and (optional) max. Seed at the min so it never starts collapsed.
  const [contentHeight, setContentHeight] = useState(minHeight ?? 40);

  // Built once from the initial content; the WebView owns edits thereafter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => buildHtml(markdown, !!linkSource, { simple, placeholder, submitOnEnter: !!onSubmit, debounceMs, hasDocumentSource: !!documentSource }), []);

  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const inject = (js: string) => webRef.current?.injectJavaScript(`${js} true;`);
  const jsonArg = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

  // Attach a file on native (PLAN §6.9): the shell's OS-native picker ingests the chosen file
  // and returns the new document, which we place into the WebView editor at the selection.
  // The WebView can't receive a File, so ingestion happens host-side and only the id crosses.
  const pickDocument = async () => {
    const src = documentSourceRef.current;
    if (!src?.pick) return;
    try {
      const doc = await src.pick();
      if (doc) inject(`window.__insertDocumentEmbed && window.__insertDocumentEmbed(${jsonArg(doc.id)}, ${jsonArg(doc.filename)});`);
    } catch {
      /* picker cancelled or failed */
    }
  };

  // Re-hydrate task chips inside the WebView when the host signals task data changed. Skips
  // the initial mount, where chips already hydrate on creation (and the WebView may not be
  // ready to receive the injection yet).
  const firstRevision = useRef(true);
  useEffect(() => {
    if (firstRevision.current) {
      firstRevision.current = false;
      return;
    }
    inject("window.__refreshLinks && window.__refreshLinks();");
    // `inject` is stable across renders (reads webRef); depend only on the revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkRevision]);

  // Empty the editor when the host bumps clearSignal (composer, post-send). Skips mount.
  const firstClear = useRef(true);
  useEffect(() => {
    if (firstClear.current) {
      firstClear.current = false;
      return;
    }
    inject("window.__clear && window.__clear();");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal]);

  // Host-driven controls (used by the shared shell; the on-screen toolbar below calls the
  // same injected globals directly).
  useImperativeHandle(
    ref,
    (): EditorController => ({
      format: (name) => inject(`window.__format && window.__format(${jsonArg(name)});`),
      insertReference: () => inject(`window.__insertReference && window.__insertReference();`),
      // Attach a file via the shell's OS-native picker (PLAN §6.9), then place the embed.
      insertDocument: () => void pickDocument(),
    }),
    // `inject`/`jsonArg`/`pickDocument` read refs and are stable enough; rebuild is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const resolve = (requestId: unknown, result: unknown) =>
    inject(`window.__resolveLink && window.__resolveLink(${Number(requestId)}, ${jsonArg(result)});`);
  const resolveDoc = (requestId: unknown, result: unknown) =>
    inject(`window.__resolveDoc && window.__resolveDoc(${Number(requestId)}, ${jsonArg(result)});`);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      switch (msg.type) {
        case "change":
          if (typeof msg.payload === "string") onChangeRef.current(msg.payload);
          break;
        case "submit":
          if (typeof msg.payload === "string") onSubmitRef.current?.(msg.payload);
          break;
        case "height":
          if (typeof msg.payload === "number") {
            const min = minHeight ?? 40;
            const h = Math.max(min, maxHeight ? Math.min(msg.payload, maxHeight) : msg.payload);
            setContentHeight(h);
          }
          break;
        case "focus":
          setEditorFocused(!!msg.payload);
          break;
        case "format":
          if (msg.payload && typeof msg.payload === "object") {
            setFormatState(msg.payload as FormatState);
            onFormatStateRef.current?.(msg.payload as FormatState);
          }
          break;
        case "linkTrigger":
          setPicker({ open: true, fromTrigger: true, embed: !!msg.payload?.embed });
          break;
        case "linkTriggerEnd":
          setPicker((p) => (p.fromTrigger ? { ...p, open: false } : p));
          break;
        case "openRef":
          if (msg.payload?.type && msg.payload?.id) onOpenRefRef.current?.(msg.payload);
          break;
        case "linkSearch": {
          const src = linkSourceRef.current;
          Promise.resolve(src ? src.search(msg.payload.query, msg.payload.type) : [])
            .then((r) => resolve(msg.payload.requestId, r))
            .catch(() => resolve(msg.payload.requestId, []));
          break;
        }
        case "linkLookup": {
          const src = linkSourceRef.current;
          Promise.resolve(src ? src.lookup(msg.payload.id) : null)
            .then((r) => resolve(msg.payload.requestId, r))
            .catch(() => resolve(msg.payload.requestId, null));
          break;
        }
        case "docResolve": {
          // Resolve an embedded document to a renderable URL (PLAN §6.9). The host reads the
          // file's bytes and returns a data URL; the WebView can't reach the filesystem itself.
          const src = documentSourceRef.current;
          Promise.resolve(src ? src.resolveUrl(msg.payload.id) : null)
            .then((r) => resolveDoc(msg.payload.requestId, r))
            .catch(() => resolveDoc(msg.payload.requestId, null));
          break;
        }
      }
    } catch {
      // ignore malformed messages
    }
  };

  const onSelect = (item: LinkSuggestion) => {
    inject(
      `window.__insertRef && window.__insertRef(${jsonArg({
        type: item.type,
        id: item.id,
        title: item.title,
        embed: picker.embed,
      })});`,
    );
    setPicker((p) => ({ ...p, open: false }));
  };

  const onCancelPicker = () => {
    if (picker.fromTrigger) inject(`window.__cancelRef && window.__cancelRef();`);
    setPicker((p) => ({ ...p, open: false }));
  };

  // The simple field types `[[` to open the native picker; its keyboard toolbar is skipped
  // (it's a screen-anchored overlay that assumes the full-screen editor's layout).
  const showToolbar = !simple && editorFocused && kbHeight > 0 && !picker.open;

  return (
    <View style={simple ? { height: contentHeight } : styles.root}>
      <WebView
        ref={webRef}
        style={simple ? { height: contentHeight, backgroundColor: "transparent" } : styles.web}
        originWhitelist={["*"]}
        source={{ html }}
        onMessage={onMessage}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
      />

      {showToolbar ? (
        <View style={[styles.toolbar, { bottom: kbHeight }]}>
          <ScrollView
            horizontal
            // Taps must not dismiss the keyboard / blur the document, so the toggles apply
            // to the live selection (which the WebView re-focuses afterward).
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.toolbarContent}
          >
            {linkSource ? (
              <Pressable
                accessibilityLabel="Insert reference"
                style={({ pressed }) => [styles.fmtBtn, pressed && styles.fmtBtnPressed]}
                onPress={() => setPicker({ open: true, fromTrigger: false, embed: false })}
              >
                <Icon name="link" size={20} color="#3e3e3a" />
              </Pressable>
            ) : null}
            {documentSource ? (
              <Pressable
                accessibilityLabel="Attach file"
                style={({ pressed }) => [styles.fmtBtn, pressed && styles.fmtBtnPressed]}
                onPress={() => void pickDocument()}
              >
                <Icon name="file" size={20} color="#3e3e3a" />
              </Pressable>
            ) : null}
            {linkSource || documentSource ? <View style={styles.toolbarDivider} /> : null}
            {FORMAT_BUTTONS.map((b) => {
              const active = !!formatState?.active[b.name];
              const disabled = !!formatState && !formatState.enabled[b.name];
              return (
                <Pressable
                  key={b.name}
                  accessibilityLabel={b.label}
                  disabled={disabled}
                  style={({ pressed }) => [
                    styles.fmtBtn,
                    active && styles.fmtBtnActive,
                    pressed && styles.fmtBtnPressed,
                    disabled && styles.fmtBtnDisabled,
                  ]}
                  onPress={() => inject(`window.__format && window.__format(${jsonArg(b.name)});`)}
                >
                  <Icon name={b.icon} size={20} color={active ? "#b7500a" : "#3e3e3a"} />
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <LinkPicker
        visible={picker.open}
        linkSource={linkSource}
        onSelect={onSelect}
        onCancel={onCancelPicker}
      />
    </View>
  );
});

// The native `[[` picker: a bottom sheet with a search field, a type filter, and results.
function LinkPicker({
  visible,
  linkSource,
  onSelect,
  onCancel,
}: {
  visible: boolean;
  linkSource?: LinkSource;
  onSelect: (item: LinkSuggestion) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<LinkType | "all">("all");
  const [items, setItems] = useState<LinkSuggestion[]>([]);
  const [kbHeight, setKbHeight] = useState(0);
  const inputRef = useRef<TextInput>(null);

  // Reset and focus each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setType("all");
    setItems([]);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [visible]);

  // The sheet is anchored to the bottom of the screen, but the auto-focused search field
  // raises the keyboard — and a Modal renders in its own view hierarchy, so it doesn't
  // avoid the keyboard on its own. Track the keyboard height (mirroring the editor's
  // listeners) and lift the sheet by it so the search field and results stay visible.
  useEffect(() => {
    if (!visible) {
      setKbHeight(0);
      return;
    }
    const showEvt = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [visible]);

  // Debounced search whenever the query or type changes while open.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const t = setTimeout(async () => {
      try {
        const r = linkSource ? await linkSource.search(query, type) : [];
        if (active) setItems(r);
      } catch {
        if (active) setItems([]);
      }
    }, 120);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [visible, query, type, linkSource]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={[styles.sheet, kbHeight > 0 && { marginBottom: kbHeight, paddingBottom: 12 }]}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>Insert reference</Text>
          <Pressable onPress={onCancel} hitSlop={8}>
            <Text style={styles.sheetCancel}>Cancel</Text>
          </Pressable>
        </View>

        <TextInput
          ref={inputRef}
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search links…"
          placeholderTextColor="#9a9a92"
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />

        <View style={styles.typeRow}>
          {TYPES.map((t) => {
            const active = t.value === type;
            return (
              <Pressable
                key={t.value}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setType(t.value)}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <FlatList
          data={items}
          keyExtractor={(it) => `${it.type}:${it.id}`}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No matches</Text>}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              onPress={() => onSelect(item)}
            >
              <Text style={styles.itemType}>{item.type}</Text>
              <Text style={styles.itemTitle} numberOfLines={1}>
                {item.title || item.id}
              </Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },

  toolbar: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 48,
    backgroundColor: "#f7f7f5",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e0e0dc",
  },
  toolbarContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 2,
    height: 48,
  },
  toolbarDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    marginVertical: 10,
    marginHorizontal: 6,
    backgroundColor: "#d8d8d2",
  },
  fmtBtn: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  fmtBtnActive: { backgroundColor: "#fdece0" },
  fmtBtnPressed: { backgroundColor: "#ececea" },
  fmtBtnDisabled: { opacity: 0.35 },

  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.25)" },
  sheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 10,
    // Extra bottom padding so the last result clears the home indicator / screen edge.
    paddingBottom: 32,
    maxHeight: "70%",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  sheetTitle: { fontSize: 16, fontWeight: "700", color: "#1a1a18" },
  sheetCancel: { fontSize: 15, color: "#b7500a", fontWeight: "600" },
  search: {
    marginHorizontal: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "#e0e0dc",
    fontSize: 16,
    color: "#1a1a18",
  },
  typeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  chip: {
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: 999,
    backgroundColor: "#f2f2ef",
  },
  chipActive: { backgroundColor: "#fdece0" },
  chipText: { fontSize: 13, color: "#595954", fontWeight: "500" },
  chipTextActive: { color: "#b7500a" },
  list: { paddingHorizontal: 8 },
  empty: { padding: 16, color: "#9a9a92" },
  item: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  itemPressed: { backgroundColor: "#fdece0" },
  itemType: {
    fontSize: 11,
    fontWeight: "700",
    color: "#b7500a",
    textTransform: "uppercase",
  },
  itemTitle: { flex: 1, fontSize: 16, color: "#1a1a18" },
});
