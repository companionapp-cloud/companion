import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Platform, Pressable, ScrollView, View } from "react-native";
import { Button, Icon, Text, colors, icon as iconSize, radius, space, useDensity, type IconName, type PressState } from "@companion/design-system";
import { Editor, type DocumentSource, type EditorController, type FormatState, type LinkRef } from "@companion/editor";
import type { PageFields } from "@companion/core-bridge";
import { FormattingBar } from "./FormattingBar";
import { EmojiPicker } from "./EmojiPicker";
import { tableMenuPresenter } from "./tableMenu";
import { useLinkSource } from "./useLinkSource";
import { useQuickCreateLink } from "./useQuickCreateLink";
import { useDocumentSource } from "./DocumentSourceContext";
import { useTasks } from "./TasksProvider";
import { DocTitleField } from "./TaskEditor";

/** The page an area or a project opens on (PLAN-areas.md §1, §3): an optional cover image, an
 *  optional emoji, the name, a rich-text description — the same markdown editor a note uses,
 *  so it links objects, embeds files and formats like one — then the cards its host supplies
 *  (projects, tasks, notes, canvases) and a footer for settings. Shared by the desktop/web
 *  page and the mobile screens; density picks the metrics. */
export function ContainerOverview({
  name,
  namePlaceholder,
  icon,
  fallbackIcon = "folder",
  color,
  coverDocumentId,
  descriptionMd,
  onRename,
  onUpdatePage,
  onOpenRef,
  documentSource: documentSourceProp,
  children,
  footer,
}: {
  name: string;
  namePlaceholder: string;
  icon?: string | null;
  /** The glyph shown in place of an emoji until one is picked. */
  fallbackIcon?: IconName;
  color?: string | null;
  coverDocumentId?: string | null;
  descriptionMd: string;
  onRename: (name: string) => void;
  /** Persist a page field; an empty `icon` / `coverDocumentId` clears it. */
  onUpdatePage: (fields: PageFields) => void;
  /** A link chip in the description was followed. */
  onOpenRef?: (ref: LinkRef) => void;
  /** Overrides the context's document source (the mobile shell supplies its own). */
  documentSource?: DocumentSource;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const touch = useDensity() === "touch";
  const contextSource = useDocumentSource();
  const documentSource = documentSourceProp ?? contextSource;
  const linkSource = useLinkSource();
  const tasks = useTasks();
  const editorRef = useRef<EditorController>(null);
  const quickCreate = useQuickCreateLink(editorRef);
  const [formatState, setFormatState] = useState<FormatState | null>(null);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState(name);
  // The name can change under us (a rename synced from another device) — but never while
  // this field is the one being typed in, which `title !== name` right after a keystroke is.
  const lastSaved = useRef(name);
  useEffect(() => {
    if (name !== lastSaved.current) {
      lastSaved.current = name;
      setTitle(name);
    }
  }, [name]);

  // The formatting bar belongs to the description: it shows while that editor has focus. A
  // bar button briefly blurs the editor before the action refocuses it, so hiding waits a beat.
  const [editorFocused, setEditorFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleFocusChange = useCallback((focused: boolean) => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = null;
    if (focused) setEditorFocused(true);
    else blurTimer.current = setTimeout(() => setEditorFocused(false), 200);
  }, []);
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  const cover = useCoverUrl(documentSource, coverDocumentId);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const changeCover = async () => {
    if (!documentSource || coverBusy) return;
    setCoverBusy(true);
    setCoverError(null);
    try {
      const id = await pickCoverImage(documentSource);
      if (id) onUpdatePage({ coverDocumentId: id });
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : "That image couldn’t be added.");
    } finally {
      setCoverBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {coverDocumentId ? (
          <View style={[styles.cover, touch ? styles.coverTouch : null]}>
            {cover ? <Image source={{ uri: cover }} resizeMode="cover" style={styles.coverImage} accessibilityLabel="Cover image" /> : null}
            <View style={styles.coverActions}>
              {documentSource ? <Button label={coverBusy ? "Adding…" : "Change cover"} variant="secondary" size="sm" disabled={coverBusy} onPress={() => void changeCover()} /> : null}
              <Button label="Remove" variant="secondary" size="sm" onPress={() => onUpdatePage({ coverDocumentId: "" })} />
            </View>
          </View>
        ) : null}

        <View style={[styles.column, touch ? styles.columnTouch : null]}>
          <View style={styles.identity}>
            <Pressable
              onPress={() => setPicking((v) => !v)}
              aria-label={icon ? "Change icon" : "Add icon"}
              style={({ hovered, pressed }: PressState) => [
                styles.iconButton,
                // An emoji pulls up over the cover's bottom edge, the way a page icon does.
                coverDocumentId ? styles.iconOverCover : null,
                { backgroundColor: pressed ? colors.surfaceActive : hovered || picking ? colors.surfaceHover : coverDocumentId ? colors.surfaceCard : "transparent" },
              ]}
            >
              {icon ? <Text style={styles.emoji}>{icon}</Text> : <Icon name={fallbackIcon} size={28} color={color ?? colors.textQuaternary} />}
            </Pressable>
            <View style={styles.pageActions}>
              {!icon ? <GhostAction icon="plus" label="Add icon" onPress={() => setPicking(true)} /> : null}
              {!coverDocumentId && documentSource ? (
                <GhostAction icon="image" label={coverBusy ? "Adding cover…" : "Add cover"} onPress={() => void changeCover()} />
              ) : null}
            </View>
          </View>
          {picking ? (
            <EmojiPicker
              value={icon}
              onPick={(emoji) => {
                onUpdatePage({ icon: emoji });
                setPicking(false);
              }}
              onRemove={() => {
                onUpdatePage({ icon: "" });
                setPicking(false);
              }}
              onClose={() => setPicking(false)}
            />
          ) : null}
          {coverError ? (
            <Text variant="caption" tone="danger">
              {coverError}
            </Text>
          ) : null}

          <DocTitleField
            value={title}
            placeholder={namePlaceholder}
            onChangeText={(t) => {
              setTitle(t);
              // A name is required; an emptied field keeps the last good one until typed into.
              if (t.trim()) {
                lastSaved.current = t.trim();
                onRename(t.trim());
              }
            }}
          />

          <View style={styles.description}>
            <Editor
              ref={editorRef}
              markdown={descriptionMd}
              // The full editor, hugging its content: it sits between the title and the cards.
              inline
              placeholder="Add a description…"
              minHeight={touch ? 48 : 32}
              onChangeMarkdown={(md) => onUpdatePage({ descriptionMd: md })}
              linkSource={linkSource}
              documentSource={documentSource}
              onOpenRef={onOpenRef}
              onQuickCreate={quickCreate.onQuickCreate}
              onFormatStateChange={setFormatState}
              onFocusChange={handleFocusChange}
              tableMenuPresenter={tableMenuPresenter()}
              linkRevision={tasks.tasks}
            />
          </View>

          {children ? <View style={styles.cards}>{children}</View> : null}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </ScrollView>
      {/* Web/desktop formatting bar (native has its own keyboard toolbar), pinned under the page
          while the description is being edited. */}
      {Platform.OS === "web" && editorFocused ? <FormattingBar state={formatState} editorRef={editorRef} canAttach={!!documentSource} /> : null}
      {quickCreate.dialog}
    </View>
  );
}

/** One card of the overview: a titled, bordered list capped by its host (up to 10 rows), with
 *  the true total beside the title and a "View all" row at the bottom. */
export function OverviewCard({
  title,
  count,
  empty,
  onViewAll,
  viewAllLabel = "View all",
  action,
  children,
}: {
  title: string;
  /** The total behind the card, which may exceed the rows shown. */
  count: number;
  /** Shown instead of rows when there are none. */
  empty: string;
  onViewAll?: () => void;
  viewAllLabel?: string;
  /** A header affordance, e.g. a ＋ button. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
          {title}
        </Text>
        <Text variant="mono" tone="quaternary">
          {count}
        </Text>
        <View style={{ flex: 1 }} />
        {action}
      </View>
      {count > 0 ? (
        <View style={styles.cardRows}>{children}</View>
      ) : (
        <Text variant="caption" tone="tertiary" style={styles.cardEmpty}>
          {empty}
        </Text>
      )}
      {onViewAll && count > 0 ? (
        <Pressable
          onPress={onViewAll}
          aria-label={`${viewAllLabel}: ${title}`}
          style={({ hovered, pressed }: PressState) => [
            styles.viewAll,
            { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
          ]}
        >
          <Text variant="caption" tone="secondary">
            {viewAllLabel}
          </Text>
          <Icon name="chevronRight" size={iconSize.sm} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** How many rows an overview card shows before "View all" (PLAN-areas.md §3). */
export const OVERVIEW_LIMIT = 10;

function GhostAction({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.ghost,
        { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      <Icon name={icon} size={iconSize.sm} color={colors.textTertiary} />
      <Text variant="caption" tone="tertiary">
        {label}
      </Text>
    </Pressable>
  );
}

/** Resolves a cover's document id to a URL the Image can load, downloading its bytes on first
 *  view. Object URLs are revoked when the cover changes or the page unmounts. */
function useCoverUrl(documentSource: DocumentSource | undefined, documentId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!documentSource || !documentId) return;
    let cancelled = false;
    let resolved: string | null = null;
    void documentSource
      .resolveUrl(documentId)
      .then((doc) => {
        if (!doc) return;
        resolved = doc.url;
        if (cancelled) revoke(resolved);
        else setUrl(doc.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (resolved) revoke(resolved);
    };
  }, [documentSource, documentId]);
  return url;
}

function revoke(url: string) {
  if (url.startsWith("blob:") && typeof URL !== "undefined") URL.revokeObjectURL(url);
}

/** Lets the user choose an image and stages it as a document, returning its id (null when
 *  they cancel). Web and desktop ingest a File from a file input; mobile opens the OS picker. */
async function pickCoverImage(documentSource: DocumentSource): Promise<string | null> {
  if (documentSource.ingest && Platform.OS === "web" && typeof document !== "undefined") {
    const file = await chooseImageFile();
    if (!file) return null;
    if (!file.type.startsWith("image/")) throw new Error("A cover has to be an image.");
    return (await documentSource.ingest(file)).id;
  }
  if (documentSource.pick) {
    const picked = await documentSource.pick();
    if (!picked) return null;
    // The OS picker isn't limited to images, so check what came back.
    const doc = await documentSource.resolveUrl(picked.id);
    if (doc && !doc.mime.startsWith("image/")) throw new Error("A cover has to be an image.");
    return picked.id;
  }
  return null;
}

function chooseImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    // Dismissing the dialog fires `cancel` where supported; elsewhere the promise simply
    // never settles, which leaves nothing behind but this detached input.
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

const styles = {
  root: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surfaceCard },
  scroll: { paddingBottom: space.xxl },
  cover: { height: 200, backgroundColor: colors.surfaceHover, overflow: "hidden" as const },
  coverTouch: { height: 160 },
  coverImage: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, width: "100%" as const, height: "100%" as const },
  coverActions: { position: "absolute" as const, right: space.md, bottom: space.md, flexDirection: "row" as const, gap: space.xs },
  // The page column: full width, capped where lines stay readable, centred past that.
  column: { width: "100%" as const, maxWidth: 960, alignSelf: "center" as const, paddingHorizontal: space.xxl, paddingTop: space.lg, gap: space.sm },
  columnTouch: { paddingHorizontal: space.lg },
  identity: { flexDirection: "row" as const, alignItems: "flex-end" as const, gap: space.sm },
  iconButton: { width: 56, height: 56, borderRadius: radius.lg, alignItems: "center" as const, justifyContent: "center" as const },
  iconOverCover: { marginTop: -(28 + space.lg) },
  emoji: { fontSize: 40, lineHeight: 48 },
  pageActions: { flexDirection: "row" as const, gap: space.xxs, paddingBottom: space.xs },
  ghost: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, height: 22, paddingHorizontal: 6, borderRadius: radius.sm },
  description: { marginTop: space.xs },
  // Cards flow two-up where there is room and stack where there isn't.
  cards: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md, marginTop: space.lg },
  card: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 320,
    minWidth: 0,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
  cardHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    minHeight: 32,
    paddingLeft: space.md,
    paddingRight: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  cardRows: { padding: space.xs, gap: 1 },
  cardEmpty: { paddingHorizontal: space.md, paddingVertical: space.md, lineHeight: 18 },
  viewAll: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: space.xs,
    minHeight: 30,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
  footer: { marginTop: space.xl, gap: space.sm },
};
