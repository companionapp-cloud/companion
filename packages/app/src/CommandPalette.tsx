import { useEffect, useRef } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Icon, Kbd, ListRow, Spinner, Text, colors, control, font, icon, radius, space, type PressState } from "@companion/design-system";
import { CaptureFields, SAVE_HINT } from "./CaptureForm";
import { modeLabel, modePlaceholder, type PaletteItem } from "./paletteModel";
import { useCommandPalette, type CommandPaletteController, type CommandPaletteHost } from "./useCommandPalette";

/**
 * The command palette (PLAN §6.4): one input over a list. Empty, the list is the commands —
 * new task / note / canvas, then the find commands; typing narrows them and searches every
 * title at once. A find command scopes the search (the chip in the input) to one kind of thing,
 * by title or by day; a create command turns the input into the new item's title, with the
 * task's project chips and due / reminder questions, or the note's body — the full note editor,
 * with its formatting bar — beneath it.
 *
 * Keyboard-first: ↑↓ move, ⏎ runs, ⌫ on an empty input or Esc steps back out, Esc at the root
 * closes. ⇧⏎ is ⏎ into a new tab: a result opens in a tab of its own, and a new task, note or
 * canvas is saved and then opened in one (a shift-click on a result does the same). A new task's projects are a Tab away: each chip is a stop (←→ also walk them), and ⏎
 * on one saves the task into it; Space picks one to keep while you Tab on to the dates. The host draws the surface around it — the quick-capture window's floating card, or
 * the in-app overlay — and says what opening a result means (see CommandPaletteHost).
 */
export function CommandPalette(host: CommandPaletteHost) {
  const p = useCommandPalette(host);
  const { onClose, attachments = true } = host;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputRef = useRef<any>(null);
  const creating = p.mode.kind === "create";

  // Stepping in or out of a command hands focus back to the input.
  useEffect(() => {
    const raf = typeof requestAnimationFrame === "undefined" ? null : requestAnimationFrame(() => inputRef.current?.focus?.());
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [p.mode]);

  // Capture phase, so the palette's keys win over the focused field or ProseMirror editor —
  // except a bare Enter inside the note body, which is a new line there.
  const { move, submit, back, query, projectChoices, toggleProject } = p;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const inBody = !!target?.closest(".ProseMirror");
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const chip = target?.closest(CHIP_SELECTOR);
      if (chip && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === " ")) {
        // The chips render in `projectChoices` order, so a chip's place is its project.
        const chips = Array.from(document.querySelectorAll<HTMLElement>(CHIP_SELECTOR));
        const at = chips.indexOf(chip as HTMLElement);
        take();
        if (e.key === " ") {
          // Handled here rather than left to Pressable, which only takes Space on buttons.
          const choice = projectChoices[at];
          if (choice) toggleProject(choice.id);
        } else chips[at + (e.key === "ArrowRight" ? 1 : -1)]?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (creating) return;
        take();
        move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        if (e.isComposing || (inBody && !(e.metaKey || e.ctrlKey))) return;
        take();
        submit(e.shiftKey);
      } else if (e.key === "Escape") {
        // The note body's `[[` picker or table menu is up: Esc is theirs, and closes only that.
        if (editorPopupOpen()) return;
        take();
        if (!back()) onClose();
      } else if (e.key === "Backspace" && query === "" && target === inputNode(inputRef.current)) {
        // ⌫ on an empty input drops the command chip.
        if (back()) take();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [creating, move, submit, back, query, onClose, projectChoices, toggleProject]);

  // Keep the selected row in view as the arrows walk past the fold.
  const rowNodes = useRef(new Map<number, unknown>());
  useEffect(() => {
    const node = rowNodes.current.get(p.selected) as { scrollIntoView?: (o: { block: string }) => void } | undefined;
    node?.scrollIntoView?.({ block: "nearest" });
  }, [p.selected, p.items]);

  const chip = modeLabel(p.mode);
  return (
    <View style={styles.palette}>
      <View style={styles.inputRow}>
        {p.busy ? <Spinner size={icon.lg} inline /> : <Icon name={creating ? "plus" : "search"} size={icon.lg} color={colors.textTertiary} />}
        {chip ? (
          <View style={styles.chip}>
            <Text variant="label" tone="accent">
              {chip}
            </Text>
          </View>
        ) : null}
        <TextInput
          ref={inputRef}
          value={p.query}
          onChangeText={p.setQuery}
          placeholder={modePlaceholder(p.mode)}
          placeholderTextColor={colors.textQuaternary}
          autoFocus
          autoCapitalize="none"
          style={styles.input}
        />
      </View>

      {creating ? (
        p.mode.kind === "create" && p.mode.what !== "canvas" ? (
          <View style={styles.fields}>
            {p.mode.what === "task" ? <ProjectChips p={p} /> : null}
            <CaptureFields c={p.capture} hideTitle attachments={attachments} />
          </View>
        ) : null
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {p.items.map((item, i) => (
            <View key={item.key}>
              {i === 0 || p.items[i - 1].section !== item.section ? (
                <Text variant="mono" tone="quaternary" style={styles.section}>
                  {item.section.toLowerCase()}
                </Text>
              ) : null}
              <View
                ref={(node: unknown) => {
                  if (node) rowNodes.current.set(i, node);
                  else rowNodes.current.delete(i);
                }}
                onPointerMove={() => {
                  if (p.selected !== i) p.setSelected(i);
                }}
              >
                <PaletteRow item={item} selected={i === p.selected} onPress={(newTab) => p.run(item, newTab)} />
              </View>
            </View>
          ))}
          {p.emptyText ? (
            <Text variant="caption" tone="tertiary" style={styles.empty}>
              {p.emptyText}
            </Text>
          ) : null}
        </ScrollView>
      )}

      <View style={styles.footer}>
        {creating ? (
          <>
            <Hint
              keys="⏎"
              label={p.mode.kind === "create" && p.mode.what === "canvas" ? (p.target ? `create in ${p.target.name}` : "create and open") : p.target ? `save to ${p.target.name}` : "save"}
            />
            <Hint keys="⇧⏎" label={p.mode.kind === "create" && p.mode.what === "canvas" ? "open in new tab" : "save and open"} />
            {p.mode.kind === "create" && p.mode.what === "task" && p.projectChoices.length > 0 ? (
              p.focusedProjectId ? <Hint keys="space" label={p.focusedProjectId === p.projectId ? "unpick" : "pick"} /> : <Hint keys="tab" label="project" />
            ) : null}
            {p.mode.kind === "create" && p.mode.what === "note" ? <Hint keys={SAVE_HINT} label="save from the body" /> : null}
          </>
        ) : (
          <>
            <Hint keys="↑↓" label="move" />
            <Hint keys="⏎" label={p.items[p.selected]?.action.type === "open" ? "open" : "select"} />
            {p.items[p.selected]?.action.type === "open" ? <Hint keys="⇧⏎" label="new tab" /> : null}
          </>
        )}
        <View style={{ flex: 1 }} />
        <Hint keys="esc" label={p.mode.kind === "root" && !p.query ? "close" : "back"} />
      </View>
    </View>
  );
}

/** The new task's project, as a pick-one row of chips in the Tab order between the title and
 *  the dates. The focused chip is where ⏎ saves to; Space (or a click) picks one that sticks
 *  once focus moves on. */
function ProjectChips({ p }: { p: CommandPaletteController }) {
  if (p.projectChoices.length === 0) return null;
  return (
    <View style={styles.chipField}>
      <Text variant="label">Which project?</Text>
      <ScrollView style={styles.chipScroll} contentContainerStyle={styles.chips}>
        {p.projectChoices.map((c) => {
          const on = c.id === p.projectId;
          const focused = c.id === p.focusedProjectId;
          return (
            <Pressable
              key={c.id}
              role="radio"
              aria-checked={on}
              aria-label={c.name}
              onPress={() => p.toggleProject(c.id)}
              onFocus={() => p.setFocusedProject(c.id)}
              onBlur={() => p.setFocusedProject(null)}
              style={({ hovered, pressed }: PressState) => [
                styles.projectChip,
                on ? styles.projectChipOn : { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
                focused ? styles.projectChipFocused : null,
              ]}
            >
              <Text variant="caption" tone={on || focused ? "accent" : "secondary"} numberOfLines={1}>
                {c.icon ? `${c.icon} ${c.name}` : c.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// The chips are the palette's only radios.
const CHIP_SELECTOR = '[role="radio"]';

function PaletteRow({ item, selected, onPress }: { item: PaletteItem; selected: boolean; onPress: (newTab: boolean) => void }) {
  return (
    <ListRow
      title={item.title}
      subtitle={item.subtitle}
      trailing={item.trailing}
      selected={selected}
      hasChildren={item.action.type === "mode"}
      icon={<Icon name={item.icon} size={icon.sm} color={selected ? colors.textAccent : colors.textQuaternary} />}
      // A shift-click is ⇧⏎: the press carries the DOM event's modifiers on web.
      onPress={(e) => onPress(!!(e?.nativeEvent as { shiftKey?: boolean } | undefined)?.shiftKey)}
    />
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <View style={styles.hint}>
      <Kbd>{keys}</Kbd>
      <Text variant="mono" tone="quaternary">
        {label}
      </Text>
    </View>
  );
}

const reducedMotion = Platform.OS === "web" && typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** How the palette arrives: it drops in from just above, overshoots a touch and settles — a
 *  bounce, pivoting on the top edge it hangs from. For the host's card (the palette itself has
 *  no surface). Nothing on native, or when the system asks for reduced motion. */
export const paletteEnter =
  Platform.OS === "web" && !reducedMotion
    ? // Through StyleSheet.create: react-native-web only compiles keyframes for registered styles.
      StyleSheet.create({
        enter: {
          animationKeyframes: [
            {
              // CSS strings: keyframes skip the resolver that turns RN transform arrays into CSS.
              "0%": { opacity: 0, transform: "translateY(-14px) scale(0.92)" },
              "55%": { opacity: 1, transform: "translateY(3px) scale(1.025)" },
              "78%": { transform: "translateY(-1px) scale(0.992)" },
              "100%": { opacity: 1, transform: "translateY(0) scale(1)" },
            },
          ],
          animationDuration: "320ms",
          animationTimingFunction: "cubic-bezier(0.2, 0, 0.2, 1)",
          animationFillMode: "both",
          transformOrigin: "top center",
        } as Record<string, unknown>,
      }).enter
    : null;

/** Whether one of the editor's own popups is showing: the `[[` picker (kept in the DOM, hidden
 *  while closed) or the table menu (there only while open). */
function editorPopupOpen(): boolean {
  const picker = document.querySelector<HTMLElement>(".pm-wikilink-menu");
  return (!!picker && picker.style.display !== "none") || !!document.querySelector(".pm-table-menu");
}

/** The DOM input behind a react-native-web TextInput ref (which is the node itself). */
const inputNode = (ref: unknown) => ref as EventTarget | null;

const LIST_MAX_HEIGHT = 340;

const styles = StyleSheet.create({
  palette: { minHeight: 0, flexShrink: 1 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    height: 48,
    paddingHorizontal: space.xl,
    flexShrink: 0,
  },
  chip: {
    flexShrink: 0,
    paddingHorizontal: space.sm,
    paddingVertical: space.xxs,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSelected,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 48,
    color: colors.textPrimary,
    fontFamily: font.sans,
    fontSize: font.size.xl,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
  list: { maxHeight: LIST_MAX_HEIGHT, flexShrink: 1, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  listContent: { padding: space.sm, gap: 1 },
  section: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: space.xs },
  empty: { paddingHorizontal: space.sm, paddingVertical: space.lg },
  fields: { padding: space.xl, gap: space.ml, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  chipField: { gap: space.xs },
  // Three rows of chips, then it scrolls; a focused chip scrolls itself into view.
  chipScroll: { maxHeight: 3 * control.sm + 2 * space.xs + 4, flexGrow: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, padding: 2 },
  projectChip: {
    flexDirection: "row",
    alignItems: "center",
    height: control.sm,
    maxWidth: 220,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
  projectChipOn: { borderColor: colors.accentSoftBorder, backgroundColor: colors.accentSoft },
  projectChipFocused: {
    borderColor: colors.borderFocus,
    ...(Platform.OS === "web" ? ({ boxShadow: `0 0 0 2px ${colors.focusRing}` } as Record<string, unknown>) : null),
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    paddingHorizontal: space.xl,
    height: 32,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    flexShrink: 0,
  },
  hint: { flexDirection: "row", alignItems: "center", gap: space.xs },
});
