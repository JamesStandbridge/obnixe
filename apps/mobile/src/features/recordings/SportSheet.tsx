import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { resolveProfile } from "@obnixe/core";
import type { SportChange } from "@obnixe/core";
import { sportKeys, sports } from "@obnixe/schema";
import type { FieldDefinition, FieldValue, Session, SportKey } from "@obnixe/schema";
import { SwitchRow } from "@/features/data/parts";
import { FilterChips } from "@/features/stats/parts";
import type { ChipOption } from "@/features/stats/parts";
import { SheetButton } from "@/ui/Button";
import { Question } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";

/** Sports that record a track, so a recorded activity can move to any of them. */
const recordableSports: readonly SportKey[] = sportKeys.filter((key) => sports[key].recording !== null);

interface Variant {
  readonly key: string;
  readonly label: string;
}

function variantsOf(sport: SportKey): readonly Variant[] {
  const fields: readonly FieldDefinition[] = sports[sport].sessionFields;
  const field = fields.find((candidate) => candidate.key === "kind");
  if (field === undefined || field.type !== "choice") return [];
  return field.options.filter((option) => option.retired !== true && resolveProfile(sport, { kind: option.key }) !== null).map((option) => ({ key: option.key, label: option.label }));
}

function hasElectricOption(sport: SportKey): boolean {
  return sports[sport].sessionFields.some((field) => field.key === "e_bike");
}

interface SportSheetProps {
  readonly open: boolean;
  readonly session: Session;
  readonly onClose: () => void;
  readonly onSave: (change: SportChange) => void;
}

/** `SUM-004`: another sport or variant, measured again with its recording profile. */
export function SportSheet({ open, session, onClose, onSave }: SportSheetProps) {
  const [sport, setSport] = useState<SportKey>(session.sport);
  const [kind, setKind] = useState<string | null>(typeof session.values.kind === "string" ? session.values.kind : null);
  const [electric, setElectric] = useState(session.values.e_bike === true);

  useEffect(() => {
    if (!open) return;
    setSport(session.sport);
    setKind(typeof session.values.kind === "string" ? session.values.kind : null);
    setElectric(session.values.e_bike === true);
  }, [open, session]);

  const variants = variantsOf(sport);
  const chosenKind = kind !== null && variants.some((variant) => variant.key === kind) ? kind : null;
  const sportOptions: readonly ChipOption<SportKey>[] = recordableSports.map((key) => ({ value: key, label: sports[key].label, sport: key }));
  const kindOptions: readonly ChipOption<string>[] = variants.map((variant) => ({ value: variant.key, label: variant.label }));
  const unchanged = sport === session.sport && chosenKind === (session.values.kind ?? null) && electric === (session.values.e_bike === true);

  const save = (): void => {
    const values: Record<string, FieldValue> = {};
    if (chosenKind !== null) values.kind = chosenKind;
    if (hasElectricOption(sport) && electric) values.e_bike = true;
    onSave({ sport, values });
  };

  return (
    <Sheet open={open} title="Changer de sport" context="Distance, allure, splits et records sont recalculés avec le profil choisi" onClose={onClose}>
      <Question title="Sport">
        <FilterChips label="Sport" options={sportOptions} value={sport} onChange={setSport} />
      </Question>
      {kindOptions.length === 0 ? null : (
        <Question title={sports[sport].sessionFields.find((field) => field.key === "kind")?.label ?? "Variante"}>
          <FilterChips label="Variante" options={kindOptions} value={chosenKind ?? ""} onChange={setKind} />
        </Question>
      )}
      {hasElectricOption(sport) ? (
        <View style={styles.toggle}>
          <SwitchRow title="Assistance électrique" detail="hors records de vélo" value={electric} onChange={setElectric} />
        </View>
      ) : null}
      <SheetButton label="Recalculer" disabled={unchanged} onPress={save} style={styles.save} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  toggle: { marginTop: 20, gap: 6 },
  save: { marginTop: 20 },
});
