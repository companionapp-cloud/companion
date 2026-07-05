import { useNavigation } from '@react-navigation/native';
import { SettingsPanel } from '@companion/app';

// Reuses the shared settings panel (sync connect + status) as a modal screen; its
// close action pops the modal.
export function SettingsScreen() {
  const nav = useNavigation();
  return <SettingsPanel onClose={() => nav.goBack()} />;
}
