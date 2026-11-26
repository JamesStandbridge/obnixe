import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { gearWearBounds, isWorn, localDateOf } from "@obnixe/core";
import type { GearUsage } from "@obnixe/core";
import type { ChoiceOption, Gear, Id, LocalDate, SportKey, ZoneKey } from "@obnixe/schema";
import { formatShortDay, shiftDay } from "@/features/activity/format";
import { deviceTimeZone, formatTimeOfDay } from "@/format/dates";
import { environment } from "@/data/database";
import { formatKilometers } from "@/features/activity/presentation";
import { zoneLabel } from "@/format/labels";
import { ControlButton, LinkButton, SheetButton } from "@/ui/Button";
import { Segmented, StepButton } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Choices, MenuItem, TextField } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

export type WhenDay = "today" | "yesterday" | "other";

export interface WhenValue {
  readonly day: WhenDay;
  readonly date: LocalDate;
  readonly minutes: number;
}

export function whenLabel(value: WhenValue): string {
  switch (value.day) {
    case "today":
      return `Aujourd'hui, ${formatTimeOfDay(value.minutes)}`;
    case "yesterday":
      return `Hier, ${formatTimeOfDay(value.minutes)}`;
    case "other":
      return `${formatShortDay(value.date)}, ${formatTimeOfDay(value.minutes)}`;
    default: {
      const unreachable: never = value.day;
      return unreachable;
    }
  }
}

interface WhenSheetProps {
  readonly open: boolean;
  readonly value: WhenValue;
  readonly onConfirm: (value: WhenValue) => void;
  readonly onClose: () => void;
}

export function WhenSheet({ open, value, onConfirm, onClose }: WhenSheetProps) {
  const [draft, setDraft] = useState<WhenValue>(value);
  const today = localDateOf(environment.now(), deviceTimeZone());

  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const chooseDay = (day: WhenDay): void => {
    switch (day) {
      case "today":
        setDraft({ ...draft, day, date: today });
        return;
      case "yesterday":
        setDraft({ ...draft, day, date: shiftDay(today, -1) });
        return;
      case "other":
        setDraft({ ...draft, day, date: draft.day === "other" ? draft.date : shiftDay(today, -2) });
        return;
      default: {
        const unreachable: never = day;
        return unreachable;
      }
    }
  };

  return (
    <Sheet open={open} title="Quand ?" onClose={onClose}>
      <Segmented<WhenDay>
        options={[
          { value: "today", label: "Aujourd'hui" },
          { value: "yesterday", label: "Hier" },
          { value: "other", label: "Autre jour…" },
        ]}
        value={draft.day}
        onChange={chooseDay}
      />
      {draft.day === "other" ? (
        <View style={styles.stepper}>
          <StepButton icon="back" accessibilityLabel="Jour précédent" onPress={() => setDraft({ ...draft, date: shiftDay(draft.date, -1) })} />
          <View style={styles.stepValue} accessibilityLiveRegion="polite">
            <Text style={styles.dayValue}>{formatShortDay(draft.date)}</Text>
          </View>
          <StepButton
            icon="forward"
            accessibilityLabel="Jour suivant"
            disabled={shiftDay(draft.date, 1) >= shiftDay(today, -1)}
            onPress={() => setDraft({ ...draft, date: shiftDay(draft.date, 1) })}
          />
        </View>
      ) : null}
      <View style={styles.stepper}>
        <StepButton label="−15" accessibilityLabel="15 minutes plus tôt" onPress={() => setDraft({ ...draft, minutes: (draft.minutes - 15 + 1440) % 1440 })} />
        <View style={styles.stepValue} accessibilityLiveRegion="polite">
          <Text variant="figure">{formatTimeOfDay(draft.minutes)}</Text>
        </View>
        <StepButton label="+15" accessibilityLabel="15 minutes plus tard" onPress={() => setDraft({ ...draft, minutes: (draft.minutes + 15) % 1440 })} />
      </View>
      <SheetButton label="Valider" style={styles.confirm} onPress={() => onConfirm(draft)} />
    </Sheet>
  );
}

interface CatalogueSheetProps {
  readonly open: boolean;
  readonly sports: readonly SportKey[];
  readonly labelOf: (sport: SportKey) => string;
  readonly onChoose: (sport: SportKey) => void;
  readonly onClose: () => void;
}

export function CatalogueSheet({ open, sports, labelOf, onChoose, onClose }: CatalogueSheetProps) {
  return (
    <Sheet open={open} title="Autre sport" onClose={onClose}>
      <View style={styles.menu}>
        {sports.map((sport) => (
          <MenuItem key={sport} label={labelOf(sport)} leading={<SportIcon sport={sport} />} onPress={() => onChoose(sport)} />
        ))}
      </View>
    </Sheet>
  );
}

interface GearSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly items: readonly GearUsage[];
  readonly selected: Id | null;
  readonly onSelect: (gearId: Id | null) => void;
  readonly onCreate: (name: string) => void;
  readonly onSetWear: (item: Gear, wearMeters: number | null) => void;
  readonly onClose: () => void;
}

interface GearRowProps {
  readonly label: string;
  readonly detail?: string;
  readonly worn?: boolean;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly onWear?: () => void;
}

function GearRow({ label, detail, worn = false, selected, onPress, onWear }: GearRowProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.gearRow, { borderTopColor: colors.line }]}>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.gearChoice, pressed && { backgroundColor: colors.surfacePress }]}
      >
        <View style={styles.gearText}>
          <Text style={styles.menuLabel}>{label}</Text>
          {detail === undefined ? null : (
            <Text variant="caption" tone="secondary" style={worn ? { color: colors.warn } : null}>
              {detail}
            </Text>
          )}
        </View>
        {selected ? <Icon name="check" /> : null}
      </Pressable>
      {onWear === undefined ? null : <LinkButton label="Usure" onPress={onWear} style={styles.gearWear} />}
    </View>
  );
}

/** `INT-011`: the distance, then the threshold and whether it is reached. */
function gearDetail(item: GearUsage): string {
  const wearMeters = item.gear.wearMeters;
  if (wearMeters === null) return formatKilometers(item.meters);
  return `${formatKilometers(item.meters)} sur ${formatKilometers(wearMeters)}${isWorn(item) ? " · usure atteinte" : ""}`;
}

const wearKilometerBounds = { min: gearWearBounds.minMeters / 1000, max: gearWearBounds.maxMeters / 1000 } as const;

function wearMetersOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const kilometers = Number(text.trim());
  return kilometers >= wearKilometerBounds.min && kilometers <= wearKilometerBounds.max ? kilometers * 1000 : null;
}

interface GearWearFormProps {
  readonly item: GearUsage;
  readonly onSave: (wearMeters: number | null) => void;
  readonly onBack: () => void;
}

function GearWearForm({ item, onSave, onBack }: GearWearFormProps) {
  const current = item.gear.wearMeters;
  const [text, setText] = useState(current === null ? "" : String(current / 1000));
  const wearMeters = wearMetersOf(text);
  return (
    <View style={styles.wear}>
      <Text variant="small" tone="secondary">
        {`${item.gear.name} · ${formatKilometers(item.meters)} parcourus. Un signal t'avertit après l'activité qui atteint ce seuil.`}
      </Text>
      <View style={styles.create}>
        <TextField
          value={text}
          onChangeText={setText}
          placeholder="ex. 700"
          accessibilityLabel="Seuil d'usure en kilomètres"
          keyboardType="number-pad"
          autoFocus
          style={styles.createField}
          returnKeyType="done"
        />
        <Text variant="bodyStrong">km</Text>
      </View>
      <SheetButton label="Valider" disabled={wearMeters === null} onPress={() => onSave(wearMeters)} />
      <View style={styles.wearLinks}>
        <LinkButton label="Retour" onPress={onBack} />
        {current === null ? null : <LinkButton label="Sans seuil" onPress={() => onSave(null)} />}
      </View>
    </View>
  );
}

export function GearSheet({ open, title, items, selected, onSelect, onCreate, onSetWear, onClose }: GearSheetProps) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Id | null>(null);
  const edited = items.find((item) => item.gear.id === editing);

  useEffect(() => {
    if (!open) return;
    setName("");
    setEditing(null);
  }, [open]);

  if (edited !== undefined) {
    return (
      <Sheet open={open} title="Seuil d'usure" onClose={onClose}>
        <GearWearForm
          item={edited}
          onSave={(wearMeters) => {
            setEditing(null);
            onSetWear(edited.gear, wearMeters);
          }}
          onBack={() => setEditing(null)}
        />
      </Sheet>
    );
  }

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <View style={styles.menu} accessibilityRole="radiogroup">
        <GearRow label="Aucun" selected={selected === null} onPress={() => onSelect(null)} />
        {items.map((item) => (
          <GearRow
            key={item.gear.id}
            label={item.gear.name}
            detail={gearDetail(item)}
            worn={isWorn(item)}
            selected={item.gear.id === selected}
            onPress={() => onSelect(item.gear.id)}
            onWear={() => setEditing(item.gear.id)}
          />
        ))}
      </View>
      <View style={styles.create}>
        <TextField value={name} onChangeText={setName} placeholder="Nouveau, ex. Pegasus 40" accessibilityLabel="Nom du nouvel équipement" style={styles.createField} returnKeyType="done" />
        <ControlButton label="Ajouter" disabled={name.trim() === ""} onPress={() => onCreate(name)} />
      </View>
    </Sheet>
  );
}

interface TextSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly value: string | null;
  readonly placeholder?: string;
  readonly onSubmit: (value: string | null) => void;
  readonly onClose: () => void;
}

export function TextSheet({ open, title, value, placeholder, onSubmit, onClose }: TextSheetProps) {
  const [text, setText] = useState(value ?? "");

  useEffect(() => {
    if (open) setText(value ?? "");
  }, [open, value]);

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <TextField value={text} onChangeText={setText} placeholder={placeholder ?? title} accessibilityLabel={title} autoFocus style={styles.textField} />
      <SheetButton label="Valider" style={styles.confirm} onPress={() => onSubmit(text.trim() === "" ? null : text.trim())} />
      {value === null ? null : (
        <View style={styles.remove}>
          <LinkButton label="Retirer" onPress={() => onSubmit(null)} />
        </View>
      )}
    </Sheet>
  );
}

interface ChoiceSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly options: readonly ChoiceOption[];
  readonly selected: string | null;
  readonly onChoose: (value: string | null) => void;
  readonly onClose: () => void;
}

export function ChoiceSheet({ open, title, options, selected, onChoose, onClose }: ChoiceSheetProps) {
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <Choices items={options.map((option) => ({ value: option.key, label: option.label, selected: option.key === selected }))} onChoose={(value) => onChoose(value === selected ? null : value)} />
    </Sheet>
  );
}

interface ZonePickerSheetProps {
  readonly open: boolean;
  readonly zones: readonly ZoneKey[];
  readonly onPick: (zone: ZoneKey) => void;
  readonly onClose: () => void;
}

export function ZonePickerSheet({ open, zones, onPick, onClose }: ZonePickerSheetProps) {
  return (
    <Sheet open={open} title="Autre zone" onClose={onClose}>
      <View style={styles.menu}>
        {zones.map((zone) => (
          <MenuItem key={zone} label={zoneLabel(zone)} onPress={() => onPick(zone)} />
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14 },
  stepValue: { flex: 1, height: 56, alignItems: "center", justifyContent: "center" },
  dayValue: { fontFamily: fonts.text700, fontSize: 18, lineHeight: 22 },
  confirm: { marginTop: 14 },
  menu: { marginTop: 8 },
  menuLabel: { fontFamily: fonts.text600, fontSize: 17, lineHeight: 22 },
  gearRow: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 60, borderTopWidth: 1 },
  gearChoice: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, alignSelf: "stretch" },
  gearText: { flex: 1 },
  gearWear: { marginRight: -10 },
  wear: { gap: 14, paddingTop: 4 },
  wearLinks: { flexDirection: "row", justifyContent: "center", gap: 8 },
  create: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "center" },
  createField: { flex: 1 },
  textField: { marginTop: 4 },
  remove: { alignItems: "center", marginTop: 8 },
});
