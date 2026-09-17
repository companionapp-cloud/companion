import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Task } from "@companion/core-bridge";
import { Button, Text, useDensity } from "@companion/design-system";
import { PickerCheck, PickerRow, PickerSearch, PickerShell, SEARCH_THRESHOLD, pickerStyles } from "./MembershipPicker";

/** A modal picker that adds existing project tasks to a list (the "Add from this project"
 *  action). Multi-select with a search filter; confirming adds every checked task in one
 *  call. Shares the picker chrome with MembershipPicker / BulkAssignPicker, portaled to the
 *  document root on web so it clears the list column it is opened from. */
export function AddTasksPicker({
  candidates,
  onAdd,
  onClose,
}: {
  /** Tasks eligible to be added (the project's open tasks not already in the list). */
  candidates: Task[];
  onAdd: (taskIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const touch = useDensity() === "touch";

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? candidates.filter((t) => t.title.toLowerCase().includes(q)) : candidates;
  }, [candidates, query]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = async () => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      await onAdd([...picked]);
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <PickerShell
      portal
      width={400}
      title="Add from this project"
      subtitle={candidates.length ? "Pick the tasks to append to this list." : "Every open task in this project is already in this list."}
      onClose={onClose}
    >
      {candidates.length > SEARCH_THRESHOLD ? <PickerSearch placeholder="Search tasks" value={query} onChangeText={setQuery} /> : null}
      <ScrollView contentContainerStyle={pickerStyles.body}>
        {shown.length === 0 && candidates.length > 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No tasks match that.
          </Text>
        ) : (
          shown.map((t) => {
            const on = picked.has(t.id);
            return <PickerRow key={t.id} onPress={() => toggle(t.id)} disabled={busy} selected={on} label={t.title || "Untitled task"} leading={<PickerCheck checked={on} />} />;
          })
        )}
      </ScrollView>
      <View style={pickerStyles.footer}>
        <Button label="Cancel" variant="ghost" size={touch ? "lg" : "sm"} onPress={onClose} />
        <Button
          label={picked.size > 1 ? `Add ${picked.size} tasks` : "Add task"}
          variant="primary"
          size={touch ? "lg" : "sm"}
          disabled={busy || picked.size === 0}
          onPress={() => void confirm()}
        />
      </View>
    </PickerShell>
  );
}
