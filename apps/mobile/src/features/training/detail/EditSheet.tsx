import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { gramsToMass, massToGrams } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { Dimension, FieldDefinition, FieldValue, FieldValues, MassUnit, Session } from "@obnixe/schema";
import { formatNumber } from "@/format/numbers";
import { SheetButton } from "@/ui/Button";
import { Segmented, Switch } from "@/ui/Controls";
import { Question, TextField } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { layout, radii } from "@/ui/tokens";

export interface SessionPatch {
  readonly title: string | null;
  readonly note: string | null;
  readonly values: FieldValues;
}

interface EditSheetProps {
  readonly open: boolean;
  readonly session: Session;
  readonly placeholder: string;
  readonly unit: MassUnit;
  readonly onClose: () => void;
  readonly onSave: (patch: SessionPatch) => void;
}

interface QuantityScale {
  readonly unit: string;
  readonly toInput: (value: number) => number;
  readonly fromInput: (value: number) => number;
  readonly decimals: number;
}

function quantityScale(key: string, dimension: Dimension, unit: MassUnit): QuantityScale {
  const identity = (value: number): number => value;
  switch (dimension) {
    case "distance":
      if (key === "elevation_gain" || key === "pool_length") return { unit: "m", toInput: identity, fromInput: Math.round, decimals: 0 };
      return { unit: "km", toInput: (value) => value / 1000, fromInput: (value) => Math.round(value * 1000), decimals: 2 };
    case "mass":
      return { unit, toInput: (value) => gramsToMass(value, unit), fromInput: (value) => massToGrams(value, unit), decimals: 1 };
    case "length":
      return { unit: "cm", toInput: (value) => value / 10, fromInput: (value) => Math.round(value * 10), decimals: 1 };
    case "duration":
      return { unit: "min", toInput: (value) => value / 60, fromInput: (value) => Math.round(value * 60), decimals: 0 };
    case "count":
      return { unit: "", toInput: identity, fromInput: Math.round, decimals: 0 };
    case "heart_rate":
      return { unit: "bpm", toInput: identity, fromInput: Math.round, decimals: 0 };
    case "power":
      return { unit: "W", toInput: identity, fromInput: Math.round, decimals: 0 };
    default: {
      const unreachable: never = dimension;
      return unreachable;
    }
  }
}

type Inputs = Readonly<Record<string, string>>;

function initialInputs(fields: readonly FieldDefinition[], values: FieldValues, unit: MassUnit): Inputs {
  const inputs: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === "quantity" && typeof value === "number") inputs[field.key] = formatNumber(quantityScale(field.key, field.dimension, unit).toInput(value), 2);
    if (field.type === "text" && typeof value === "string") inputs[field.key] = value;
  }
  return inputs;
}

function parseNumber(text: string): number | null {
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function EditSheet({ open, session, placeholder, unit, onClose, onSave }: EditSheetProps) {
  const { colors } = useTheme();
  const definitions: readonly FieldDefinition[] = sports[session.sport].sessionFields;
  const fields = definitions.filter((field) => field.retired !== true);
  const [title, setTitle] = useState(session.title ?? "");
  const [note, setNote] = useState(session.note ?? "");
  const [values, setValues] = useState<FieldValues>(session.values);
  const [inputs, setInputs] = useState<Inputs>(() => initialInputs(fields, session.values, unit));

  useEffect(() => {
    if (!open) return;
    setTitle(session.title ?? "");
    setNote(session.note ?? "");
    setValues(session.values);
    setInputs(initialInputs(sports[session.sport].sessionFields, session.values, unit));
  }, [open, session, unit]);

  const setValue = (key: string, value: FieldValue | null): void => {
    const next: Record<string, FieldValue> = { ...values };
    if (value === null) delete next[key];
    else next[key] = value;
    setValues(next);
  };

  const save = (): void => {
    const next: Record<string, FieldValue> = { ...values };
    for (const field of fields) {
      if (field.type === "quantity") {
        const parsed = parseNumber(inputs[field.key] ?? "");
        if (parsed === null) delete next[field.key];
        else next[field.key] = quantityScale(field.key, field.dimension, unit).fromInput(parsed);
      }
      if (field.type === "text") {
        const text = (inputs[field.key] ?? "").trim();
        if (text === "") delete next[field.key];
        else next[field.key] = text;
      }
    }
    onSave({ title: title.trim() === "" ? null : title.trim(), note: note.trim() === "" ? null : note.trim(), values: next });
  };

  const renderField = (field: FieldDefinition) => {
    switch (field.type) {
      case "quantity": {
        const scale = quantityScale(field.key, field.dimension, unit);
        return (
          <View style={styles.quantity}>
            <TextField
              value={inputs[field.key] ?? ""}
              onChangeText={(text) => setInputs({ ...inputs, [field.key]: text })}
              keyboardType={scale.decimals === 0 ? "number-pad" : "decimal-pad"}
              accessibilityLabel={field.label}
              placeholder="–"
              style={styles.quantityInput}
            />
            {scale.unit === "" ? null : (
              <Text variant="label" tone="secondary" style={styles.quantityUnit}>
                {scale.unit}
              </Text>
            )}
          </View>
        );
      }
      case "choice": {
        const current = values[field.key];
        if (field.multiple) {
          const selected = Array.isArray(current) ? current : [];
          return (
            <View style={styles.chips}>
              {field.options
                .filter((option) => option.retired !== true)
                .map((option) => {
                  const on = selected.includes(option.key);
                  return (
                    <Pressable
                      key={option.key}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      onPress={() => setValue(field.key, on ? selected.filter((key) => key !== option.key) : [...selected, option.key])}
                      style={[styles.chip, { borderColor: on ? colors.text : colors.controlBorder, borderWidth: on ? 2 : layout.borderControl, backgroundColor: on ? colors.surface : "transparent" }]}
                    >
                      <Text variant="label" tone={on ? "primary" : "secondary"}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
          );
        }
        return (
          <Segmented
            options={field.options.filter((option) => option.retired !== true).map((option) => ({ value: option.key, label: option.label }))}
            value={typeof current === "string" ? current : null}
            onChange={(key) => setValue(field.key, key === current && !field.required ? null : key)}
          />
        );
      }
      case "text":
        return <TextField value={inputs[field.key] ?? ""} onChangeText={(text) => setInputs({ ...inputs, [field.key]: text })} accessibilityLabel={field.label} />;
      case "toggle":
        return <Switch value={values[field.key] === true} onChange={(on) => setValue(field.key, on)} label={field.label} />;
      case "grade":
        return null;
      default: {
        const unreachable: never = field;
        return unreachable;
      }
    }
  };

  return (
    <Sheet open={open} title="Corriger la saisie" onClose={onClose}>
      <Question title="Titre">
        <TextField value={title} onChangeText={setTitle} placeholder={placeholder} accessibilityLabel="Titre" />
      </Question>
      {fields
        .filter((field) => field.type !== "grade")
        .map((field) => (
          <Question key={field.key} title={field.label}>
            {renderField(field)}
          </Question>
        ))}
      <Question title="Note">
        <TextField value={note} onChangeText={setNote} placeholder="Note libre" accessibilityLabel="Note" multiline />
      </Question>
      <SheetButton label="Enregistrer" onPress={save} style={styles.save} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  quantity: { flexDirection: "row", alignItems: "center", gap: 10, paddingRight: 2 },
  quantityInput: { flex: 1, minWidth: 0, width: "100%" },
  quantityUnit: { minWidth: 32 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { minHeight: 44, paddingHorizontal: 14, borderRadius: radii.control, justifyContent: "center" },
  save: { marginTop: 20 },
});
