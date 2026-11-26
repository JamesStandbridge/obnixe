import { useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import type { MapAttribution } from "@/features/maps/styles";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { MenuItem } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { useTheme } from "@/ui/theme";
import { layout } from "@/ui/tokens";

interface MapButtonProps {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly active?: boolean;
  readonly size?: "regular" | "small";
}

export function MapButton({ icon, label, onPress, active = false, size = "regular" }: MapButtonProps) {
  const { colors } = useTheme();
  const side = size === "regular" ? 48 : 34;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-selected={active}
      hitSlop={size === "regular" ? 0 : (layout.hitSlop - side) / 2}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { width: side, height: side, borderRadius: side / 2, backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: active ? colors.mark : colors.line },
      ]}
    >
      <Icon name={icon} size={size === "regular" ? 22 : 18} color={active ? colors.mark : colors.text} />
    </Pressable>
  );
}

interface AttributionButtonProps {
  readonly attribution: readonly MapAttribution[];
}

/** Sources credited behind an information button, the map being too small to print them (MAP-004). */
export function AttributionButton({ attribution }: AttributionButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MapButton icon="info" label="Sources de la carte" size="small" onPress={() => setOpen(true)} />
      <Sheet open={open} title="Sources de la carte" context="Fond, relief et données cartographiques" onClose={() => setOpen(false)}>
        <View>
          {attribution.map((source) => (
            <MenuItem key={source.label} label={source.label} detail={source.url.replace(/^https:\/\//, "")} onPress={() => void Linking.openURL(source.url)} />
          ))}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
});
