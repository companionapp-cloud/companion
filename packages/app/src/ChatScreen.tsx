import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text as RNText, View } from "react-native";
import {
  Avatar,
  BrandMark,
  Button,
  colors,
  control,
  font,
  Icon,
  icon as iconSize,
  IconButton,
  Input,
  Kbd,
  layout,
  motion,
  radius,
  row,
  shadow,
  space,
  Spinner,
  SplitView,
  Text,
  transition,
  useDensity,
  type PressState,
} from "@companion/design-system";
import { Editor, type LinkRef, type LinkSource } from "@companion/editor";
import { runtimeLabel, type Agent, type Chat, type StoredChatMessage } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useLinkSource } from "./useLinkSource";
import { useNav } from "./nav-context";
import { timeAgo } from "./NotificationRow";
import { useSync } from "./SyncProvider";

/** OpenEntityContext lets wikilink chips navigate without threading the shell's navigator
 *  through every component; each shell supplies its own handler. */
const OpenEntityContext = createContext<((type: string, id: string) => void) | undefined>(undefined);

/** How messages are drawn. "transcript" is the desktop thread — a 640px column of avatar +
 *  mono speaker label + prose, no bubbles. "bubbles" is the touch layout the floating
 *  composer pairs with. */
type ThreadLayout = "transcript" | "bubbles";
const ThreadLayoutContext = createContext<ThreadLayout>("transcript");

// ===========================================================================
// ChatView — the shell-agnostic conversation pane, bound to one persisted chat.
// ===========================================================================

/** ChatView renders one persisted chat (PLAN §6.8). It reads messages from the store,
 *  streams the assistant's reply live, and — because the run happens in the core on a
 *  background goroutine — picks up the finished answer via chat.changed even if it was
 *  opened after the run started (or on another device, once synced). Carries no window
 *  chrome; the desktop shell wraps it in a detail pane, the mobile shell in a stack screen. */
export function ChatView({
  chatId,
  onOpenEntity,
  onConfigure,
  composer = "bar",
  bottomInset = 0,
}: {
  chatId: string;
  onOpenEntity?: (type: string, id: string) => void;
  /** Called from the empty state's "Set up in Settings" button; each shell routes to its own
   *  Settings → AI screen. When omitted, the empty state shows guidance only. */
  onConfigure?: () => void;
  composer?: "bar" | "floating";
  bottomInset?: number;
}) {
  const { chats, llm, agents: agentsApi } = useCore();
  const linkSource = useLinkSource();
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [working, setWorking] = useState(false);
  const [live, setLive] = useState<{ text: string; actions: ToolAction[] } | null>(null);
  const [configs, setConfigs] = useState<Agent[] | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  // The model is chosen per chat from the agent's live list (fetched when configId changes).
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  // The composer editor is uncontrolled; `draft` mirrors it (for the send button's enabled
  // state) while `draftRef` holds the freshest content for the button's send. Bumping
  // `sendTick` empties the editor after a send.
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const [sendTick, setSendTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const floating = composer === "floating";

  const scrollRef = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null);

  // Load (and reload) this chat's transcript from the store.
  const reload = useCallback(() => {
    chats
      .get(chatId)
      .then((d) => {
        setMessages(d.messages);
        setTitle(d.chat.title);
        setConfigId((cur) => cur ?? d.chat.configId ?? null);
        setModel((cur) => cur ?? d.chat.model ?? null);
        setWorking(d.working);
      })
      .catch((e) => setError(String(e)));
  }, [chats, chatId]);
  useEffect(() => {
    setLive(null);
    reload();
  }, [reload]);

  // Agent list for the selector (re-fetched when agents or their online state change).
  const reloadConfigs = useCallback(() => agentsApi.list().then(setConfigs).catch(() => {}), [agentsApi]);
  useEffect(() => {
    void reloadConfigs();
  }, [reloadConfigs]);
  useEffect(() => agentsApi.onChanged(() => void reloadConfigs()), [agentsApi, reloadConfigs]);
  useEffect(() => {
    if (!configs || configs.length === 0) return;
    setConfigId((cur) => (cur && configs.some((c) => c.id === cur) ? cur : (configs.find((c) => c.isDefault) ?? configs[0]).id));
  }, [configs]);

  // Fetch the chosen agent's live model list whenever it changes.
  useEffect(() => {
    if (!configId) {
      setModels(null);
      return;
    }
    let alive = true;
    setModels(null);
    agentsApi
      .models(configId)
      .then((m) => alive && setModels(m))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [configId, agentsApi]);

  // Default the model to the first one offered, but keep an already-chosen model even if it's
  // not in the live list (e.g. a config restored from a chat, or an Ollama model not pulled here).
  useEffect(() => {
    if (!models || models.length === 0) return;
    setModel((cur) => cur ?? models[0]);
  }, [models]);

  // Switching agent clears the model so it re-seeds from the new agent's list.
  const pickConfig = useCallback((id: string) => {
    setConfigId(id);
    setModel(null);
  }, []);

  // Live streaming + background completion, all filtered to this chat.
  useEffect(() => {
    const offChanged = chats.onChanged((e) => {
      if (e.chatId === chatId) reload();
    });
    const offWorking = chats.onWorking((e) => {
      if (e.chatId !== chatId) return;
      setWorking(e.working);
      if (!e.working) setLive(null); // the persisted reply arrives via chat.changed
    });
    const offToken = llm.onToken((e) => {
      if (e.chatId !== chatId) return;
      setLive((cur) => ({ text: (cur?.text ?? "") + e.text, actions: cur?.actions ?? [] }));
    });
    const offTool = llm.onTool((e) => {
      if (e.chatId !== chatId) return;
      setLive((cur) => ({ text: cur?.text ?? "", actions: [...(cur?.actions ?? []), { name: e.call.name, isError: !!e.result.isError }] }));
    });
    const offError = llm.onError((e) => {
      if (e.chatId === chatId) setError(e.error);
    });
    return () => {
      offChanged();
      offWorking();
      offToken();
      offTool();
      offError();
    };
  }, [chats, llm, chatId, reload]);

  const hasProvider = (configs?.length ?? 0) > 0;
  const currentAgent = configs?.find((c) => c.id === configId) ?? null;
  // A local agent hosted by another device is only usable while that host is reachable.
  const hostOffline = !!currentAgent && !!currentAgent.hostDeviceId && !currentAgent.online;
  const canSend = hasProvider && !!model && !hostOffline;

  const stop = useCallback(() => {
    void chats.cancel(chatId).catch(() => {});
  }, [chats, chatId]);

  // `raw` is the editor's exact content on Enter; the send button passes draftRef instead.
  const send = useCallback(async (raw?: string) => {
    const text = (raw ?? draftRef.current).trim();
    if (!text || working || !canSend) return;
    setDraft("");
    draftRef.current = "";
    setSendTick((t) => t + 1); // empty the composer editor
    setError(null);
    setLive({ text: "", actions: [] });
    setWorking(true);
    try {
      await chats.send(chatId, text, configId ?? undefined, model ?? undefined);
    } catch (e) {
      setError(String(e));
      setWorking(false);
      setLive(null);
    }
  }, [working, canSend, chats, chatId, configId, model]);

  const onDraftChange = useCallback((md: string) => {
    draftRef.current = md;
    setDraft(md);
  }, []);

  const items = useMemo(() => flatten(messages), [messages]);

  // The transcript is bottom-anchored: short chats sit just above the composer, and the view
  // scrolls to the newest message on open and as replies stream in — the latest is always
  // the first thing you see.
  const isThread = hasProvider && (items.length > 0 || live !== null || working);
  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
  }, [messages, live, working, chatId]);

  const threadRows: ReactNode[] = [];
  items.forEach((it, i) => threadRows.push(<ChatItem key={`m${i}`} item={it} />));
  if (live || working) {
    (live?.actions ?? []).forEach((a, i) => threadRows.push(<ActionLine key={`la${i}`} action={a} />));
    threadRows.push(
      <Message key="live" role="assistant" working>
        {live?.text ? <WikiText value={live.text} /> : <RNText style={styles.thinking}>Thinking…</RNText>}
      </Message>,
    );
  }

  const sendDisabled = working || !draft.trim() || !canSend;
  const selector = (placement: "header" | "below") => (
    <SelectorBar
      placement={placement}
      configs={configs ?? []}
      configId={configId}
      onPickConfig={pickConfig}
      models={models}
      model={model}
      onPickModel={setModel}
    />
  );

  return (
    <OpenEntityContext.Provider value={onOpenEntity}>
      <ThreadLayoutContext.Provider value={floating ? "bubbles" : "transcript"}>
        <View style={styles.root}>
          {/* Desktop thread header: the chat title and the mono model line, which is also
              the provider / model picker. The mobile shells title the screen themselves. */}
          {!floating ? (
            <View style={styles.header}>
              <Text variant="label" numberOfLines={1} style={styles.headerTitle}>
                {title || "New chat"}
              </Text>
              {hasProvider ? selector("header") : null}
              {onConfigure ? (
                <IconButton label="Model settings" size="sm" onPress={onConfigure}>
                  <Icon name="settings" size={13} color={colors.textSecondary} />
                </IconButton>
              ) : null}
            </View>
          ) : null}

          <ScrollView
            ref={scrollRef as never}
            style={styles.scroll}
            contentContainerStyle={isThread ? (floating ? styles.threadBubbles : styles.threadTranscript) : styles.scrollInner}
          >
            {!hasProvider && configs !== null ? (
              <EmptyState onConfigure={onConfigure} />
            ) : !isThread ? (
              <View style={styles.center}>
                <Text variant="caption" tone="tertiary" style={styles.hint}>
                  Ask about your notes and tasks, or tell me to create one. I can search, then act.
                </Text>
              </View>
            ) : (
              threadRows
            )}
          </ScrollView>
          {error ? (
            <Text variant="caption" tone="danger" style={styles.error}>
              {error}
            </Text>
          ) : hostOffline && currentAgent ? (
            <Text variant="caption" tone="tertiary" style={styles.error}>
              {currentAgent.hostName || "The computer hosting this agent"} is offline. {currentAgent.name} will be available when it’s back.
            </Text>
          ) : null}

          {hasProvider &&
            (floating ? (
              <View style={[styles.floatingWrap, { paddingBottom: space.lg + bottomInset }]}>
                <View style={styles.floatingBar}>
                  <View style={styles.floatingInput}>
                    <Composer
                      placeholder="Message…"
                      onChangeMarkdown={onDraftChange}
                      onSubmit={(md) => void send(md)}
                      clearSignal={sendTick}
                      linkSource={linkSource}
                      onOpenRef={(ref) => onOpenEntity?.(ref.type, ref.id)}
                    />
                  </View>
                  <Pressable
                    onPress={() => (working ? stop() : void send())}
                    disabled={working ? false : sendDisabled}
                    aria-label={working ? "Stop" : "Send"}
                    style={({ pressed }: PressState) => [
                      styles.sendCircle,
                      !working && sendDisabled ? styles.sendCircleOff : pressed ? styles.sendCirclePressed : null,
                    ]}
                  >
                    <Icon name={working ? "close" : "chevronRight"} size={18} color={colors.onAccent} />
                  </Pressable>
                </View>
                {selector("below")}
              </View>
            ) : (
              <View style={styles.composer}>
                <ComposerField>
                  <Composer
                    placeholder="Message your assistant…"
                    onChangeMarkdown={onDraftChange}
                    onSubmit={(md) => void send(md)}
                    clearSignal={sendTick}
                    linkSource={linkSource}
                    onOpenRef={(ref) => onOpenEntity?.(ref.type, ref.id)}
                  />
                </ComposerField>
                {working ? (
                  <Button label="Stop" variant="secondary" onPress={stop} />
                ) : (
                  <Button label="Send" onPress={() => void send()} disabled={sendDisabled} />
                )}
              </View>
            ))}
        </View>
      </ThreadLayoutContext.Provider>
    </OpenEntityContext.Provider>
  );
}

/** The desktop composer shell: the same box as `Input` (hairline, 4px radius, focus edge +
 *  ring) around the growing editor, with the ⏎ hint in the trailing slot. */
function ComposerField({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  // Focus events bubble from the editor's contenteditable on web; they aren't View props
  // in the native typings, hence the cast. Native never renders this (it uses "floating").
  const focusProps = { onFocus: () => setFocused(true), onBlur: () => setFocused(false) } as Record<string, unknown>;
  return (
    <View
      {...focusProps}
      style={[
        styles.field,
        transition("border-color, box-shadow", motion.fast),
        focused ? styles.fieldFocused : null,
        focused ? focusRing : null,
      ]}
    >
      <View style={styles.fieldInput}>{children}</View>
      <View style={styles.fieldTrailing}>
        <Kbd>⏎</Kbd>
      </View>
    </View>
  );
}

const focusRing = Platform.OS === "web" ? ({ boxShadow: `0 0 0 2px ${colors.focusRing}` } as Record<string, unknown>) : null;

// ===========================================================================
// ChatList — reusable chat list column (desktop detail pane + mobile screen).
// ===========================================================================

export function ChatList({
  chats,
  selectedId,
  onSelect,
  onNew,
  onDelete,
  variant = "sidebar",
}: {
  chats: Chat[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete?: (id: string) => void;
  /** "sidebar" is the desktop list column (dense 24px rows, mono time, hover-revealed
   *  delete); "full" fills a mobile screen as one grouped card of 60px rows and drops the
   *  internal header (the stack header already titles it). */
  variant?: "sidebar" | "full";
}) {
  if (variant === "full") {
    return (
      <ScrollView style={styles.listColFull} contentContainerStyle={styles.listFullContent}>
        {chats.length === 0 ? (
          <Text variant="caption" tone="tertiary" style={styles.listEmpty}>
            No chats yet. Start one.
          </Text>
        ) : (
          <View style={styles.card}>
            {chats.map((c, i) => (
              <Pressable
                key={c.id}
                onPress={() => onSelect(c.id)}
                aria-label={c.title || "New chat"}
                style={({ pressed }: PressState) => [styles.cardRow, pressed ? styles.rowPressed : null]}
              >
                <Icon name="chat" size={19} color={colors.textTertiary} />
                <View style={[styles.cardRowBody, i === chats.length - 1 ? null : styles.cardRowDivider]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="label" numberOfLines={1}>
                      {c.title || "New chat"}
                    </Text>
                    {/* A sentence subtitle, as the mobile card rows write it — not mono metadata. */}
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                      Last message {timeAgo(c.updatedAt)}
                    </Text>
                  </View>
                  {c.working ? (
                    <Spinner inline size={13} />
                  ) : onDelete ? (
                    <IconButton label="Delete chat" size="md" onPress={() => onDelete(c.id)}>
                      <Icon name="trash" size={iconSize.md} color={colors.textTertiary} />
                    </IconButton>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <View style={styles.listCol}>
      <View style={styles.listHeader}>
        <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
          Chats
        </Text>
        <Text variant="mono" tone="quaternary">
          {chats.length}
        </Text>
        <IconButton label="New chat" size="sm" onPress={onNew}>
          <Icon name="plus" size={iconSize.sm} color={colors.textSecondary} />
        </IconButton>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listScroll}>
        {chats.length === 0 ? (
          <Text variant="caption" tone="tertiary" style={styles.listEmpty}>
            No chats yet. Start one with ＋.
          </Text>
        ) : (
          chats.map((c) => <ChatRow key={c.id} chat={c} selected={c.id === selectedId} onSelect={onSelect} onDelete={onDelete} />)
        )}
      </ScrollView>
    </View>
  );
}

/** One dense list row. ListRow's trailing slot is text-only, and this row swaps its mono
 *  time for a spinner while a reply generates and for a delete button on hover. */
function ChatRow({
  chat,
  selected,
  onSelect,
  onDelete,
}: {
  chat: Chat;
  selected: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const touch = useDensity() === "touch";
  return (
    <Pressable
      onPress={() => onSelect(chat.id)}
      aria-label={chat.title || "New chat"}
      style={({ hovered, pressed }: PressState) => [
        styles.listRow,
        transition("background-color", motion.fast),
        { minHeight: touch ? row.touch : row.h },
        selected ? styles.rowSelected : pressed ? styles.rowPressed : hovered ? styles.rowHover : null,
      ]}
    >
      {({ hovered }: PressState) => (
        <>
          <Icon name="chat" size={iconSize.sm} color={selected ? colors.textAccent : colors.textQuaternary} />
          <Text variant="label" tone={selected ? "accent" : "default"} numberOfLines={1} style={styles.listRowTitle}>
            {chat.title || "New chat"}
          </Text>
          {chat.working ? (
            <Spinner inline size={iconSize.sm} />
          ) : onDelete && (hovered || touch) ? (
            <IconButton label="Delete chat" size={touch ? undefined : "sm"} onPress={() => onDelete(chat.id)}>
              <Icon name="trash" size={touch ? iconSize.md : iconSize.sm} color={colors.textTertiary} />
            </IconButton>
          ) : (
            <Text variant="mono" tone="quaternary" numberOfLines={1}>
              {timeAgo(chat.updatedAt)}
            </Text>
          )}
        </>
      )}
    </Pressable>
  );
}

// ===========================================================================
// ChatsScreen — the desktop/web route: content/detail split like notes & tasks.
// ===========================================================================

export function ChatsScreen() {
  const { chats: chatsApi, agents: agentsApi } = useCore();
  const nav = useNav();
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [configs, setConfigs] = useState<Agent[] | null>(null);

  const reload = useCallback(() => chatsApi.list().then(setChats).catch(() => {}), [chatsApi]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const a = chatsApi.onChanged(() => void reload());
    const b = chatsApi.onWorking(() => void reload());
    return () => {
      a();
      b();
    };
  }, [chatsApi, reload]);

  const reloadConfigs = useCallback(() => agentsApi.list().then(setConfigs).catch(() => {}), [agentsApi]);
  useEffect(() => {
    void reloadConfigs();
  }, [reloadConfigs]);
  useEffect(() => agentsApi.onChanged(() => void reloadConfigs()), [agentsApi, reloadConfigs]);

  useEffect(() => {
    setSelectedId((cur) => (cur && chats.some((c) => c.id === cur) ? cur : (chats[0]?.id ?? null)));
  }, [chats]);

  const newChat = useCallback(async () => {
    const c = await chatsApi.create();
    await reload();
    setSelectedId(c.id);
  }, [chatsApi, reload]);

  const removeChat = useCallback(
    async (id: string) => {
      await chatsApi.remove(id);
      await reload();
    },
    [chatsApi, reload],
  );

  const noProvider = configs !== null && configs.length === 0;
  const onOpen = (type: string, id: string) => (type === "task" ? nav.openTask(id) : nav.openNote(id));
  const openSettings = () => nav.goView("settings");

  // Rendered directly (no Frame) — the AppShell already wraps every screen in a Frame card,
  // so self-wrapping here would produce a card-inside-a-card (double border + gray inset).
  return noProvider ? (
    <EmptyState onConfigure={openSettings} />
  ) : (
    <SplitView
      aside={<ChatList chats={chats} selectedId={selectedId} onSelect={setSelectedId} onNew={newChat} onDelete={removeChat} />}
      storageKey="companion.chat.listWidth"
      defaultWidth={220}
      minWidth={180}
      maxWidth={320}
    >
      <View style={styles.detail}>
        {selectedId ? (
          <ChatView chatId={selectedId} onOpenEntity={onOpen} onConfigure={openSettings} />
        ) : (
          <View style={styles.center}>
            <Text variant="caption" tone="tertiary" style={styles.hint}>
              Pick a chat from the list, or start a new one.
            </Text>
          </View>
        )}
      </View>
    </SplitView>
  );
}

// --- display model ---------------------------------------------------------

type ToolAction = { name: string; isError: boolean };
type DisplayItem =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "action"; name: string; isError: boolean }
  | { type: "note"; noteId: string };

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** flatten turns the stored transcript into a render list: user/assistant bubbles plus one
 *  action line per tool call (paired with its result for error state). */
function flatten(messages: StoredChatMessage[]): DisplayItem[] {
  const resultErr: Record<string, boolean> = {};
  for (const m of messages) {
    for (const r of asArray<{ callId?: string; isError?: boolean }>(m.toolResults)) {
      if (r.callId) resultErr[r.callId] = !!r.isError;
    }
  }
  const items: DisplayItem[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.text) items.push({ type: "user", text: m.text });
    if (m.role === "assistant") {
      for (const tc of asArray<{ id?: string; name?: string; args?: { id?: string } }>(m.toolCalls)) {
        if (tc.name === "render_note" && tc.args?.id) {
          items.push({ type: "note", noteId: tc.args.id });
        } else {
          items.push({ type: "action", name: tc.name ?? "", isError: tc.id ? !!resultErr[tc.id] : false });
        }
      }
      if (m.text) items.push({ type: "assistant", text: m.text });
    }
  }
  return items;
}

function ChatItem({ item }: { item: DisplayItem }) {
  if (item.type === "action") return <ActionLine action={item} />;
  if (item.type === "note") return <NotePreview id={item.noteId} />;
  return (
    <Message role={item.type}>
      <WikiText value={item.text} />
    </Message>
  );
}

/** NotePreview renders the inline, clickable note card the render_note tool asks for — the
 *  assistant shows a note this way instead of pasting its Markdown. Loads the live note body
 *  and renders a lightweight Markdown preview; clicking opens the full note. */
function NotePreview({ id }: { id: string }) {
  const { notes } = useCore();
  const openEntity = useContext(OpenEntityContext);
  const threadLayout = useContext(ThreadLayoutContext);
  const [note, setNote] = useState<{ title: string; contentMd: string } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    notes
      .get(id)
      .then((n) => {
        if (alive) setNote({ title: n.title, contentMd: n.contentMd });
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [notes, id]);
  if (missing) return null;
  return (
    <View style={[styles.notePreviewWrap, threadLayout === "transcript" ? styles.actionRowTranscript : null]}>
      <Pressable style={styles.notePreview} onPress={() => openEntity?.("note", id)} aria-label={note?.title ?? "Note"}>
        <View style={styles.notePreviewHead}>
          <Icon name="file" size={iconSize.sm} color={colors.textQuaternary} />
          <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
            {note?.title || "Untitled"}
          </Text>
          <Icon name="external" size={11} color={colors.textQuaternary} />
        </View>
        {note && <View style={styles.notePreviewBody}>{renderNotePreview(note.contentMd)}</View>}
      </Pressable>
    </View>
  );
}

/** renderNotePreview is a minimal Markdown renderer for the inline card: headings, bullets,
 *  blockquotes, and paragraphs, with wikilinks made clickable. Capped to keep previews short. */
function renderNotePreview(md: string): ReactNode {
  const lines = md.split("\n");
  const shown = lines.slice(0, 16);
  const out: ReactNode[] = [];
  shown.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (/^##\s/.test(line)) {
      out.push(<RNText key={i} style={styles.mdH2}>{line.replace(/^##\s+/, "")}</RNText>);
    } else if (/^#\s/.test(line)) {
      out.push(<RNText key={i} style={styles.mdH1}>{line.replace(/^#\s+/, "")}</RNText>);
    } else if (/^[-*]\s+/.test(line)) {
      out.push(
        <View key={i} style={styles.mdLi}>
          <RNText style={styles.mdBullet}>•</RNText>
          <View style={{ flex: 1 }}>
            <WikiText value={line.replace(/^[-*]\s+/, "")} />
          </View>
        </View>,
      );
    } else if (/^>\s+/.test(line)) {
      out.push(
        <View key={i} style={styles.mdQuote}>
          <WikiText value={line.replace(/^>\s+/, "")} />
        </View>,
      );
    } else if (line.trim() === "") {
      out.push(<View key={i} style={{ height: space.xs }} />);
    } else {
      out.push(<WikiText key={i} value={line} />);
    }
  });
  if (lines.length > shown.length) out.push(<RNText key="more" style={styles.mdMore}>…</RNText>);
  return out;
}

/** One turn. Desktop: an 18px avatar (you) or brand mark (companion), a mono speaker label,
 *  then prose — no bubble. Touch: a bubble, soft accent for you and sunken for the assistant. */
function Message({ role, working = false, children }: { role: "user" | "assistant"; working?: boolean; children: ReactNode }) {
  const threadLayout = useContext(ThreadLayoutContext);
  const isUser = role === "user";
  if (threadLayout === "bubbles") {
    return (
      <View style={[styles.bubbleRow, isUser ? styles.rowEnd : styles.rowStart]}>
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>{children}</View>
      </View>
    );
  }
  return (
    <View style={styles.message}>
      {isUser ? <UserAvatar /> : <BrandMark size={18} />}
      <View style={styles.messageBody}>
        <View style={styles.messageLabel}>
          <Text variant="mono" tone="quaternary">
            {isUser ? "you" : "companion"}
          </Text>
          {working ? <Spinner inline size={10} /> : null}
        </View>
        {children}
      </View>
    </View>
  );
}

/** Initials for the signed-in account; a local-only workspace is just "You". */
function UserAvatar() {
  const sync = useSync();
  return <Avatar name={sync.email ?? "You"} size="sm" />;
}

/** A tool the assistant ran, printed above its reply: mono, quiet, lowercase. */
function ActionLine({ action }: { action: ToolAction }) {
  const threadLayout = useContext(ThreadLayoutContext);
  return (
    <View style={[styles.actionRow, threadLayout === "transcript" ? styles.actionRowTranscript : null]}>
      <Icon name={action.isError ? "close" : "check"} size={iconSize.sm} color={action.isError ? colors.danger : colors.textQuaternary} />
      <Text variant="mono" tone="quaternary">
        {humanizeTool(action.name)}
        {action.isError ? " · failed" : ""}
      </Text>
    </View>
  );
}

function humanizeTool(name: string): string {
  const map: Record<string, string> = {
    get_date: "checked the date",
    search_notes: "searched your notes",
    get_note: "read a note",
    get_task: "read a task",
    list_tasks: "checked your tasks",
    list_projects: "checked your projects",
    list_project_items: "looked inside a project",
    get_neighborhood: "looked at what's connected",
    get_backlinks: "found linked mentions",
    read_from_internet: "read a web page",
    read_from_google: "searched the web",
    render_note: "showed a note",
    create_note: "created a note",
    update_note: "updated a note",
    create_task: "created a task",
    update_task: "updated a task",
    // CLI agents (Claude Code / Codex) report their own tools.
    Read: "read a file",
    Glob: "listed files",
    Grep: "searched files",
    Bash: "ran a command",
    shell: "ran a command",
    Edit: "edited a file",
    Write: "wrote a file",
    edit: "edited files",
    WebFetch: "read a web page",
    WebSearch: "searched the web",
    web_search: "searched the web",
    Task: "delegated to a subagent",
  };
  return map[name] ?? name.replace(/_/g, " ");
}

// --- wikilink rendering ----------------------------------------------------

const WIKILINK = /!?\[\[(note|task|habit|project):([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function WikiText({ value }: { value: string }) {
  const threadLayout = useContext(ThreadLayoutContext);
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  WIKILINK.lastIndex = 0;
  let key = 0;
  while ((m = WIKILINK.exec(value)) !== null) {
    if (m.index > last) parts.push(<RNText key={key++}>{value.slice(last, m.index)}</RNText>);
    parts.push(<LinkChip key={key++} type={m[1]} id={m[2]} />);
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(<RNText key={key++}>{value.slice(last)}</RNText>);
  return <RNText style={[styles.body, threadLayout === "bubbles" ? styles.bodyBubble : null]}>{parts}</RNText>;
}

function LinkChip({ type, id }: { type: string; id: string }) {
  const { graph } = useCore();
  const openEntity = useContext(OpenEntityContext);
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    graph
      .lookup(id)
      .then((n) => {
        if (alive) setTitle(n?.title ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [graph, id]);
  return (
    <RNText style={styles.chip} onPress={() => openEntity?.(type, id)}>
      {title ?? type}
    </RNText>
  );
}

// --- composer --------------------------------------------------------------

/** The message input: a "simple" ProseMirror editor (plain text + `[[` reference chips).
 *  Uncontrolled — it reports edits via onChangeMarkdown and submits on Enter (Shift-Enter
 *  makes a new line); bumping clearSignal empties it after a send. */
function Composer({
  placeholder,
  onChangeMarkdown,
  onSubmit,
  clearSignal,
  linkSource,
  onOpenRef,
}: {
  placeholder: string;
  onChangeMarkdown: (md: string) => void;
  onSubmit: (md: string) => void;
  clearSignal: unknown;
  linkSource: LinkSource;
  onOpenRef: (ref: LinkRef) => void;
}) {
  return (
    <Editor
      variant="simple"
      markdown=""
      placeholder={placeholder}
      onChangeMarkdown={onChangeMarkdown}
      onSubmit={onSubmit}
      clearSignal={clearSignal}
      linkSource={linkSource}
      onOpenRef={onOpenRef}
      minHeight={24}
      maxHeight={120}
      debounceMs={120}
    />
  );
}

// --- agent + model selectors ------------------------------------------------

/** configLabel describes an agent for the picker: its runtime, plus where it runs for local
 *  ones ("Claude Code · Chris's MacBook · offline"). */
function configLabel(c: Agent): string {
  const parts = [runtimeLabel(c.runtime)];
  if (c.hostDeviceId) {
    parts.push(c.hostedHere ? "this computer" : c.hostName || "another device");
    if (!c.online) parts.push("offline");
  }
  return parts.join(" · ");
}

/** SelectorBar is the agent + model picker. "header" is the desktop thread header's mono
 *  model line (`model · provider`, menus open downward); "below" sits under the floating
 *  composer (`provider › model`, menus open upward). The provider is a picker only when
 *  there is more than one; the model lists what the chosen provider offers live. */
function SelectorBar({
  placement,
  configs,
  configId,
  onPickConfig,
  models,
  model,
  onPickModel,
}: {
  placement: "header" | "below";
  configs: Agent[];
  configId: string | null;
  onPickConfig: (id: string) => void;
  models: string[] | null;
  model: string | null;
  onPickModel: (m: string) => void;
}) {
  if (configs.length === 0) return null;
  const current = configs.find((c) => c.id === configId) ?? configs[0];
  const opens = placement === "header" ? "down" : "up";
  const provider =
    configs.length >= 2 ? (
      <Dropdown
        label={current.name}
        ariaLabel="Choose an agent"
        opens={opens}
        options={configs.map((c) => ({ value: c.id, label: `${c.name} — ${configLabel(c)}` }))}
        value={current.id}
        onSelect={onPickConfig}
      />
    ) : (
      <Text variant="mono" tone="quaternary" numberOfLines={1}>
        {current.name}
      </Text>
    );
  const modelPicker = <ModelSelector models={models} model={model} onPickModel={onPickModel} opens={opens} />;
  return placement === "header" ? (
    <View style={styles.selectorHeader}>
      {modelPicker}
      <Text variant="mono" tone="quaternary">
        ·
      </Text>
      {provider}
    </View>
  ) : (
    <View style={styles.selectorBelow}>
      {provider}
      <Icon name="chevronRight" size={10} color={colors.textQuaternary} />
      {modelPicker}
    </View>
  );
}

function ModelSelector({
  models,
  model,
  onPickModel,
  opens,
}: {
  models: string[] | null;
  model: string | null;
  onPickModel: (m: string) => void;
  opens: "up" | "down";
}) {
  // Loading (models === null) or the endpoint returned none / failed (empty): let the user
  // type a model name so a running-but-unlisted server (or a fresh Ollama pull) still works.
  if (models === null) {
    return (
      <Text variant="mono" tone="quaternary">
        loading models…
      </Text>
    );
  }
  if (models.length === 0) {
    return (
      <View style={styles.modelInputWrap}>
        <Input mono size={opens === "down" ? "sm" : undefined} value={model ?? ""} onChangeText={onPickModel} placeholder="Model name" autoCapitalize="none" />
      </View>
    );
  }
  return (
    <Dropdown
      label={model ?? "choose a model"}
      ariaLabel="Choose a model"
      opens={opens}
      options={models.map((m) => ({ value: m, label: m }))}
      value={model}
      onSelect={onPickModel}
    />
  );
}

/** Dropdown is the menu both selectors share: a mono trigger and an overlay list that opens
 *  up (under the floating composer) or down (from the thread header). */
function Dropdown({
  label,
  ariaLabel,
  opens,
  options,
  value,
  onSelect,
}: {
  label: string;
  ariaLabel: string;
  opens: "up" | "down";
  options: { value: string; label: string }[];
  value: string | null;
  onSelect: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const touch = useDensity() === "touch";
  return (
    <View style={open ? styles.selectorOpen : null}>
      {open ? (
        <>
          {/* Full-bleed scrim closes the menu on an outside tap. */}
          <Pressable style={styles.selectorScrim} onPress={() => setOpen(false)} aria-label="Close menu" />
          <ScrollView style={[styles.selectorMenu, opens === "down" ? styles.selectorMenuDown : styles.selectorMenuUp]}>
            {options.map((o) => (
              <Pressable
                key={o.value}
                aria-label={o.label}
                onPress={() => {
                  onSelect(o.value);
                  setOpen(false);
                }}
                style={({ hovered, pressed }: PressState) => [
                  styles.selectorOption,
                  { minHeight: touch ? row.touch : row.h },
                  pressed ? styles.rowPressed : hovered ? styles.rowHover : null,
                ]}
              >
                <Text variant="mono" tone={o.value === value ? "accent" : "secondary"} numberOfLines={1} style={{ flex: 1 }}>
                  {o.label}
                </Text>
                {o.value === value ? <Icon name="check" size={iconSize.sm} color={colors.textAccent} /> : null}
              </Pressable>
            ))}
          </ScrollView>
        </>
      ) : null}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        hitSlop={touch ? 12 : undefined}
        style={({ hovered, pressed }: PressState) => [
          styles.selectorTrigger,
          transition("background-color", motion.instant),
          pressed || open ? styles.rowPressed : hovered ? styles.rowHover : null,
        ]}
      >
        <Text variant="mono" tone="quaternary" numberOfLines={1} style={styles.selectorLabel}>
          {label}
        </Text>
        <Icon name="chevronDown" size={10} color={colors.textQuaternary} />
      </Pressable>
    </View>
  );
}

function EmptyState({ onConfigure }: { onConfigure?: () => void }) {
  return (
    <View style={styles.empty}>
      <Icon name="chat" size={iconSize.tile} color={colors.textQuaternary} />
      <Text variant="title">No agent yet</Text>
      <Text variant="caption" tone="tertiary" style={styles.emptyBody}>
        Install an agent to chat with your notes and tasks: Claude Code, Codex or Ollama found on your computer, or an
        Anthropic / OpenAI key. Then pick a model here.
      </Text>
      {onConfigure ? (
        <Button label="Set up in Settings" onPress={onConfigure} icon={<Icon name="settings" size={iconSize.sm} color={colors.onAccent} />} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  // --- desktop list column
  listCol: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  listScroll: { padding: space.xs, gap: 1 },
  listEmpty: { padding: space.xl, lineHeight: 18, textAlign: "center" },
  listRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.sm, paddingRight: space.xxs, borderRadius: radius.sm },
  listRowTitle: { flex: 1, minWidth: 0 },
  rowHover: { backgroundColor: colors.surfaceHover },
  rowPressed: { backgroundColor: colors.surfaceActive },
  rowSelected: { backgroundColor: colors.surfaceSelected },
  // --- mobile list: one grouped card, hairlines inset past the leading icon
  listColFull: { flex: 1, backgroundColor: colors.surfaceApp },
  listFullContent: { padding: space.xl, paddingBottom: 92 },
  card: { backgroundColor: colors.surfaceCard, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" },
  cardRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingLeft: 14 },
  cardRowBody: { flex: 1, minWidth: 0, minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.md, paddingRight: space.lg },
  cardRowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  // --- thread
  detail: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surfaceCard },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
    // Above the transcript (a later sibling) so the model menu opens over it.
    zIndex: 10,
  },
  headerTitle: { flex: 1, minWidth: 0 },
  scroll: { flex: 1 },
  scrollInner: { padding: space.xxl, flexGrow: 1 },
  // Bottom-anchored transcript: content packs to the bottom (newest just above the composer)
  // when short, and scrolls normally when it overflows.
  threadTranscript: { flexGrow: 1, justifyContent: "flex-end", gap: 14, paddingVertical: space.xl, paddingHorizontal: space.xl2 },
  threadBubbles: { flexGrow: 1, justifyContent: "flex-end", gap: space.ml, padding: space.lg, paddingBottom: space.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl },
  hint: { textAlign: "center", maxWidth: 360, lineHeight: 18 },
  message: { flexDirection: "row", alignItems: "flex-start", gap: space.md, maxWidth: 640, width: "100%", alignSelf: "center" },
  messageBody: { flex: 1, minWidth: 0, gap: space.xxs },
  messageLabel: { flexDirection: "row", alignItems: "center", gap: space.sm, height: 18 },
  bubbleRow: { flexDirection: "row", width: "100%" },
  rowStart: { justifyContent: "flex-start" },
  rowEnd: { justifyContent: "flex-end" },
  bubble: { maxWidth: "84%", paddingVertical: space.md, paddingHorizontal: space.lg, borderRadius: radius.xl, borderWidth: 1 },
  userBubble: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  assistantBubble: { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
  body: { fontFamily: font.sans, fontSize: font.size.md, lineHeight: 21, color: colors.textPrimary },
  bodyBubble: { lineHeight: 20 },
  thinking: { fontFamily: font.sans, fontSize: font.size.md, lineHeight: 21, color: colors.textTertiary, fontStyle: "italic" },
  chip: { color: colors.textAccent, fontWeight: font.weight.medium, textDecorationLine: "underline", textDecorationColor: colors.accentSoftBorder },
  actionRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.xxs },
  // In the transcript, tool lines and note cards sit in the prose column (past the 18px mark).
  actionRowTranscript: { maxWidth: 640, width: "100%", alignSelf: "center", paddingLeft: 18 + space.md },
  notePreviewWrap: { width: "100%" },
  notePreview: { alignSelf: "flex-start", maxWidth: "92%", backgroundColor: colors.surfaceCard, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" },
  notePreviewHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: layout.subToolbarH,
    paddingHorizontal: space.ml,
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  notePreviewBody: { padding: space.ml, gap: 3, maxHeight: 280, overflow: "hidden" },
  mdH1: { fontFamily: font.sans, fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.textPrimary, marginBottom: 2 },
  mdH2: { fontFamily: font.sans, fontSize: font.size.base, fontWeight: font.weight.semibold, color: colors.textPrimary, marginTop: space.xs },
  mdLi: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  mdBullet: { color: colors.textQuaternary, fontSize: font.size.md, lineHeight: 21 },
  mdQuote: { borderLeftWidth: 2, borderLeftColor: colors.borderDefault, paddingLeft: space.md },
  mdMore: { color: colors.textQuaternary, fontSize: font.size.md },
  error: { paddingHorizontal: space.xl, paddingVertical: space.sm, textAlign: "center" },
  // --- desktop composer
  composer: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: colors.borderSubtle, flexShrink: 0 },
  field: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    minHeight: control.md,
    paddingHorizontal: space.sm,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.md,
  },
  fieldFocused: { borderColor: colors.borderFocus },
  fieldInput: { flex: 1, minWidth: 0, justifyContent: "center", paddingVertical: 1 },
  fieldTrailing: { height: control.md - 2, justifyContent: "center" },
  // --- floating (touch) composer: floats over the thread, so it is the one shadowed thing here
  floatingWrap: { paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.lg, flexShrink: 0 },
  floatingBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.md,
    paddingLeft: 14,
    paddingRight: space.xs,
    paddingVertical: space.xs,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.xl,
    ...shadow.md,
  },
  floatingInput: { flex: 1, justifyContent: "center", minHeight: 34, paddingVertical: space.xs },
  sendCircle: { width: 34, height: 34, borderRadius: radius.full, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  sendCirclePressed: { backgroundColor: colors.accentActive },
  sendCircleOff: { backgroundColor: colors.borderStrong },
  // --- provider · model selectors
  selectorHeader: { flexDirection: "row", alignItems: "center", gap: space.xxs, flexShrink: 1, minWidth: 0 },
  selectorBelow: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingTop: space.md, paddingLeft: space.xs },
  selectorOpen: { zIndex: 20 },
  selectorScrim: { position: "absolute", top: 0, left: 0, width: 4000, height: 4000, marginLeft: -2000, marginTop: -2000 },
  modelInputWrap: { width: 180 },
  selectorTrigger: { flexDirection: "row", alignItems: "center", gap: space.xs, height: control.xs, paddingHorizontal: space.xs, borderRadius: radius.sm, maxWidth: 260 },
  selectorLabel: { flexShrink: 1 },
  selectorMenu: {
    position: "absolute",
    minWidth: 220,
    maxWidth: 320,
    maxHeight: 280,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    padding: space.xs,
    zIndex: 20,
    ...shadow.md,
  },
  selectorMenuDown: { top: control.xs + space.xs, right: 0 },
  selectorMenuUp: { bottom: control.xs + space.xs, left: 0 },
  selectorOption: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, borderRadius: radius.sm },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xxl },
  emptyBody: { textAlign: "center", maxWidth: 360, lineHeight: 18 },
});
