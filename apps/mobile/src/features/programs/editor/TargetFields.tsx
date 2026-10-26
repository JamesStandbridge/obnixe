import { Pressable, StyleSheet, View } from "react-native";
import { efforts, gradeScales, gradeValue, sports } from "@obnixe/schema";
import type { Effort, FieldDefinition, FieldValue, FieldValues } from "@obnixe/schema";
import type { DraftSlot } from "@obnixe/core";
import { Chips } from "@/features/programs/Chips";
import { effortLabels, formatTargetDuration } from "@/features/programs/format";
import { formatQuantity, quantityUnit } from "@/features/programs/units";
import type { SlotPatch } from "@/features/programs/editor/draftReducer";
import { Stepper, Switch } from "@/ui/Controls";
import { Question, Scale, TextField } from "@/ui/Inputs";
import { Icon } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

interface TargetFieldsProps {
  readonly slot: DraftSlot;
  readonly onPatch: (patch: SlotPatch) => void;
  readonly onPad: (field: string) => void;
}

function withValue(values: FieldValues, key: string, value: FieldValue | null): FieldValues {
  const next: FieldValues = { ...values };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

export function TargetFields({ slot, onPatch, onPad }: TargetFieldsProps) {
  const minutes = slot.targetDurationSeconds === null ? 0 : Math.round(slot.targetDurationSeconds / 60);
  const setValue = (key: string, value: FieldValue | null): void => onPatch({ targetValues: withValue(slot.targetValues, key, value) });
  const definitions: readonly FieldDefinition[] = sports[slot.sport].sessionFields;
  const fields = definitions.filter((field) => field.retired !== true);
  return (
    <View>
      <Question title="Durée cible" hint="facultatif">
        <Stepper
          label="Durée cible"
          value={minutes}
          step={5}
          min={0}
          max={600}
          unit={minutes === 0 || minutes >= 60 ? "" : "min"}
          format={(value) => (value === 0 ? "—" : value >= 60 ? formatTargetDuration(value * 60) : String(value))}
          onChange={(value) => onPatch({ targetDurationSeconds: value === 0 ? null : value * 60 })}
        />
      </Question>
      <Question title="Effort visé" hint="facultatif">
        <Scale<Effort>
          label="Effort visé"
          words
          optional
          options={efforts.map((effort) => ({ value: effort, label: effortLabels[effort] }))}
          value={slot.targetEffort}
          onChange={(value) => onPatch({ targetEffort: value })}
        />
      </Question>
      {fields.map((field) => (
        <TargetField key={field.key} field={field} slot={slot} onValue={(value) => setValue(field.key, value)} onPad={() => onPad(field.key)} />
      ))}
    </View>
  );
}

interface TargetFieldProps {
  readonly field: FieldDefinition;
  readonly slot: DraftSlot;
  readonly onValue: (value: FieldValue | null) => void;
  readonly onPad: () => void;
}

function TargetField({ field, slot, onValue, onPad }: TargetFieldProps) {
  const { colors } = useTheme();
  const value = slot.targetValues[field.key];
  switch (field.type) {
    case "choice": {
      const options = field.options.filter((option) => option.retired !== true).map((option) => ({ value: option.key, label: option.label }));
      if (field.multiple) {
        const selected = Array.isArray(value) ? value : [];
        return (
          <Question title={field.label}>
            <Chips
              label={field.label}
              multiple
              options={options}
              selected={selected}
              onToggle={(key) => {
                const next = selected.includes(key) ? selected.filter((entry) => entry !== key) : [...selected, key];
                onValue(next.length === 0 ? null : next);
              }}
            />
          </Question>
        );
      }
      const current = typeof value === "string" ? value : null;
      return (
        <Question title={field.label}>
          {options.length <= 4 ? (
            <Scale<string> label={field.label} words optional options={options} value={current} onChange={(next) => onValue(next)} />
          ) : (
            <Chips label={field.label} multiple={false} options={options} selected={current === null ? [] : [current]} onToggle={(key) => onValue(key === current ? null : key)} />
          )}
        </Question>
      );
    }
    case "grade": {
      const [scale] = field.scales;
      const options = gradeScales[scale].grades.map((grade) => ({ value: gradeValue(scale, grade), label: grade }));
      const current = typeof value === "string" ? value : null;
      return (
        <Question title={field.label}>
          <Chips label={field.label} multiple={false} options={options} selected={current === null ? [] : [current]} onToggle={(key) => onValue(key === current ? null : key)} />
        </Question>
      );
    }
    case "quantity": {
      const unit = quantityUnit(field.dimension, field.key, slot.sport);
      const display = typeof value === "number" ? formatQuantity(value, unit) : null;
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${field.label}, ${display ?? "non défini"}`}
          onPress={onPad}
          style={({ pressed }) => [styles.quantity, { borderBottomColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
        >
          <Text variant="bodyStrong" style={styles.quantityLabel}>
            {field.label}
          </Text>
          <Text style={display === null ? [styles.empty, { color: colors.text3 }] : styles.value}>{display ?? "Ajouter"}</Text>
          <Icon name="chevron" color={colors.text3} />
        </Pressable>
      );
    }
    case "text":
      return (
        <Question title={field.label}>
          <TextField value={typeof value === "string" ? value : ""} placeholder={field.label} accessibilityLabel={field.label} onChangeText={(text) => onValue(text.trim() === "" ? null : text)} />
        </Question>
      );
    case "toggle":
      return (
        <View style={styles.toggle}>
          <Text variant="bodyStrong" style={styles.quantityLabel}>
            {field.label}
          </Text>
          <Switch label={field.label} value={value === true} onChange={(next) => onValue(next ? true : null)} />
        </View>
      );
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
}

const styles = StyleSheet.create({
  quantity: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, borderBottomWidth: 1, marginTop: 8 },
  quantityLabel: { flex: 1 },
  value: { fontFamily: fonts.figure700, fontSize: 18 },
  empty: { fontFamily: fonts.text600, fontSize: 15 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, marginTop: 8 },
});
