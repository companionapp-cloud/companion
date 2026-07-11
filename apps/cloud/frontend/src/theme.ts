import { StyleSheet } from "react-native";

// Shared design tokens + primitives for the cloud portal. Kept intentionally small — one
// accent (Companion orange), a warm neutral surface, and a handful of reusable styles.
export const colors = {
  bg: "#f5f5f3",
  surface: "#ffffff",
  border: "#e2e2dd",
  text: "#1a1a18",
  muted: "#7b7b75",
  accent: "#f76808",
  accentSoft: "#fdece1",
  success: "#2f9e44",
  successSoft: "#e7f5ec",
  danger: "#d92d20",
  toolbar: "#ffffff",
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },

  // Cards
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 24,
    gap: 14,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.05)",
  },
  cardTitle: { fontSize: 18, fontWeight: "700", color: colors.text },

  // Text
  h1: { fontSize: 22, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: "600", color: colors.text, marginBottom: 4 },
  error: { color: colors.danger, fontSize: 13 },
  success: { color: colors.success, fontSize: 13 },

  // Inputs
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: colors.surface,
  },

  // Buttons
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  buttonText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
  buttonGhost: {
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonGhostText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  link: { color: colors.accent, fontSize: 13 },

  // Badges
  badge: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
});
