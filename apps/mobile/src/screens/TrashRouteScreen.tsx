import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { TrashScreen, ConfirmDialog, useCore } from '@companion/app';
import { colors } from '@companion/design-system';
import { NavAction } from '../ui/native';

// The Trash under the nav bar, whose one action empties it (the native twin of the mobile
// web shell's TrashRouteScreen). Under touch density the shared TrashScreen drops its own
// title and "Empty trash" button and keeps the list (restore / delete forever); the bar's
// danger icon goes through the same core call and the same confirmation.
export function TrashRouteScreen() {
  const nav = useNavigation();
  const { core, trash } = useCore();
  const [count, setCount] = useState(0);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  // Bumped after emptying so the hosted screen re-reads the (now empty) Trash.
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => {
    void trash.list().then((items) => setCount(items.length));
  }, [trash]);
  useEffect(() => {
    refresh();
    const offNotes = core.on('notes.changed', refresh);
    const offData = core.on('data.changed', refresh);
    return () => {
      offNotes();
      offData();
    };
  }, [core, refresh]);

  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <NavAction icon="trash" label="Empty trash" tone="danger" disabled={count === 0} onPress={() => setConfirmEmpty(true)} />
      ),
    });
  }, [nav, count]);

  return (
    <View style={styles.root}>
      <TrashScreen key={generation} />
      {confirmEmpty ? (
        <ConfirmDialog
          title="Empty the Trash?"
          message={`This permanently deletes all ${count} item${count === 1 ? '' : 's'} in the Trash. This can’t be undone.`}
          confirmLabel="Empty trash"
          onConfirm={async () => {
            await trash.empty();
            setConfirmEmpty(false);
            setCount(0);
            setGeneration((g) => g + 1);
          }}
          onClose={() => setConfirmEmpty(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
});
