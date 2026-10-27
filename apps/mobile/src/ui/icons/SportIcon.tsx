import { StyleSheet, View } from "react-native";
import Svg from "react-native-svg";
import { sports } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import { sportGlyphs } from "@/ui/icons/sportGlyphs";
import type { SportGlyphKey } from "@/ui/icons/sportGlyphs";
import { useTheme } from "@/ui/theme";
import { radii, wash } from "@/ui/tokens";

export type SportIconVariant = "plain" | "accent" | "filled" | "inline" | "badge";

interface SportIconProps {
  readonly sport: SportKey | "new";
  readonly variant?: SportIconVariant;
  readonly color?: string;
  readonly label?: string;
}

function glyphOf(sport: SportKey | "new"): SportGlyphKey {
  if (sport === "new") return "new";
  const icon = sports[sport].icon;
  return icon in sportGlyphs ? (icon as SportGlyphKey) : "other";
}

export function SportIcon({ sport, variant = "plain", color, label }: SportIconProps) {
  const { colors } = useTheme();
  const glyph = sportGlyphs[glyphOf(sport)];
  const inline = variant === "inline";
  const badge = variant === "badge";
  const tone = sport === "new" ? colors.text2 : colors.sport[sport];
  const ink = variant === "filled" ? colors.bg : badge ? tone : (color ?? colors.text);
  const mark = variant === "accent" ? colors.mark : ink;
  const box = inline ? 24 : badge ? 40 : 36;
  const side = inline ? 20 : 22;
  return (
    <View
      accessible={label !== undefined}
      accessibilityRole={label === undefined ? undefined : "image"}
      accessibilityLabel={label}
      style={[styles.box, { width: box, height: box }, variant === "filled" && { backgroundColor: colors.text }, badge && { borderRadius: box / 2, backgroundColor: wash(tone) }]}
    >
      <Svg width={side} height={side} viewBox={glyph.viewBox}>
        {glyph.render(ink, mark)}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", borderRadius: radii.control },
});
