import { Pressable, StyleSheet, View } from "react-native";
import { sports } from "@obnixe/schema";
import type { Id, ZoneKey } from "@obnixe/schema";
import type { DraftItem, DraftSlot, DraftVariant, LatestZonePain } from "@obnixe/core";
import { worstPain } from "@/features/programs/data";
import { formatItemDetail, formatPrescription, slotDetail, slotTitle, zoneLabel } from "@/features/programs/format";
import type { ExerciseName } from "@/features/programs/format";
import type { SlotPatch } from "@/features/programs/editor/draftReducer";
import { TargetFields } from "@/features/programs/editor/TargetFields";
import { ControlButton, LinkButton } from "@/ui/Button";
import { PainMark, Segmented, Tag } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

const addVariant = "__add";

export interface ItemMarks {
  readonly name: ExerciseName;
  readonly zones: ReadonlyMap<Id, readonly ZoneKey[]>;
  readonly pain: ReadonlyMap<ZoneKey, LatestZonePain>;
  readonly agentItems: ReadonlySet<Id>;
  readonly agentLabel: string | null;
}

interface SlotListProps {
  readonly slots: readonly DraftSlot[];
  readonly openSlot: Id | null;
  readonly nextSlot: Id | null;
  readonly selectedVariants: ReadonlyMap<Id, Id>;
  readonly marks: ItemMarks;
  readonly onToggle: (slotId: Id) => void;
  readonly onSelectVariant: (slotId: Id, variantId: Id) => void;
  readonly onAddVariant: (slotId: Id) => void;
  readonly onEditSlot: (slotId: Id) => void;
  readonly onPatchSlot: (slotId: Id, patch: SlotPatch) => void;
  readonly onPad: (slotId: Id, field: string) => void;
  readonly onItem: (slot: DraftSlot, variant: DraftVariant, item: DraftItem) => void;
  readonly onAddItem: (slot: DraftSlot, variant: DraftVariant) => void;
}

export function SlotList(props: SlotListProps) {
  const { colors } = useTheme();
  const { slots, openSlot, nextSlot, selectedVariants, onToggle } = props;
  return (
    <View>
      {slots.map((slot) => {
        const open = slot.lineageId === openSlot;
        const strength = sports[slot.sport].archetype === "strength";
        const variant = slot.variants.find((entry) => entry.lineageId === selectedVariants.get(slot.lineageId)) ?? slot.variants[0] ?? null;
        const isNext = slot.lineageId === nextSlot;
        const title = open && strength ? slot.name : slotTitle(slot);
        const detail = open && isNext ? "prochaine" : slotDetail(slot);
        return (
          <View key={slot.lineageId}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${slotTitle(slot)}, ${slotDetail(slot)}`}
              accessibilityState={{ expanded: open }}
              onPress={() => onToggle(slot.lineageId)}
              style={({ pressed }) => [styles.row, { borderBottomColor: colors.line, borderBottomWidth: open ? 0 : 1 }, pressed && { backgroundColor: colors.surface }]}
            >
              <View style={styles.handle}>
                <Icon name="reorder" color={colors.text3} />
              </View>
              <SportIcon sport={slot.sport} variant={open ? "filled" : "plain"} label={sports[slot.sport].label} />
              <View style={styles.main}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {title.trim() === "" ? "Séance sans nom" : title}
                </Text>
                <Text variant="small" tone="secondary" numberOfLines={1}>
                  {detail}
                </Text>
              </View>
              <Icon name={open ? "collapse" : "expand"} color={colors.text3} />
            </Pressable>
            {open ? (
              <View style={[styles.template, { backgroundColor: colors.surface }]}>
                {strength ? <StrengthTemplate {...props} slot={slot} variant={variant} /> : <TargetFields slot={slot} onPatch={(patch) => props.onPatchSlot(slot.lineageId, patch)} onPad={(field) => props.onPad(slot.lineageId, field)} />}
                <LinkButton label="Réglages de la séance" onPress={() => props.onEditSlot(slot.lineageId)} style={styles.slotLink} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

interface StrengthTemplateProps extends SlotListProps {
  readonly slot: DraftSlot;
  readonly variant: DraftVariant | null;
}

function StrengthTemplate({ slot, variant, marks, onSelectVariant, onAddVariant, onEditSlot, onItem, onAddItem }: StrengthTemplateProps) {
  const { colors } = useTheme();
  return (
    <View>
      <View style={styles.variants}>
        <Segmented<string>
          options={[...slot.variants.map((entry) => ({ value: entry.lineageId, label: entry.name.trim() === "" ? "Sans nom" : entry.name })), { value: addVariant, label: "+ Variante" }]}
          value={variant?.lineageId ?? null}
          onChange={(value) => {
            if (value === addVariant) onAddVariant(slot.lineageId);
            else if (value === variant?.lineageId) onEditSlot(slot.lineageId);
            else onSelectVariant(slot.lineageId, value as Id);
          }}
        />
      </View>
      {variant === null
        ? null
        : variant.items.map((item, index) => {
            const pain = worstPain(marks.zones.get(item.exerciseId) ?? [], marks.pain);
            const detail = formatItemDetail(item);
            const agent = marks.agentLabel !== null && marks.agentItems.has(item.lineageId);
            return (
              <Pressable
                key={item.lineageId}
                accessibilityRole="button"
                accessibilityLabel={`${index + 1}, ${marks.name(item.exerciseId)}, ${formatPrescription(item)}${detail === "" ? "" : `, ${detail}`}`}
                onPress={() => onItem(slot, variant, item)}
                style={({ pressed }) => [styles.item, { borderBottomColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
              >
                <Text style={[styles.itemNumber, { color: colors.text3 }]}>{index + 1}</Text>
                <View style={styles.main}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {marks.name(item.exerciseId)}
                  </Text>
                  {detail === "" && pain === null && !agent ? null : (
                    <View style={styles.itemMeta}>
                      {detail === "" ? null : (
                        <Text variant="small" tone="secondary">
                          {detail}
                        </Text>
                      )}
                      {pain === null ? null : (
                        <View accessible accessibilityRole="image" accessibilityLabel={`${zoneLabel(pain.zone)}, ${pain.level === "stop" ? "arrêt" : "gêne"}`} style={styles.itemMeta}>
                          {detail === "" ? null : (
                            <Text variant="small" tone="secondary">
                              ·
                            </Text>
                          )}
                          <PainMark level={pain.level} />
                        </View>
                      )}
                      {agent && marks.agentLabel !== null ? (
                        <>
                          {detail === "" && pain === null ? null : (
                            <Text variant="small" tone="secondary">
                              ·
                            </Text>
                          )}
                          <Tag label={marks.agentLabel} />
                        </>
                      ) : null}
                    </View>
                  )}
                </View>
                <Text style={[styles.prescription, { color: colors.text2 }]}>{formatPrescription(item)}</Text>
              </Pressable>
            );
          })}
      {variant === null ? null : <ControlButton label="Ajouter un exercice" onPress={() => onAddItem(slot, variant)} style={styles.addItem} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10 },
  handle: { width: 28, height: 44, alignItems: "center", justifyContent: "center" },
  main: { flex: 1, minWidth: 0, gap: 3 },
  template: { marginBottom: 10, paddingTop: 4, paddingHorizontal: 14, paddingBottom: 14, borderRadius: radii.panel },
  variants: { marginTop: 10, marginBottom: 6 },
  item: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10, borderBottomWidth: 1 },
  itemNumber: { width: 22, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 18 },
  itemMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  prescription: { fontFamily: fonts.figure600, fontSize: 15, lineHeight: 18 },
  addItem: { marginTop: 10 },
  slotLink: { alignSelf: "flex-start", marginLeft: -10, marginTop: 8 },
});
