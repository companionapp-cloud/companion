import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text, colors, radius, space } from "@companion/design-system";
import { ConfirmDialog } from "./ConfirmDialog";

export interface DeleteProjectDialogProps {
  /** The project's name — shown in the copy and used as the type-to-confirm guard when
   *  the destructive "delete content" branch is chosen. */
  projectName: string;
  /** Delete the project; `deleteContent` reflects the user's choice (trash its notes/tasks
   *  vs. move them to Unsorted). The host unmounts this on success. */
  onConfirm: (deleteContent: boolean) => void | Promise<void>;
  onClose: () => void;
}

/** The project-delete prompt (PLAN §6.6): removing a project always keeps or removes its
 *  content by the user's choice. "Keep content" drops the memberships so member notes/tasks
 *  fall back to Unsorted; "Delete content" trashes them too and requires typing the project
 *  name (matching the extra-friction guard used elsewhere for irreversible destroys).
 *  Cross-platform — wraps {@link ConfirmDialog}, so it works on web and native. */
export function DeleteProjectDialog({ projectName, onConfirm, onClose }: DeleteProjectDialogProps) {
  const [mode, setMode] = useState<"keep" | "content">("keep");
  const deleteContent = mode === "content";
  return (
    <ConfirmDialog
      title="Delete project?"
      message={
        <View style={{ gap: space.sm }}>
          <Text tone="secondary" style={{ lineHeight: 20 }}>
            Deleting “{projectName}” removes the project. Choose what happens to its notes and tasks:
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
            subtitle="Notes and tasks are moved to the Trash too."
          />
        </View>
      }
      confirmLabel={deleteContent ? "Delete project & content" : "Delete project"}
      confirmText={deleteContent ? projectName : undefined}
      confirmTextPrompt={deleteContent ? "Type the project name to confirm:" : undefined}
      onConfirm={() => onConfirm(deleteContent)}
      onClose={onClose}
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
  return (
    <Pressable onPress={onPress} style={[styles.choice, selected ? styles.choiceOn : null]}>
      <View style={[styles.radio, selected ? styles.radioOn : null]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="label" tone={selected ? "accent" : "default"}>
          {title}
        </Text>
        <Text variant="caption" tone="tertiary" style={{ marginTop: 1 }}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = {
  choice: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  choiceOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  radio: {
    width: 18,
    height: 18,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginTop: 1,
  },
  radioOn: { borderColor: colors.accent },
  radioDot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.accent },
};
