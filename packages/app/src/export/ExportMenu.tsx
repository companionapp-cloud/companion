import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Icon, IconButton, Text, colors, radius, row, shadow, space, useDensity, type PressState } from "@companion/design-system";
import { useExport } from "./ExportProvider";
import { EXPORT_FORMATS, formatsFor, type ExportTarget } from "./types";

/** The export control in a document's sub-toolbar and the multiselect bar: a button that drops a
 *  menu of the formats the targets can take, and exports them in the one picked. The same thing
 *  the desktop's File › Export does. Renders nothing where exporting isn't available. */
export function ExportMenu({
  targets,
  variant = "icon",
  glyph = 13,
}: {
  targets: ExportTarget[];
  /** "icon" sits among a sub-toolbar's icon buttons; "button" reads "Export…" beside labelled ones. */
  variant?: "icon" | "button";
  glyph?: number;
}) {
  const exporter = useExport();
  const [open, setOpen] = useState(false);
  const touch = useDensity() === "touch";
  const size = touch ? "lg" : "sm";
  if (!exporter.available || !targets.length) return null;
  const formats = formatsFor(targets[0].kind);
  const options = EXPORT_FORMATS.filter((f) => formats.includes(f.format));
  return (
    <View style={styles.root}>
      {variant === "button" ? (
        <Button label="Export…" variant="ghost" size={size} disabled={exporter.busy} onPress={() => setOpen((o) => !o)} />
      ) : (
        <IconButton label="Export" size={size} active={open} disabled={exporter.busy} onPress={() => setOpen((o) => !o)}>
          <Icon name="download" size={glyph} color={open ? colors.textAccent : colors.textSecondary} />
        </IconButton>
      )}
      {open ? (
        <>
          {/* Full-bleed scrim closes the menu on an outside tap. */}
          <Pressable style={styles.scrim} onPress={() => setOpen(false)} aria-label="Close export menu" />
          <View style={styles.menu}>
            <Text variant="eyebrow" tone="tertiary" style={styles.heading}>
              {targets.length > 1 ? `Export ${targets.length} as` : "Export as"}
            </Text>
            {options.map((o) => (
              <Pressable
                key={o.format}
                aria-label={`Export as ${o.label}`}
                onPress={() => {
                  setOpen(false);
                  void exporter.run(targets, o.format);
                }}
                style={({ hovered, pressed }: PressState) => [
                  styles.option,
                  touch ? styles.optionTouch : null,
                  { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
                ]}
              >
                <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                  {o.label}
                </Text>
                <Text variant="mono" tone="quaternary">
                  .{o.format}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = {
  root: { position: "relative" as const, zIndex: 30 },
  scrim: { position: "absolute" as const, top: 0, left: 0, width: 4000, height: 4000, marginLeft: -2000, marginTop: -2000 },
  menu: {
    position: "absolute" as const,
    top: "100%" as const,
    right: 0,
    marginTop: space.xxs,
    minWidth: 168,
    gap: 1,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    padding: space.xs,
    zIndex: 40,
    ...shadow.md,
  },
  heading: { paddingHorizontal: space.sm, paddingTop: space.xs, paddingBottom: space.xxs },
  option: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    minHeight: row.h,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  optionTouch: { minHeight: row.touch, paddingHorizontal: space.ml },
};
