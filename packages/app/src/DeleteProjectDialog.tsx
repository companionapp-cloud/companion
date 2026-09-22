import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text, colors, radius, space, useDensity, type PressState } from "@companion/design-system";
import { ConfirmDialog } from "./ConfirmDialog";

export interface DeleteProjectDialogProps {
  /** The project's name — shown in the copy and used as the type-to-confirm guard when
   *  the destructive "delete content" branch is chosen. */
  projectName: string;
  /** Delete the project; `deleteContent` reflects the user's choice (trash its notes/tasks
   *  vs. move them to Unsorted). The host unmounts this on success. */
  onConfirm: (deleteContent: boolean) => void | Promise<void>;
  onClose: () => void;
  /** Cover the whole window (see ConfirmDialog's `portal`). */
  portal?: boolean;
}

/** The project-delete prompt (PLAN §6.6): removing a project always keeps or removes its
 *  content by the user's choice. "Keep content" drops the memberships so member notes/tasks
 *  fall back to Unsorted; "Delete content" trashes them too and requires typing the project
 *  name (matching the extra-friction guard used elsewhere for irreversible destroys).
 *  Cross-platform — wraps {@link ConfirmDialog}, so it works on web and native. */
export function DeleteProjectDialog({ projectName, onConfirm, onClose, portal }: DeleteProjectDialogProps) {
  const [mode, setMode] = useState<"keep" | "content">("keep");
  const deleteContent = mode === "content";
  return (
    <ConfirmDialog
      title={`Delete “${projectName}”?`}
      message={
        <View style={{ gap: space.sm }}>
          <Text tone="secondary" style={{ lineHeight: 20 }}>
            The project is removed from its area. Choose what happens to its notes and tasks.
          </Text>
          <Choice
            selected={mode === "keep"}
            onPress={() => setMode("keep")}
            title="Keep content"
            subtitle="Notes and tasks move to Unsorted."
          />
          <Choice
            selected={mode === "content"}
            onPress={() => setMode("content")}
            title="Delete content"
            subtitle="Notes and tasks move to the Trash, and are gone after 30 days."
          />
        </View>
      }
      confirmLabel={deleteContent ? "Delete project and content" : "Delete project"}
      confirmText={deleteContent ? projectName : undefined}
      confirmTextPrompt={deleteContent ? "Type the project name to confirm:" : undefined}
      onConfirm={() => onConfirm(deleteContent)}
      onClose={onClose}
      portal={portal}
    />
  );
}

function Choice({
  selected,
  onPress,
  title,
  subtitle,
}: {
  selected: boolean;
  onPress: () => void;
  title: string;
  subtitle: string;
}) {
  const touch = useDensity() === "touch";
  return (
    <Pressable
      onPress={onPress}
      aria-label={title}
      style={({ hovered, pressed }: PressState) => [
        styles.choice,
        touch ? styles.choiceTouch : null,
        selected ? styles.choiceOn : pressed ? { backgroundColor: colors.surfaceActive } : hovered ? { backgroundColor: colors.surfaceHover } : null,
      ]}
    >
      <View style={[styles.radio, selected ? styles.radioOn : null]}>{selected ? <View style={styles.radioDot} /> : null}</View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="label" tone={selected ? "accent" : "default"}>
          {title}
        </Text>
        <Text variant="caption" tone="tertiary">
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = {
  // A hairline option card: selection is the soft-accent fill, nothing lifts.
  choice: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  choiceTouch: { minHeight: 44, paddingVertical: space.md },
  choiceOn: { borderColor: colors.accentSoftBorder, backgroundColor: colors.accentSoft },
  radio: {
    width: 12,
    height: 12,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginTop: 3,
    flexShrink: 0,
  },
  radioOn: { borderColor: colors.accent },
  radioDot: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.accent },
};
