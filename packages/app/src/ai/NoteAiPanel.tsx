import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import type { AiGrammarResult, AiMetadataResult, Note, ObjectField } from "@companion/core-bridge";
import {
  Button,
  Icon,
  IconButton,
  Input,
  Spinner,
  Text,
  colors,
  radius,
  row,
  space,
  useDensity,
  type PressState,
} from "@companion/design-system";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { useObjectTypes } from "../ObjectTypesProvider";
import { BottomSheet } from "../mobile/ui";
import { ASSISTS, LANGUAGES, PROMPT_STARTERS, READING_LEVELS, applyActions, assistFor } from "./assists";
import type { NoteAssist } from "./useNoteAssist";
import { PromptField } from "./PromptField";

/** The note editor's writing-assist panel: docked under the document on web/desktop (above the
 *  formatting bar), in a sheet on native. It walks one assist through picking it, supplying its
 *  input, the streamed run, and choosing what to do with the result. The text it works on stays
 *  highlighted in the editor meanwhile. */
export function NoteAiPanel({ assist, note, sheet = false }: { assist: NoteAssist; note: Note | null; sheet?: boolean }) {
  const { phase, target } = assist;
  const touch = useDensity() === "touch";

  // Escape backs out (web/desktop): stop a run, else close. The listener stays put while the
  // panel is open and reads the latest assist through a ref: re-subscribing on every render
  // would drop an Escape whenever another window listener re-renders the tree mid-dispatch
  // (a listener removed during dispatch never fires).
  const assistRef = useRef(assist);
  assistRef.current = assist;
  const open = !!phase;
  useEffect(() => {
    if (Platform.OS !== "web" || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      const a = assistRef.current;
      if (a.phase?.kind === "running") a.stop();
      else a.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!phase) return null;
  const def = phase.kind === "menu" ? null : assistFor(phase.task);
  // Generate without a selection writes at the caret; every other assist reads the whole note.
  const scope = target ? (target.selection ? "Selection" : def?.task === "generate" ? "At cursor" : "Whole note") : null;

  return (
    <View style={[styles.panel, touch ? styles.panelTouch : null, sheet ? styles.panelSheet : null]} aria-label="AI assist panel">
      <View style={styles.header}>
        <Icon name={def?.icon ?? "sparkle"} size={13} color={colors.textAccent} />
        <Text variant="label" numberOfLines={1}>
          {def?.label ?? "AI"}
        </Text>
        {scope ? (
          <View style={styles.scope}>
            <Text variant="mono" tone="tertiary">
              {scope}
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        {assist.via && phase.kind !== "menu" && phase.kind !== "compose" ? (
          <Text variant="mono" tone="quaternary" numberOfLines={1} style={styles.via}>
            {assist.via}
          </Text>
        ) : null}
        <IconButton label="Close" size={touch ? "lg" : "sm"} onPress={assist.close}>
          <Icon name="close" size={13} color={colors.textSecondary} />
        </IconButton>
      </View>

      {phase.kind === "menu" ? (
        <AssistMenu onPick={assist.start} selection={!!target?.selection} />
      ) : phase.kind === "compose" ? (
        <Compose assist={assist} selection={!!target?.selection} />
      ) : phase.kind === "running" ? (
        <Running assist={assist} />
      ) : phase.kind === "error" ? (
        <View style={styles.section}>
          <View style={styles.errorRow}>
            <Icon name="alert" size={13} color={colors.danger} />
            <Text tone="danger" style={{ flex: 1 }}>
              {sentence(phase.error)}
            </Text>
          </View>
          <Actions>
            <Button label="Try again" size="sm" variant="secondary" onPress={() => assist.run()} />
            <Button label="Close" size="sm" variant="ghost" onPress={assist.close} />
          </Actions>
        </View>
      ) : phase.grammar ? (
        <GrammarResult result={phase.grammar} assist={assist} />
      ) : phase.metadata && note ? (
        <MetadataResult result={phase.metadata} note={note} assist={assist} />
      ) : (
        <TextResult assist={assist} text={phase.text} />
      )}
    </View>
  );
}

/** Where the panel lives: docked in the document column on web/desktop (above the formatting
 *  bar); on native the phone's bottom sheet, which rides above the keyboard. */
export function NoteAiDock({ assist, note }: { assist: NoteAssist; note: Note | null }) {
  if (!assist.phase) return null;
  if (Platform.OS === "web") return <NoteAiPanel assist={assist} note={note} />;
  return (
    <BottomSheet onClose={assist.close} padded={false}>
      <NoteAiPanel assist={assist} note={note} sheet />
    </BottomSheet>
  );
}

/** The assists, as a grid of tiles (the AI toolbar button opens this). */
function AssistMenu({ onPick, selection }: { onPick: NoteAssist["start"]; selection: boolean }) {
  const touch = useDensity() === "touch";
  return (
    <View style={styles.section}>
      <Text variant="mono" tone="tertiary">
        {selection ? "Working on the selected text" : "Working on the whole note — select text to narrow it"}
      </Text>
      <View style={styles.grid}>
        {ASSISTS.map((a) => (
          <Pressable
            key={a.task}
            aria-label={a.label}
            onPress={() => onPick(a.task)}
            style={({ hovered, pressed }: PressState) => [
              styles.tile,
              touch ? styles.tileTouch : null,
              { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : colors.surfaceCard },
            ]}
          >
            <Icon name={a.icon} size={14} color={colors.textAccent} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="label" numberOfLines={1}>
                {a.label}
                {a.task === "generate" && Platform.OS === "web" && !touch ? (
                  <Text variant="mono" tone="quaternary">
                    {"  ⌘J"}
                  </Text>
                ) : null}
              </Text>
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {a.hint}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The input an assist needs before it runs. */
function Compose({ assist, selection }: { assist: NoteAssist; selection: boolean }) {
  const task = assist.phase && "task" in assist.phase ? assist.phase.task : null;
  const [prompt, setPrompt] = useState(assist.params.prompt ?? "");
  const [language, setLanguage] = useState("");
  if (task === "generate") {
    const submit = (p: string) => p.trim() && assist.run({ prompt: p.trim() });
    return (
      <View style={styles.section}>
        <PromptField
          value={prompt}
          onChangeText={setPrompt}
          placeholder={selection ? "What should change? e.g. make it friendlier" : "What should the AI write?"}
          autoFocus
          leading={<Icon name="sparkle" size={13} color={colors.textTertiary} />}
          onSubmit={() => submit(prompt)}
          trailing={
            <Pressable aria-label="Generate" disabled={!prompt.trim()} onPress={() => submit(prompt)}>
              <Text variant="mono" tone={prompt.trim() ? "accent" : "quaternary"}>
                ⏎
              </Text>
            </Pressable>
          }
        />
        <Chips items={selection ? PROMPT_STARTERS.selection : PROMPT_STARTERS.cursor} onPick={submit} />
      </View>
    );
  }
  if (task === "readingLevel") {
    return (
      <View style={styles.section}>
        <Text variant="mono" tone="tertiary">
          Rewrite for a reading level
        </Text>
        <Chips
          items={READING_LEVELS.map((l) => l.label)}
          active={READING_LEVELS.find((l) => l.grade === assist.params.grade)?.label}
          onPick={(label) => assist.run({ grade: READING_LEVELS.find((l) => l.label === label)!.grade })}
        />
      </View>
    );
  }
  if (task === "translate") {
    return (
      <View style={styles.section}>
        <Chips items={LANGUAGES} active={assist.params.language} onPick={(l) => assist.run({ language: l })} />
        <Input
          value={language}
          onChangeText={setLanguage}
          placeholder="Another language…"
          size="sm"
          onSubmitEditing={() => language.trim() && assist.run({ language: language.trim() })}
        />
      </View>
    );
  }
  return null;
}

function Running({ assist }: { assist: NoteAssist }) {
  const task = assist.phase && "task" in assist.phase ? assist.phase.task : "generate";
  const streams = task !== "grammar" && task !== "metadata";
  const label =
    task === "grammar" ? "Checking…" : task === "metadata" ? "Reading the note…" : task === "critique" ? "Reviewing…" : "Writing…";
  return (
    <View style={styles.section}>
      {streams && assist.stream ? (
        <Preview>
          <ChatMarkdown value={assist.stream} />
        </Preview>
      ) : null}
      <Actions>
        <Spinner inline label={label} />
        <View style={{ flex: 1 }} />
        <Button label="Stop" size="sm" variant="secondary" onPress={assist.stop} />
      </Actions>
    </View>
  );
}

function TextResult({ assist, text }: { assist: NoteAssist; text: string }) {
  const task = assist.phase && "task" in assist.phase ? assist.phase.task : "generate";
  const actions = applyActions(task, !!assist.target?.selection);
  return (
    <View style={styles.section}>
      <Preview>
        <ChatMarkdown value={text} />
      </Preview>
      <Actions>
        {actions.map((a) => (
          <Button key={a.mode} label={a.label} size="sm" variant={a.primary ? "primary" : "secondary"} onPress={() => assist.apply(a.mode)} />
        ))}
        <CopyButton text={text} />
        <View style={{ flex: 1 }} />
        <Button label="Try again" size="sm" variant="ghost" onPress={() => assist.run()} />
        <Button label={actions.length ? "Discard" : "Done"} size="sm" variant="ghost" onPress={assist.close} />
      </Actions>
    </View>
  );
}

function GrammarResult({ result, assist }: { result: AiGrammarResult; assist: NoteAssist }) {
  if (result.issues.length === 0) {
    return (
      <View style={styles.section}>
        <View style={styles.errorRow}>
          <Icon name="check" size={13} color={colors.success} />
          <Text tone="secondary">No issues found.</Text>
        </View>
        <Actions>
          <View style={{ flex: 1 }} />
          <Button label="Done" size="sm" variant="secondary" onPress={assist.close} />
        </Actions>
      </View>
    );
  }
  const n = result.issues.length;
  return (
    <View style={styles.section}>
      <ScrollView style={styles.preview} contentContainerStyle={styles.issues}>
        {result.issues.map((is, i) => (
          <View key={i} style={styles.issue}>
            <Text>
              <Text tone="danger" style={styles.strike}>
                {is.original}
              </Text>
              <Text tone="quaternary">{"  →  "}</Text>
              <Text tone="success" style={styles.bold}>
                {is.suggestion}
              </Text>
            </Text>
            {is.explanation ? (
              <Text variant="caption" tone="tertiary">
                {is.explanation}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
      <Actions>
        <Button label={n === 1 ? "Apply fix" : `Apply ${n} fixes`} size="sm" onPress={() => assist.apply("replace", result.corrected)} />
        <View style={{ flex: 1 }} />
        <Button label="Try again" size="sm" variant="ghost" onPress={() => assist.run()} />
        <Button label="Discard" size="sm" variant="ghost" onPress={assist.close} />
      </Actions>
    </View>
  );
}

function MetadataResult({ result, note, assist }: { result: AiMetadataResult; note: Note; assist: NoteAssist }) {
  const types = useObjectTypes();
  const type = types.byId(result.objectTypeId);
  const typeChanged = result.objectTypeId !== note.objectTypeId;
  const current = typeChanged ? {} : note.props ?? {};
  const fields = useMemo(
    () => (type?.schemaJson.fields ?? []).filter((f) => f.key in result.props && !same(result.props[f.key], current[f.key])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [type, result],
  );
  const [picked, setPicked] = useState<Set<string>>(() => new Set(fields.map((f) => f.key)));
  const [busy, setBusy] = useState(false);

  if (!fields.length && !typeChanged) {
    return (
      <View style={styles.section}>
        <Text tone="secondary">Nothing new to fill in from this text.</Text>
        <Actions>
          <View style={{ flex: 1 }} />
          <Button label="Done" size="sm" variant="secondary" onPress={assist.close} />
        </Actions>
      </View>
    );
  }
  const toggle = (key: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <View style={styles.section}>
      {typeChanged ? (
        <Text tone="secondary">
          Set type to <Text style={styles.bold}>{type?.name ?? "Unknown"}</Text>
          {fields.length ? " and fill in:" : ""}
        </Text>
      ) : null}
      <ScrollView style={styles.preview} contentContainerStyle={styles.fields}>
        {fields.map((f) => (
          <FieldRow key={f.key} field={f} before={current[f.key]} after={result.props[f.key]} on={picked.has(f.key)} onToggle={() => toggle(f.key)} />
        ))}
      </ScrollView>
      <Actions>
        <Button
          label={busy ? "Applying…" : "Apply"}
          size="sm"
          disabled={busy || (!typeChanged && picked.size === 0)}
          onPress={() => {
            setBusy(true);
            void assist.applyMetadata([...picked]).finally(() => setBusy(false));
          }}
        />
        <View style={{ flex: 1 }} />
        <Button label="Try again" size="sm" variant="ghost" onPress={() => assist.run()} />
        <Button label="Discard" size="sm" variant="ghost" onPress={assist.close} />
      </Actions>
    </View>
  );
}

function FieldRow({
  field,
  before,
  after,
  on,
  onToggle,
}: {
  field: ObjectField;
  before: unknown;
  after: unknown;
  on: boolean;
  onToggle: () => void;
}) {
  const had = !isEmpty(before);
  return (
    <Pressable
      role="checkbox"
      aria-checked={on}
      aria-label={field.label || field.key}
      onPress={onToggle}
      style={({ hovered }: PressState) => [styles.fieldRow, hovered ? { backgroundColor: colors.surfaceHover } : null]}
    >
      <View style={[styles.box, on ? styles.boxOn : null]}>{on ? <Icon name="check" size={10} color={colors.onAccent} /> : null}</View>
      <Text variant="label" numberOfLines={1} style={styles.fieldLabel}>
        {field.label || field.key}
      </Text>
      <Text numberOfLines={2} style={{ flex: 1 }}>
        {had ? (
          <>
            <Text tone="quaternary" style={styles.strike}>
              {display(before)}
            </Text>
            <Text tone="quaternary">{"  →  "}</Text>
          </>
        ) : null}
        <Text>{display(after)}</Text>
      </Text>
    </Pressable>
  );
}

function Chips({ items, active, onPick }: { items: string[]; active?: string; onPick: (item: string) => void }) {
  const touch = useDensity() === "touch";
  return (
    <View style={styles.chips}>
      {items.map((item) => (
        <Pressable
          key={item}
          aria-label={item}
          onPress={() => onPick(item)}
          style={({ hovered, pressed }: PressState) => [
            styles.chip,
            touch ? styles.chipTouch : null,
            item === active ? styles.chipActive : null,
            { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : item === active ? colors.accentSoft : colors.surfaceCard },
          ]}
        >
          <Text variant="caption" tone={item === active ? "accent" : "secondary"}>
            {item}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return null;
  return (
    <Button
      label={copied ? "Copied" : "Copy"}
      size="sm"
      variant="ghost"
      onPress={() => void clipboard.writeText(text).then(() => setCopied(true))}
    />
  );
}

const Preview = ({ children }: { children: ReactNode }) => (
  <ScrollView style={styles.preview} contentContainerStyle={styles.previewBody}>
    {children}
  </ScrollView>
);

const Actions = ({ children }: { children: ReactNode }) => <View style={styles.actions}>{children}</View>;

/** Core errors read lower-case ("no LLM configured"); the panel shows them as sentences. */
function sentence(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function display(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return v == null ? "" : String(v);
}

function isEmpty(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const styles = {
  panel: {
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
    paddingHorizontal: space.ml,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.sm,
  },
  panelTouch: { paddingHorizontal: space.xl, paddingBottom: space.lg },
  // In the bottom sheet, the sheet supplies the surface.
  panelSheet: { borderTopWidth: 0, backgroundColor: "transparent" },
  header: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, minHeight: 24 },
  scope: {
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSunken,
  },
  via: { flexShrink: 1, maxWidth: 260 },
  section: { gap: space.sm },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  tile: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    flexBasis: 220,
    flexGrow: 1,
    minHeight: row.h + 12,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  tileTouch: { flexBasis: 160, minHeight: row.touch + 8 },
  chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xs },
  chip: {
    paddingHorizontal: space.md,
    height: 24,
    justifyContent: "center" as const,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  chipTouch: { height: 32, borderRadius: 16 },
  chipActive: { borderColor: colors.accentSoftBorder },
  preview: {
    maxHeight: 280,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  previewBody: { padding: space.md },
  actions: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: space.xs },
  errorRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: space.sm },
  issues: { padding: space.md, gap: space.md },
  issue: { gap: 2 },
  strike: { textDecorationLine: "line-through" as const },
  bold: { fontWeight: "600" as const },
  fields: { padding: space.xs, gap: 1 },
  fieldRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    minHeight: row.h,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  fieldLabel: { width: 120 },
  box: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
};
