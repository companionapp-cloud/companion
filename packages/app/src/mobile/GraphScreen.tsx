import { StyleSheet, View } from "react-native";
import { colors } from "@companion/design-system";
import { GraphScreen as SharedGraphScreen } from "../GraphScreen";
import { NavBar } from "./ui";

// Non-web fallback for the mobile shell's graph route: the shared placeholder under a nav
// bar. The mobile *web* shell resolves GraphScreen.web.tsx (the real React Flow view).
export function GraphScreen() {
  return (
    <View style={styles.root}>
      <NavBar title="Graph" />
      <View style={styles.body}>
        <SharedGraphScreen />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  body: { flex: 1, minHeight: 0 },
});
