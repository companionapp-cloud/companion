import { StyleSheet, View } from "react-native";
import { BrandMark } from "./BrandMark";
import { Text } from "./Text";

export interface WordmarkProps {
  /** Mark size in px; the lowercase wordmark is always the 15px title. */
  size?: number;
}

/** Mark + lowercase "companion" — the lockup used in the rail. */
export function Wordmark({ size = 20 }: WordmarkProps) {
  return (
    <View style={styles.lockup}>
      <BrandMark size={size} />
      <Text variant="title" numberOfLines={1}>
        companion
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 },
});
