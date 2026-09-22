import { useEffect, useRef } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Icon, Kbd, ListRow, Spinner, Text, colors, control, font, icon, radius, space, type PressState } from "@companion/design-system";
import { CaptureFields, SAVE_HINT } from "./CaptureForm";
import { modeLabel, modePlaceholder, type PaletteItem } from "./paletteModel";
import { useCommandPalette, type CommandPaletteController, type CommandPaletteHost, type PaletteChips } from "./useCommandPalette";

/**
 * The command palette (PLAN §6.4): one input over a list. Empty, the list is the commands —
 * new task / note / canvas / event, then the find commands; typing narrows them and searches
 * every title at once. A find command scopes the search (the chip in the input) to one kind of
 * thing, by title or by day; a create command turns the input into the new item's title, with
 * its questions beneath it — the task's due / reminder, the note's body (the full note editor,
 * with its formatting bar), the event's when / how long — and, at the foot, the chips saying
 * where it goes: a project for a task, note or canvas, a calendar for an event. New event is
 * only there once some calendar takes new events.
 *
 * Keyboard-first: ↑↓ move, ⏎ runs, ⌫ on an empty input or Esc steps back out, Esc at the root
 * closes. ⇧⏎ is ⏎ into a new tab: a result opens in a tab of its own, and a new item is saved
 * and then opened in one — an event, the calendar on its week (a shift-click on a result does
 * the same). The chips come last in the Tab order, after the fields (Tab out of a note's body
 * skips its formatting bar for them): each chip is a stop (←→ also walk them), and ⏎ on one
 * saves the item into it; Space picks one to keep. The host draws the surface around it — the
 * quick-capture window's floating card, or the in-app overlay — and says what opening a result
 * means (see CommandPaletteHost).
 */
export function CommandPalette(host: CommandPaletteHost) {
  const p = useCommandPalette(host);
  const { onClose, attachments = true } = host;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputRef = useRef<any>(null);
  // On the web a View's ref is its DOM node.
  const rootRef = useRef<unknown>(null);
  const creating = p.mode.kind === "create";
  const what = p.mode.kind === "create" ? p.mode.what : null;

  // Stepping in or out of a command hands focus back to the input.
  useEffect(() => {
    const raf = typeof requestAnimationFrame === "undefined" ? null : requestAnimationFrame(() => inputRef.current?.focus?.());
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [p.mode]);

  // Capture phase, so the palette's keys win over the focused field or ProseMirror editor —
  // except a bare Enter inside the note body, which is a new line there.
  const { move, submit, back, query, chips } = p;
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
        // The chips render in `chips.choices` order, so a chip's place is its choice.
        const row = Array.from(chip.closest(CHIP_GROUP_SELECTOR)?.querySelectorAll<HTMLElement>(CHIP_SELECTOR) ?? []);
        const at = row.indexOf(chip as HTMLElement);
        take();
        if (e.key === " ") {
          // Handled here rather than left to Pressable, which only takes Space on buttons.
          const choice = chips?.choices[at];
          if (choice) chips.toggle(choice.id);
        } else row[at + (e.key === "ArrowRight" ? 1 : -1)]?.focus();
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
  }, [creating, move, submit, back, query, onClose, chips]);

  // Tab out of the note body lands on the chips below it — as Tab walks a task's fields down to
  // its chips — rather than on each button of the formatting bar between them. Bubble phase, so
  // the body keeps a Tab it has a use for (nesting a list item, the next table cell): it says so
  // by preventing the default.
  const hasChips = !!chips;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !hasChips) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.defaultPrevented) return;
      const root = rootRef.current as HTMLElement | null;
      const target = e.target instanceof Element ? e.target : null;
      if (!root || !target?.closest(".ProseMirror") || !root.contains(target)) return;
      const first = root.querySelector<HTMLElement>(CHIP_SELECTOR);
      if (!first) return;
      e.preventDefault();
      first.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasChips]);

  // Keep the selected row in view as the arrows walk past the fold.
  const rowNodes = useRef(new Map<number, unknown>());
  useEffect(() => {
    const node = rowNodes.current.get(p.selected) as { scrollIntoView?: (o: { block: string }) => void } | undefined;
    node?.scrollIntoView?.({ block: "nearest" });
  }, [p.selected, p.items]);

  const chip = modeLabel(p.mode);
  return (
    <View ref={rootRef as never} style={styles.palette}>
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
        <>
          {what !== "canvas" ? (
            <View style={styles.fields}>
              <CaptureFields c={p.capture} hideTitle attachments={attachments} />
            </View>
          ) : null}
          {p.chips ? <ChipBand p={p} chips={p.chips} /> : null}
        </>
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
            <Hint keys="⏎" label={saveHint(p)} />
            <Hint keys="⇧⏎" label={what === "canvas" ? "open in new tab" : what === "event" ? "add and open" : "save and open"} />
            {p.chips && p.focusedChip ? (
              // A calendar can't be unpicked: Space only does something on the others.
              p.focusedChip !== p.chips.picked || !p.chips.required ? <Hint keys="space" label={p.focusedChip === p.chips.picked ? "unpick" : "pick"} /> : null
            ) : p.chips && what === "canvas" ? (
              // The canvas's name is its only field, so its chips are the next stop.
              <Hint keys="tab" label={p.chips.noun} />
            ) : null}
            {what === "note" ? <Hint keys={SAVE_HINT} label="save from the body" /> : null}
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

/** What ⏎ does to the new item, for its key hint: where it will be saved, filed or added. */
function saveHint(p: CommandPaletteController): string {
  const what = p.mode.kind === "create" ? p.mode.what : null;
  if (what === "canvas") return p.target ? `create in ${p.target.name}` : "create and open";
  if (what === "event") return p.calendarTarget ? `add to ${p.calendarTarget.name}` : "add";
  return p.target ? `save to ${p.target.name}` : "save";
}

/** Where the new item goes, as a pick-one row of chips at the foot of the palette, last in the
 *  Tab order: the project a task, note or canvas is filed in, or the calendar an event is added
 *  to. The focused chip is where ⏎ saves to; Space (or a click) picks one that sticks once focus
 *  moves on. */
function ChipBand({ p, chips }: { p: CommandPaletteController; chips: PaletteChips }) {
  return (
    <View {...RADIO_GROUP} aria-label={chips.label} style={styles.chipBand}>
      <Text variant="label">{chips.label}</Text>
      <ScrollView style={styles.chipScroll} contentContainerStyle={styles.chips}>
        {chips.choices.map((c) => {
          const on = c.id === chips.picked;
          const focused = c.id === p.focusedChip;
          return (
            <Pressable
              key={c.id}
              role="radio"
              aria-checked={on}
              aria-label={c.name}
              onPress={() => chips.toggle(c.id)}
              onFocus={() => p.setFocusedChip(c.id)}
              onBlur={() => p.setFocusedChip(null)}
              style={({ hovered, pressed }: PressState) => [
                styles.chipItem,
                on ? styles.chipItemOn : { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
                focused ? styles.chipItemFocused : null,
              ]}
            >
              {chips.noun === "calendar" ? <View style={[styles.swatch, { backgroundColor: c.color ?? colors.borderStrong }]} /> : null}
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

// The chips are the palette's only radios, in its only radio group.
const CHIP_SELECTOR = '[role="radio"]';
const CHIP_GROUP_SELECTOR = '[role="radiogroup"]';
// A View's role is not in this RN typing, hence the cast.
const RADIO_GROUP = { role: "radiogroup" } as Record<string, unknown>;

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
  // Gives way when the card runs out of height (the quick-capture window is 520 tall): a note's
  // body shrinks toward its minimum and scrolls, so the chips and key hints below stay in view.
  fields: { padding: space.xl, gap: space.ml, borderTopWidth: 1, borderTopColor: colors.borderSubtle, flexShrink: 1 },
  // The foot of a new item, over the key hints: where it goes.
  chipBand: {
    gap: space.xs,
    paddingHorizontal: space.xl,
    paddingTop: space.ml,
    paddingBottom: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    flexShrink: 0,
  },
  // Three rows of chips, then it scrolls; a focused chip scrolls itself into view.
  chipScroll: { maxHeight: 3 * control.sm + 2 * space.xs + 4, flexGrow: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, padding: 2 },
  chipItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: control.sm,
    maxWidth: 220,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
  chipItemOn: { borderColor: colors.accentSoftBorder, backgroundColor: colors.accentSoft },
  swatch: { width: 8, height: 8, borderRadius: radius.xs, flexShrink: 0 },
  chipItemFocused: {
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
