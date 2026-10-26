import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { sports } from "@obnixe/schema";
import type { FieldValue, SportKey } from "@obnixe/schema";
import type { DraftSlot, DraftVariant } from "@obnixe/core";
import { padValue, quantityUnit } from "@/features/programs/units";
import type { QuantityUnit } from "@/features/programs/units";
import type { DraftAction } from "@/features/programs/editor/draftReducer";
import { ControlButton, SheetButton } from "@/ui/Button";
import { Switch } from "@/ui/Controls";
import { IconButton, MenuItem, Question, TextField } from "@/ui/Inputs";
import { PadSheet } from "@/ui/PadSheet";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Text } from "@/ui/Text";

interface AddSlotSheetProps {
  readonly sports: readonly SportKey[];
  readonly onAdd: (sport: SportKey) => void;
}

export function AddSlotSheet({ sports: enabled, onAdd }: AddSlotSheetProps) {
  return (
    <View style={styles.menu}>
      {enabled.map((sport) => (
        <MenuItem
          key={sport}
          label={sports[sport].label}
          {...(sports[sport].archetype === "strength" ? { detail: "Exercices, séries, variantes" } : {})}
          leading={<SportIcon sport={sport} />}
          onPress={() => onAdd(sport)}
        />
      ))}
    </View>
  );
}

interface SlotSheetProps {
  readonly slot: DraftSlot;
  readonly position: number;
  readonly count: number;
  readonly dispatch: (action: DraftAction) => void;
  readonly onRemove: () => void;
  readonly onDone: () => void;
}

export function SlotSheet({ slot, position, count, dispatch, onRemove, onDone }: SlotSheetProps) {
  const strength = sports[slot.sport].archetype === "strength";
  return (
    <View>
      <Question title="Nom de la séance">
        <TextField value={slot.name} onChangeText={(name) => dispatch({ type: "update_slot", slotId: slot.lineageId, patch: { name } })} placeholder="Nom" accessibilityLabel="Nom de la séance" />
      </Question>
      {strength ? (
        <Question title="Variantes" hint="choisies au démarrage">
          {slot.variants.map((variant) => (
            <View key={variant.lineageId} style={styles.variant}>
              <TextField
                value={variant.name}
                onChangeText={(name) => dispatch({ type: "rename_variant", slotId: slot.lineageId, variantId: variant.lineageId, name })}
                placeholder="Nom de la variante"
                accessibilityLabel={`Nom de la variante ${variant.name}`}
                style={styles.variantField}
              />
              {slot.variants.length > 1 ? (
                <IconButton icon="close" label={`Supprimer la variante ${variant.name}`} edge="end" onPress={() => dispatch({ type: "remove_variant", slotId: slot.lineageId, variantId: variant.lineageId })} />
              ) : null}
            </View>
          ))}
        </Question>
      ) : null}
      <View style={styles.actions}>
        <ControlButton label="Monter" disabled={position === 0} onPress={() => dispatch({ type: "move_slot", slotId: slot.lineageId, offset: -1 })} style={styles.action} />
        <ControlButton label="Descendre" disabled={position === count - 1} onPress={() => dispatch({ type: "move_slot", slotId: slot.lineageId, offset: 1 })} style={styles.action} />
      </View>
      <SheetButton label="Terminé" onPress={onDone} style={styles.done} />
      <ControlButton label="Retirer de la rotation" onPress={onRemove} style={styles.remove} />
    </View>
  );
}

interface NewVariantSheetProps {
  readonly slot: DraftSlot;
  readonly source: DraftVariant | null;
  readonly onCreate: (name: string, copy: boolean) => void;
}

function suggestVariantName(slot: DraftSlot): string {
  const names = new Set(slot.variants.map((variant) => variant.name.trim().toLowerCase()));
  if (!names.has("sans matériel")) return "Sans matériel";
  let index = slot.variants.length + 1;
  while (names.has(`variante ${index}`)) index += 1;
  return `Variante ${index}`;
}

export function NewVariantSheet({ slot, source, onCreate }: NewVariantSheetProps) {
  const [name, setName] = useState(() => suggestVariantName(slot));
  const [copy, setCopy] = useState(false);
  const [existing] = useState(() => new Set(slot.variants.map((variant) => variant.name.trim().toLowerCase())));
  const taken = existing.has(name.trim().toLowerCase());
  return (
    <View>
      <TextField value={name} onChangeText={setName} placeholder="Nom de la variante" accessibilityLabel="Nom de la variante" selectTextOnFocus />
      {taken ? (
        <Text variant="small" tone="secondary" style={styles.hint}>
          Une variante porte déjà ce nom.
        </Text>
      ) : null}
      {source === null || source.items.length === 0 ? null : (
        <View style={styles.copy}>
          <Text variant="bodyStrong" style={styles.copyLabel}>
            Reprendre les exercices de « {source.name} »
          </Text>
          <Switch label={`Reprendre les exercices de ${source.name}`} value={copy} onChange={setCopy} />
        </View>
      )}
      <SheetButton label="Créer la variante" disabled={name.trim() === "" || taken} onPress={() => onCreate(name.trim(), copy)} style={styles.done} />
    </View>
  );
}

interface TargetPadSheetProps {
  readonly open: boolean;
  readonly slot: DraftSlot;
  readonly fieldKey: string;
  readonly onValue: (value: FieldValue | null) => void;
  readonly onClose: () => void;
}

function rangeWarning(min: number | null, max: number | null, unit: QuantityUnit): string {
  if (min !== null && max !== null) return `Entre ${padValue(min, unit)} et ${padValue(max, unit)} ${unit.unit}`.trim();
  if (min !== null) return `Au moins ${padValue(min, unit)} ${unit.unit}`.trim();
  return `Au plus ${padValue(max ?? 0, unit)} ${unit.unit}`.trim();
}

export function TargetPadSheet({ open, slot, fieldKey, onValue, onClose }: TargetPadSheetProps) {
  const field = sports[slot.sport].sessionFields.find((entry) => entry.key === fieldKey);
  if (field?.type !== "quantity") return null;
  const unit = quantityUnit(field.dimension, field.key, slot.sport);
  const current = slot.targetValues[fieldKey];
  const outOfRange = (stored: number): boolean => (field.min !== null && stored < field.min) || (field.max !== null && stored > field.max);
  return (
    <PadSheet
      open={open}
      title={field.label}
      context={`${slot.name} · objectif`}
      mode="number"
      unit={unit.unit}
      decimals={unit.decimals}
      current={null}
      initialBuffer={typeof current === "number" ? padValue(current, unit) : ""}
      validate={(value) => (outOfRange(Math.round(value * unit.factor)) ? rangeWarning(field.min, field.max, unit) : null)}
      confirmLabel={(entry) => (entry.value === null ? "Valider" : `Utiliser ${entry.buffer} ${unit.unit}`.trim())}
      {...(typeof current === "number" ? { action: { label: "Effacer l'objectif", appearance: "control", onPress: () => onValue(null) } } : {})}
      onSubmit={(result) => {
        if (result.kind === "value") onValue(Math.round(result.value * unit.factor));
      }}
      onClose={onClose}
    />
  );
}

const styles = StyleSheet.create({
  menu: { marginTop: 8 },
  variant: { flexDirection: "row", alignItems: "center", gap: 8 },
  variantField: { flex: 1 },
  actions: { flexDirection: "row", gap: 6, marginTop: 20 },
  action: { flex: 1 },
  done: { marginTop: 14 },
  remove: { marginTop: 10 },
  hint: { marginTop: 8 },
  copy: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, marginTop: 12 },
  copyLabel: { flex: 1 },
});
