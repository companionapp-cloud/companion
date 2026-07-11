import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "@companion/design-system";
import { colors } from "./theme";
import type { Account } from "./api";

// Top toolbar: branding on the left, a user icon on the right that opens a small menu
// (account settings + sign out).
export default function Toolbar(props: {
  account: Account | null;
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const initials = initialsFor(props.account);

  return (
    <View style={s.bar}>
      <View style={s.brand}>
        <BrandMark size={22} />
        <Text style={s.brandText}>Companion Cloud</Text>
      </View>

      <View>
        <Pressable
          style={s.avatar}
          onPress={() => setOpen((v) => !v)}
          accessibilityLabel="Account menu"
        >
          <Text style={s.avatarText}>{initials}</Text>
        </Pressable>

        {open ? (
          <>
            {/* Click-away backdrop */}
            <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
            <View style={s.menu}>
              {props.account ? (
                <View style={s.menuHeader}>
                  <Text style={s.menuName} numberOfLines={1}>
                    {displayName(props.account)}
                  </Text>
                  <Text style={s.menuEmail} numberOfLines={1}>
                    {props.account.email}
                  </Text>
                </View>
              ) : null}
              {props.isAdmin && props.onOpenAdmin ? (
                <MenuItem
                  label="Admin"
                  onPress={() => {
                    setOpen(false);
                    props.onOpenAdmin!();
                  }}
                />
              ) : null}
              <MenuItem
                label="Account settings"
                onPress={() => {
                  setOpen(false);
                  props.onOpenSettings();
                }}
              />
              <MenuItem
                label="Sign out"
                danger
                onPress={() => {
                  setOpen(false);
                  props.onSignOut();
                }}
              />
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}

function MenuItem(props: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable style={s.menuItem} onPress={props.onPress}>
      <Text style={[s.menuItemText, props.danger ? { color: colors.danger } : null]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function initialsFor(a: Account | null): string {
  if (!a) return "?";
  const f = a.firstName?.trim()?.[0] ?? "";
  const l = a.lastName?.trim()?.[0] ?? "";
  const combined = (f + l).toUpperCase();
  if (combined) return combined;
  return (a.email?.trim()?.[0] ?? "?").toUpperCase();
}

function displayName(a: Account): string {
  const name = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim();
  return name || a.email;
}

const s = StyleSheet.create({
  bar: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    backgroundColor: colors.toolbar,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    zIndex: 10,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandText: { fontSize: 16, fontWeight: "700", color: colors.text },

  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatarText: { fontSize: 13, fontWeight: "700", color: colors.accent },

  backdrop: { position: "fixed" as any, top: 0, left: 0, right: 0, bottom: 0 },
  menu: {
    position: "absolute",
    top: 44,
    right: 0,
    minWidth: 220,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    boxShadow: "0 6px 24px rgba(0,0,0,0.12)",
    zIndex: 20,
  },
  menuHeader: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 4,
  },
  menuName: { fontSize: 14, fontWeight: "600", color: colors.text },
  menuEmail: { fontSize: 12, color: colors.muted },
  menuItem: { paddingHorizontal: 14, paddingVertical: 9 },
  menuItemText: { fontSize: 14, color: colors.text },
});
