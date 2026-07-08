import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text as RNText, View } from "react-native";
import {
  Button,
  colors,
  font,
  Icon,
  IconButton,
  Input,
  radius,
  shadow,
  space,
  Spinner,
} from "@companion/design-system";
import { Editor, type LinkRef, type LinkSource } from "@companion/editor";
import type { Chat, LLMConfig, StoredChatMessage } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useLinkSource } from "./useLinkSource";
import { useNav } from "./nav-context";

/** OpenEntityContext lets wikilink chips navigate without threading the shell's navigator
 *  through every component; each shell supplies its own handler. */
const OpenEntityContext = createContext<((type: string, id: string) => void) | undefined>(undefined);

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
  const { chats, llm } = useCore();
  const linkSource = useLinkSource();
  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [working, setWorking] = useState(false);
  const [live, setLive] = useState<{ text: string; actions: ToolAction[] } | null>(null);
  const [configs, setConfigs] = useState<LLMConfig[] | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  // The model is chosen per chat from the provider's live list (fetched when configId changes).
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  // The composer editor is uncontrolled; `draft` mirrors it (for the send button's enabled
  // state) while `draftRef` holds the freshest content for the button's send. Bumping
  // `sendTick` empties the editor after a send.
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const [sendTick, setSendTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null);

  // Load (and reload) this chat's transcript from the store.
  const reload = useCallback(() => {
    chats
      .get(chatId)
      .then((d) => {
        setMessages(d.messages);
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

  // Provider list for the selector.
  const reloadConfigs = useCallback(() => llm.configs.list().then(setConfigs).catch(() => {}), [llm]);
  useEffect(() => {
    void reloadConfigs();
  }, [reloadConfigs]);
  useEffect(() => llm.onConfigsChanged(() => void reloadConfigs()), [llm, reloadConfigs]);
  useEffect(() => {
    if (!configs || configs.length === 0) return;
    setConfigId((cur) => (cur && configs.some((c) => c.id === cur) ? cur : (configs.find((c) => c.isDefault) ?? configs[0]).id));
  }, [configs]);

  // Fetch the chosen provider's live model list whenever it changes.
  useEffect(() => {
    if (!configId) {
      setModels(null);
      return;
    }
    let alive = true;
    setModels(null);
    llm.models
      .list(configId)
      .then((m) => alive && setModels(m))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [configId, llm]);

  // Default the model to the first one offered, but keep an already-chosen model even if it's
  // not in the live list (e.g. a config restored from a chat, or an Ollama model not pulled here).
  useEffect(() => {
    if (!models || models.length === 0) return;
    setModel((cur) => cur ?? models[0]);
  }, [models]);

  // Switching provider clears the model so it re-seeds from the new provider's list.
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
  const canSend = hasProvider && !!model;

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
      <Bubble key="live" role="assistant">
        {live?.text ? <WikiText value={live.text} /> : <RNText style={styles.thinking}>Thinking…</RNText>}
      </Bubble>,
    );
  }

  return (
    <OpenEntityContext.Provider value={onOpenEntity}>
      <View style={styles.root}>
        <ScrollView ref={scrollRef as never} style={styles.scroll} contentContainerStyle={isThread ? styles.threadAnchored : styles.scrollInner}>
          {!hasProvider && configs !== null ? (
            <EmptyState onConfigure={onConfigure} />
          ) : !isThread ? (
            <View style={styles.center}>
              <RNText style={styles.hint}>Ask about your notes and tasks, or tell me to create one. I can search, then act.</RNText>
            </View>
          ) : (
            threadRows
          )}
        </ScrollView>
        {error && <RNText style={styles.error}>{error}</RNText>}

        {hasProvider &&
          (composer === "floating" ? (
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
                <Pressable onPress={() => void send()} disabled={working || !draft.trim() || !canSend} aria-label="Send" style={[styles.sendCircle, (working || !draft.trim() || !canSend) && styles.sendCircleOff]}>
                  <Icon name="chevronRight" size={18} color={colors.onAccent} />
                </Pressable>
              </View>
              <SelectorBar
                configs={configs ?? []}
                configId={configId}
                onPickConfig={pickConfig}
                models={models}
                model={model}
                onPickModel={setModel}
              />
            </View>
          ) : (
            <View style={styles.composerCol}>
              <View style={styles.composer}>
                <View style={styles.input}>
                  <Composer
                    placeholder="Message your assistant…"
                    onChangeMarkdown={onDraftChange}
                    onSubmit={(md) => void send(md)}
                    clearSignal={sendTick}
                    linkSource={linkSource}
                    onOpenRef={(ref) => onOpenEntity?.(ref.type, ref.id)}
                  />
                </View>
                <Button label={working ? "…" : "Send"} onPress={() => void send()} disabled={working || !draft.trim() || !canSend} />
              </View>
              <SelectorBar
                configs={configs ?? []}
                configId={configId}
                onPickConfig={pickConfig}
                models={models}
                model={model}
                onPickModel={setModel}
              />
            </View>
          ))}
      </View>
    </OpenEntityContext.Provider>
  );
}

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
  /** "sidebar" is the fixed desktop detail column; "full" fills a mobile screen and drops
   *  the internal header (the stack header already titles it). */
  variant?: "sidebar" | "full";
}) {
  return (
    <View style={variant === "full" ? styles.listColFull : styles.listCol}>
      {variant === "sidebar" && (
        <View style={styles.listHeader}>
          <RNText style={styles.listTitle}>Chats</RNText>
          <View style={{ flex: 1 }} />
          <IconButton label="New chat" size="sm" onPress={onNew}>
            <Icon name="plus" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
      )}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.sm }}>
        {chats.length === 0 ? (
          <RNText style={styles.listEmpty}>No chats yet. Start one.</RNText>
        ) : (
          chats.map((c) => (
            <Pressable key={c.id} style={[styles.listRow, c.id === selectedId && styles.listRowActive]} onPress={() => onSelect(c.id)} aria-label={c.title || "New chat"}>
              <RNText numberOfLines={1} style={styles.listRowTitle}>
                {c.title || "New chat"}
              </RNText>
              {c.working ? (
                <Spinner />
              ) : onDelete ? (
                <IconButton label="Delete chat" size="sm" onPress={() => onDelete(c.id)}>
                  <Icon name="trash" size={14} color={colors.textTertiary} />
                </IconButton>
              ) : null}
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// ===========================================================================
// ChatsScreen — the desktop/web route: content/detail split like notes & tasks.
// ===========================================================================

export function ChatsScreen() {
  const { chats: chatsApi, llm } = useCore();
  const nav = useNav();
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [configs, setConfigs] = useState<LLMConfig[] | null>(null);

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

  const reloadConfigs = useCallback(() => llm.configs.list().then(setConfigs).catch(() => {}), [llm]);
  useEffect(() => {
    void reloadConfigs();
  }, [reloadConfigs]);
  useEffect(() => llm.onConfigsChanged(() => void reloadConfigs()), [llm, reloadConfigs]);

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
    <View style={styles.split}>
      <ChatList chats={chats} selectedId={selectedId} onSelect={setSelectedId} onNew={newChat} onDelete={removeChat} />
      <View style={styles.detail}>
        {selectedId ? (
          <ChatView chatId={selectedId} onOpenEntity={onOpen} onConfigure={openSettings} />
        ) : (
          <View style={styles.center}>
            <RNText style={styles.hint}>Pick a chat on the left, or start a new one.</RNText>
          </View>
        )}
      </View>
    </View>
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
    <Bubble role={item.type}>
      <WikiText value={item.text} />
    </Bubble>
  );
}

/** NotePreview renders the inline, clickable note card the render_note tool asks for — the
 *  assistant shows a note this way instead of pasting its Markdown. Loads the live note body
 *  and renders a lightweight Markdown preview; clicking opens the full note. */
function NotePreview({ id }: { id: string }) {
  const { notes } = useCore();
  const openEntity = useContext(OpenEntityContext);
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
    <View style={styles.notePreviewWrap}>
      <Pressable style={styles.notePreview} onPress={() => openEntity?.("note", id)} aria-label={note?.title ?? "Note"}>
        <View style={styles.notePreviewHead}>
          <Icon name="file" size={14} color={colors.textTertiary} />
          <RNText style={styles.notePreviewTitle} numberOfLines={1}>
            {note?.title || "Untitled"}
          </RNText>
          <View style={{ flex: 1 }} />
          <Icon name="external" size={12} color={colors.textTertiary} />
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

function Bubble({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  const isUser = role === "user";
  return (
    <View style={[styles.bubbleRow, isUser ? styles.rowEnd : styles.rowStart]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>{children}</View>
    </View>
  );
}

function ActionLine({ action }: { action: ToolAction }) {
  return (
    <View style={styles.actionRow}>
      <Icon name={action.isError ? "close" : "check"} size={13} color={action.isError ? colors.danger : colors.success} />
      <RNText style={styles.actionText}>{humanizeTool(action.name)}</RNText>
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
  };
  return map[name] ?? name.replace(/_/g, " ");
}

// --- wikilink rendering ----------------------------------------------------

const WIKILINK = /!?\[\[(note|task|habit|project):([^\]|]+)(?:\|[^\]]+)?\]\]/g;

function WikiText({ value }: { value: string }) {
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
  return <RNText style={styles.body}>{parts}</RNText>;
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

// --- provider + model selectors --------------------------------------------

function configLabel(c: LLMConfig): string {
  return c.provider === "anthropic" ? "Anthropic" : c.scope === "device" ? "Local" : "OpenAI";
}

/** SelectorBar sits under the composer: the provider picker (hidden when there's only one)
 *  plus the model picker, which lists the models the chosen provider offers live. */
function SelectorBar({
  configs,
  configId,
  onPickConfig,
  models,
  model,
  onPickModel,
}: {
  configs: LLMConfig[];
  configId: string | null;
  onPickConfig: (id: string) => void;
  models: string[] | null;
  model: string | null;
  onPickModel: (m: string) => void;
}) {
  if (configs.length === 0) return null;
  const current = configs.find((c) => c.id === configId) ?? configs[0];
  return (
    <View style={styles.selectorRow}>
      {configs.length >= 2 && (
        <Dropdown
          label={current.name}
          options={configs.map((c) => ({ value: c.id, label: `${c.name} — ${configLabel(c)}` }))}
          value={current.id}
          onSelect={onPickConfig}
        />
      )}
      <ModelSelector models={models} model={model} onPickModel={onPickModel} />
    </View>
  );
}

function ModelSelector({ models, model, onPickModel }: { models: string[] | null; model: string | null; onPickModel: (m: string) => void }) {
  // Loading (models === null) or the endpoint returned none / failed (empty): let the user
  // type a model name so a running-but-unlisted server (or a fresh Ollama pull) still works.
  if (models === null) return <RNText style={styles.selectorLabel}>Loading models…</RNText>;
  if (models.length === 0) {
    return (
      <View style={styles.modelInputWrap}>
        <Input value={model ?? ""} onChangeText={onPickModel} placeholder="Model name" autoCapitalize="none" />
      </View>
    );
  }
  return (
    <Dropdown
      label={model ?? "Choose a model"}
      options={models.map((m) => ({ value: m, label: m }))}
      value={model}
      onSelect={onPickModel}
    />
  );
}

/** Dropdown is the shared upward-opening menu used by both selectors under the composer. */
function Dropdown({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string | null;
  onSelect: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      {open && (
        <View style={styles.selectorMenu}>
          {options.map((o) => (
            <Pressable key={o.value} style={styles.selectorOption} aria-label={o.label} onPress={() => { onSelect(o.value); setOpen(false); }}>
              <RNText style={styles.selectorOptionText} numberOfLines={1}>
                {o.label}
              </RNText>
              {o.value === value && <Icon name="check" size={14} color={colors.accent} />}
            </Pressable>
          ))}
        </View>
      )}
      <Pressable style={styles.selectorTrigger} onPress={() => setOpen((o) => !o)} aria-label="Choose">
        <RNText style={styles.selectorLabel} numberOfLines={1}>
          {label}
        </RNText>
        <View style={{ transform: [{ rotate: open ? "-90deg" : "90deg" }] }}>
          <Icon name="chevronRight" size={13} color={colors.textTertiary} />
        </View>
      </Pressable>
    </View>
  );
}

function EmptyState({ onConfigure }: { onConfigure?: () => void }) {
  return (
    <View style={styles.empty}>
      <Icon name="chat" size={28} color={colors.textTertiary} />
      <RNText style={styles.emptyTitle}>No AI provider yet</RNText>
      <RNText style={styles.emptyBody}>Connect a model to chat with your notes and tasks. Set up a local Ollama server or an OpenAI / Anthropic key in Settings, then pick a model here.</RNText>
      {onConfigure && <Button label="Set up in Settings" onPress={onConfigure} icon={<Icon name="settings" size={15} />} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  split: { flex: 1, flexDirection: "row", minHeight: 0 },
  listCol: { width: 260, flexShrink: 0, borderRightWidth: 1, borderRightColor: colors.borderSubtle, backgroundColor: colors.surfaceCard },
  listColFull: { flex: 1, backgroundColor: colors.surfaceApp },
  listHeader: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  listTitle: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.textSecondary },
  listEmpty: { padding: space.lg, fontSize: font.size.sm, color: colors.textTertiary, textAlign: "center" },
  listRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md },
  listRowActive: { backgroundColor: colors.surfaceSunken },
  listRowTitle: { flex: 1, fontSize: font.size.sm, color: colors.textPrimary },
  detail: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceCard },
  scroll: { flex: 1 },
  scrollInner: { padding: space.xxl, paddingBottom: space.xxxl, flexGrow: 1 },
  // Bottom-anchored transcript: content packs to the bottom (newest just above the composer)
  // when short, and scrolls normally when it overflows.
  threadAnchored: { flexGrow: 1, justifyContent: "flex-end", gap: space.xl, padding: space.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl },
  hint: { color: colors.textTertiary, fontSize: font.size.md, textAlign: "center", maxWidth: 420 },
  bubbleRow: { flexDirection: "row", maxWidth: 720, width: "100%", alignSelf: "center" },
  rowStart: { justifyContent: "flex-start" },
  rowEnd: { justifyContent: "flex-end" },
  bubble: { maxWidth: "84%", paddingVertical: space.md, paddingHorizontal: space.lg, borderRadius: radius.lg },
  userBubble: { backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.accentSoftBorder },
  assistantBubble: { backgroundColor: colors.surfaceSunken, borderWidth: 1, borderColor: colors.borderSubtle },
  body: { fontSize: font.size.md, lineHeight: 22, color: colors.textPrimary },
  thinking: { fontSize: font.size.md, color: colors.textTertiary, fontStyle: "italic" },
  chip: { color: colors.textAccent, fontWeight: font.weight.medium, textDecorationLine: "underline", textDecorationColor: colors.accentSoftBorder },
  actionRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.xs, maxWidth: 720, width: "100%", alignSelf: "center" },
  actionText: { fontSize: font.size.sm, color: colors.textTertiary, fontFamily: font.mono },
  notePreviewWrap: { maxWidth: 720, width: "100%", alignSelf: "center" },
  notePreview: { alignSelf: "flex-start", maxWidth: "92%", backgroundColor: colors.surfaceCard, borderWidth: 1, borderColor: colors.borderDefault, borderRadius: radius.lg, overflow: "hidden" },
  notePreviewHead: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: colors.surfaceSunken, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  notePreviewTitle: { fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.textPrimary },
  notePreviewBody: { padding: space.lg, gap: 3, maxHeight: 280, overflow: "hidden" },
  mdH1: { fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.textPrimary, marginBottom: 2 },
  mdH2: { fontSize: font.size.base, fontWeight: font.weight.semibold, color: colors.textPrimary, marginTop: space.xs },
  mdLi: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  mdBullet: { color: colors.textTertiary, fontSize: font.size.md, lineHeight: 22 },
  mdQuote: { borderLeftWidth: 2, borderLeftColor: colors.accentSoftBorder, paddingLeft: space.md },
  mdMore: { color: colors.textTertiary, fontSize: font.size.md },
  error: { marginTop: space.lg, color: colors.danger, fontSize: font.size.sm, textAlign: "center" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: space.md, padding: space.lg, borderTopWidth: 1, borderTopColor: colors.borderSubtle, backgroundColor: colors.surfaceCard },
  input: { flex: 1, justifyContent: "center", minHeight: 40, paddingVertical: space.sm, paddingHorizontal: space.lg, backgroundColor: colors.surfaceApp, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg },
  floatingWrap: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg },
  floatingBar: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingLeft: space.xl, paddingRight: space.xs, paddingVertical: space.xs, backgroundColor: colors.surfaceCard, borderWidth: 1, borderColor: colors.borderDefault, borderRadius: radius.full, ...shadow.md },
  floatingInput: { flex: 1, justifyContent: "center", minHeight: 30, paddingVertical: space.xs },
  sendCircle: { width: 34, height: 34, borderRadius: radius.full, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendCircleOff: { backgroundColor: colors.borderStrong },
  composerCol: { gap: space.xs },
  selectorRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.md, paddingBottom: space.xs },
  modelInputWrap: { minWidth: 160, maxWidth: 240 },
  selectorTrigger: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.xs, paddingHorizontal: space.sm, maxWidth: "90%" },
  selectorLabel: { fontSize: font.size.xs, color: colors.textTertiary, fontFamily: font.mono },
  selectorMenu: { position: "absolute", bottom: 32, alignSelf: "center", minWidth: 220, maxWidth: "96%", backgroundColor: colors.surfaceCard, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.md, paddingVertical: space.xs, marginBottom: space.xs, zIndex: 20, ...shadow.md },
  selectorOption: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, paddingHorizontal: space.lg },
  selectorOptionText: { flex: 1, fontSize: font.size.sm, color: colors.textPrimary },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, padding: space.xxxl },
  emptyTitle: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colors.textPrimary },
  emptyBody: { fontSize: font.size.base, color: colors.textSecondary, textAlign: "center", maxWidth: 380, lineHeight: 20 },
  emptyNote: { fontSize: font.size.xs, color: colors.textTertiary, textAlign: "center", maxWidth: 380 },
});
