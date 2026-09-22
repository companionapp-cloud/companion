import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Button, Text, colors, font, radius, space, useDensity } from "@companion/design-system";
import { Dialog } from "../Dialog";
import { useDocumentSource } from "../DocumentSourceContext";
import { pickCoverImage, useCoverUrl } from "../ContainerOverview";
import { useNotebooks } from "./NotebooksProvider";
import { NotebookCoverArt } from "./NotebookShelf";
import { COVER_COLORS } from "./paper";

/** Title, cover colour and cover image for one notebook (PLAN-notebooks.md §2). The image
 *  is ingested as a document, like an area's or a project's cover. */
export function CoverDialog({ notebookId, onClose }: { notebookId: string; onClose(): void }) {
  const notebooks = useNotebooks();
  const documentSource = useDocumentSource();
  const touch = useDensity() === "touch";
  const n = notebooks.byId(notebookId);
  const imageUrl = useCoverUrl(documentSource, n?.coverDocumentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!n) return null;

  const pick = async () => {
    if (!documentSource) return;
    setBusy(true);
    setError(null);
    try {
      const id = await pickCoverImage(documentSource);
      if (id) await notebooks.update(n.id, { coverDocumentId: id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not use that image.");
    } finally {
      setBusy(false);
    }
  };

  const cover = { id: n.id, title: n.title, cover: { kind: "color" as const, color: n.coverColor }, guides: [], pageCount: n.pageCount, updatedAt: n.updatedAt };
  return (
    <Dialog title="Notebook" onClose={busy ? undefined : onClose} width={520} footer={<Button size={touch ? "lg" : "sm"} label="Done" onPress={onClose} disabled={busy} />}>
      <View style={styles.body}>
        <View style={{ alignItems: "center" }}>
          <NotebookCoverArt notebook={cover} width={140} imageUrl={imageUrl} />
        </View>
        <View style={{ flex: 1, minWidth: 200, gap: space.lg }}>
          <TextInput
            aria-label="Notebook title"
            defaultValue={n.title}
            onChangeText={(t: string) => void notebooks.update(n.id, { title: t })}
            placeholder="Untitled"
            placeholderTextColor={colors.textQuaternary}
            style={styles.titleInput}
          />
          <Text variant="eyebrow" tone="tertiary">
            Cover colour
          </Text>
          <View style={styles.swatches}>
            {COVER_COLORS.map((c) => (
              <Pressable
                key={c.id}
                aria-label={c.label}
                aria-selected={n.coverColor === c.id}
                hitSlop={4}
                onPress={() => void notebooks.update(n.id, { coverColor: c.id })}
                style={[styles.swatch, touch ? styles.swatchTouch : null, { backgroundColor: c.hex, borderColor: n.coverColor === c.id ? colors.borderFocus : "transparent" }]}
              />
            ))}
          </View>
          {documentSource ? (
            <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
              <Button variant="secondary" size="sm" label={n.coverDocumentId ? "Change image" : "Upload image"} onPress={() => void pick()} disabled={busy} />
              {n.coverDocumentId ? (
                <Button variant="ghost" size="sm" label="Remove image" onPress={() => void notebooks.update(n.id, { coverDocumentId: "" })} disabled={busy} />
              ) : null}
            </View>
          ) : null}
          {error ? (
            <Text tone="danger" variant="caption">
              {error}
            </Text>
          ) : null}
        </View>
      </View>
    </Dialog>
  );
}

const styles = {
  body: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.xxl, paddingVertical: space.md },
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
  swatches: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md },
  swatch: { width: 26, height: 26, borderRadius: radius.md, borderWidth: 2 },
  swatchTouch: { width: 34, height: 34 },
};
