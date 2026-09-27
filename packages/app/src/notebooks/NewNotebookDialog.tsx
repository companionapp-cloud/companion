import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { Button, Text, colors, font, radius, space, useDensity } from "@companion/design-system";
import type { PressState } from "@companion/design-system";
import type { Notebook as CoreNotebook, NotebookMedium, WaxLeaves } from "@companion/core-bridge";
import { Dialog } from "../Dialog";
import { useNotebooks } from "./NotebooksProvider";
import { NotebookCoverArt } from "./NotebookShelf";
import { MEDIUMS, MEDIUM_ORDER, SHERD_FABRICS, WAX_BINDINGS, sherdShape } from "./mediums";
import { sherdPicture } from "./mediumCovers";
import { useLabsFlag } from "../labs";

// Making a notebook (PLAN-notebooks.md §11): a title and what to write on. The medium is the
// one choice that can't be changed later, so it is made here, with its rules and a little of
// its history in view, rather than in the cover dialog. Clay, wax and sherds are a Labs
// experiment ("Include less modern mediums"): until it's switched on this is just a title.

const MAKE_LABEL: Record<NotebookMedium, string> = { paper: "Start notebook", clay: "Shape a tablet", wax: "Bind the codex", sherd: "Pick up a sherd" };

export function NewNotebookDialog({ onCreated, onClose }: { onCreated(nb: CoreNotebook): void; onClose(): void }) {
  const notebooks = useNotebooks();
  const touch = useDensity() === "touch";
  const [title, setTitle] = useState("");
  const ancient = useLabsFlag("ancientMediums");
  const [picked, setMedium] = useState<NotebookMedium>("paper");
  const medium: NotebookMedium = ancient ? picked : "paper";
  const [leaves, setLeaves] = useState<WaxLeaves>(2);
  // A potsherd notebook starts with a sherd picked off the heap: its page id (a sherd's shape
  // and fabric come from its id).
  const [firstSherd, setFirstSherd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = MEDIUMS[medium];

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const nb = await notebooks.create({
        title: title.trim(),
        medium,
        leaves: medium === "wax" ? leaves : undefined,
        firstPageId: medium === "sherd" ? (firstSherd ?? undefined) : undefined,
      });
      onCreated(nb);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not make that notebook.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New notebook"
      onClose={busy ? undefined : onClose}
      width={ancient ? 640 : 440}
      footer={
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Button variant="ghost" size={touch ? "lg" : "sm"} label="Cancel" onPress={onClose} disabled={busy} />
          <Button size={touch ? "lg" : "sm"} label={MAKE_LABEL[medium]} onPress={() => void make()} disabled={busy} />
        </View>
      }
    >
      <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={styles.body}>
        <TextInput
          aria-label="Notebook title"
          autoFocus={!touch}
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={() => void make()}
          placeholder="Untitled"
          placeholderTextColor={colors.textQuaternary}
          style={styles.titleInput}
        />
        {ancient ? (
          <>
            <Text variant="eyebrow" tone="tertiary">
              Write on
            </Text>
            <View style={styles.grid}>
              {MEDIUM_ORDER.map((m) => {
                const s = MEDIUMS[m];
                const on = m === medium;
                return (
                  <Pressable
                    key={m}
                    aria-label={s.label}
                    aria-selected={on}
                    onPress={() => setMedium(m)}
                    style={({ hovered }: PressState) => [
                      styles.card,
                      {
                        borderColor: on ? colors.borderFocus : colors.borderSubtle,
                        backgroundColor: on ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent",
                      },
                    ]}
                  >
                    <View style={styles.art} pointerEvents="none">
                      <NotebookCoverArt
                        width={54}
                        notebook={{
                          id: `preview-${m}`,
                          title: "",
                          cover: { kind: "color", color: "ink" },
                          medium: m,
                          leaves: m === "wax" ? leaves : undefined,
                          guides: [],
                          pageCount: 1,
                          updatedAt: "",
                        }}
                      />
                    </View>
                    <View style={{ flex: 1, gap: space.xxs }}>
                      <Text style={{ fontWeight: font.weight.semibold }}>{s.label}</Text>
                      <Text tone="tertiary" variant="caption">
                        {s.tagline}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {/* The heap's pictures need a DOM; on native the first sherd is left to chance. */}
            {medium === "sherd" && typeof document !== "undefined" ? <FirstSherd value={firstSherd} onChange={setFirstSherd} /> : null}

            {medium === "wax" ? (
              <View style={{ gap: space.sm }}>
                <Text variant="eyebrow" tone="tertiary">
                  Binding
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                  {WAX_BINDINGS.map((b) => (
                    <Pressable
                      key={b.leaves}
                      aria-selected={leaves === b.leaves}
                      onPress={() => setLeaves(b.leaves)}
                      style={({ hovered }: PressState) => [
                        styles.chip,
                        {
                          backgroundColor: leaves === b.leaves ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent",
                          borderColor: leaves === b.leaves ? colors.accentSoftBorder : colors.borderDefault,
                        },
                      ]}
                    >
                      <Text tone={leaves === b.leaves ? "accent" : "secondary"}>{b.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.about}>
              {spec.rules.map((r) => (
                <View key={r} style={{ flexDirection: "row", gap: space.sm }}>
                  <Text tone="tertiary">·</Text>
                  <Text tone="secondary" style={{ flex: 1 }}>
                    {r}
                  </Text>
                </View>
              ))}
              <Text tone="tertiary" variant="caption" style={{ marginTop: space.sm }}>
                {spec.history}
              </Text>
              {medium !== "paper" ? (
                <Text tone="quaternary" variant="caption">
                  The medium can't be changed once the notebook is made.
                </Text>
              ) : null}
            </View>
          </>
        ) : null}
        {error ? (
          <Text tone="danger" variant="caption">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </Dialog>
  );
}

/** Five blank sherds off the heap, each a different pot; the one picked becomes the notebook's
 *  first page. "Rummage" turns up five more. Web only: the pictures are rendered. */
function FirstSherd({ value, onChange }: { value: string | null; onChange(id: string): void }) {
  const [ids, setIds] = useState(freshHeap);
  const [pics, setPics] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    setPics({});
    ids.forEach((id) =>
      void sherdPicture(id, 104).then((url) => {
        if (live && url) setPics((p) => ({ ...p, [id]: url }));
      }),
    );
    if (!value || !ids.includes(value)) onChange(ids[0]);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const picked = value ? sherdShape(value) : null;
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Text variant="eyebrow" tone="tertiary" style={{ flex: 1 }}>
          First sherd{picked ? ` · ${SHERD_FABRICS[picked.variant]}` : ""}
        </Text>
        <Button variant="ghost" size="sm" label="Rummage" onPress={() => setIds(freshHeap())} />
      </View>
      <View style={styles.heap}>
        {ids.map((id, i) => {
          const shape = sherdShape(id);
          const on = id === value;
          const w = 96;
          const turn = ((i * 37) % 24) - 12;
          return (
            <Pressable
              key={id}
              aria-label={`First sherd: ${SHERD_FABRICS[shape.variant]}`}
              aria-selected={on}
              onPress={() => onChange(id)}
              style={({ hovered }: PressState) => [
                styles.piece,
                {
                  borderColor: on ? colors.borderFocus : "transparent",
                  backgroundColor: on ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent",
                  transform: [{ translateY: on ? -3 : 0 }],
                },
              ]}
            >
              {pics[id] ? (
                <Image
                  source={{ uri: pics[id] }}
                  style={{ width: w, height: (w * shape.page.height) / shape.page.width, transform: [{ rotate: `${turn}deg` }] }}
                  resizeMode="contain"
                />
              ) : (
                <View style={{ width: w, height: (w * shape.page.height) / shape.page.width }} />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function freshHeap(): string[] {
  return Array.from({ length: 5 }, () => crypto.randomUUID());
}

const styles = {
  heap: { flexDirection: "row" as const, flexWrap: "wrap" as const, justifyContent: "center" as const, gap: space.sm, paddingVertical: space.sm },
  piece: { padding: space.sm, borderRadius: radius.lg, borderWidth: 1, alignItems: "center" as const, justifyContent: "center" as const },
  body: { gap: space.lg, paddingVertical: space.md },
  titleInput: {
    fontFamily: font.sans,
    fontSize: font.size.xl,
    fontWeight: font.weight.semibold,
    color: colors.textPrimary,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefault,
    paddingVertical: space.sm,
    outlineStyle: "none" as never,
  },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md },
  card: {
    flexGrow: 1,
    flexBasis: 260,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.lg,
    padding: space.ml,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  art: { width: 58, height: 76, alignItems: "center" as const, justifyContent: "center" as const, overflow: "hidden" as const },
  chip: { height: 28, paddingHorizontal: space.ml, justifyContent: "center" as const, borderRadius: radius.md, borderWidth: 1 },
  about: { gap: space.xs, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surfaceSunken },
};
