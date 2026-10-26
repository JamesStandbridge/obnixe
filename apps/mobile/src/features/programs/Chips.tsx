import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

export interface ChipOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface ChipsProps<T extends string> {
  readonly label: string;
  readonly options: readonly ChipOption<T>[];
  readonly selected: readonly T[];
  readonly multiple: boolean;
  readonly onToggle: (value: T) => void;
  readonly disabled?: boolean;
}

export function Chips<T extends string>({ label, options, selected, multiple, onToggle, disabled = false }: ChipsProps<T>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.chips, disabled && styles.disabled]} accessibilityRole={multiple ? undefined : "radiogroup"} accessibilityLabel={label}>
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <Pressable
            key={option.value}
            accessibilityRole={multiple ? "checkbox" : "radio"}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => onToggle(option.value)}
            style={({ pressed }) => [
              styles.chip,
              {
                borderColor: on ? colors.text : colors.controlBorder,
                borderWidth: on ? 2 : layout.borderControl,
                backgroundColor: on || pressed ? colors.surface : "transparent",
              },
            ]}
          >
            <Text variant="label" tone={on ? "primary" : "secondary"} style={on ? styles.on : undefined}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { minHeight: 44, paddingHorizontal: 12, borderRadius: radii.control, justifyContent: "center" },
  on: { fontFamily: fonts.text700 },
  disabled: { opacity: 0.4 },
});
