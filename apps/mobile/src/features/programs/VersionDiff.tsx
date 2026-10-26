import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { diffDrafts, draftFromTree, loadVersionTree, worstPain } from "@obnixe/core";
import type { ProgramChange, VersionEntry, LatestZonePain } from "@obnixe/core";
import type { Id, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { byAuthor, describeChange, formatDateTime, formatRelative, slotDetail, slotTitle } from "@/features/programs/format";
import { lowerFirst, plural, zoneLabel } from "@/format/labels";
import type { DiffBlock, ExerciseName } from "@/features/programs/format";
import { PainMark } from "@/ui/Controls";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

export function versionSheetTitle(entry: VersionEntry): string {
  return `v${entry.version.number} · ${byAuthor(entry.author)}`;
}

export function versionSheetContext(entry: VersionEntry): string {
  const when = formatDateTime(entry.version.createdAt, environment.now());
  return entry.author.host === null ? when : `${when} · ${entry.author.host}`;
}

interface VersionComparison {
  readonly changes: readonly ProgramChange[];
  readonly first: boolean;
  readonly firstSlots: readonly string[];
  readonly restoredExercises: readonly Id[];
}

function compare(entry: VersionEntry, previous: VersionEntry | null): VersionComparison {
  const database = db();
  const tree = loadVersionTree(database, entry.version.id);
  const before = previous === null ? null : loadVersionTree(database, previous.version.id);
  if (tree === null) return { changes: [], first: false, firstSlots: [], restoredExercises: [] };
  const after = draftFromTree(tree);
  if (before === null) return { changes: [], first: true, firstSlots: after.slots.map((slot) => `${slotTitle(slot)} · ${slotDetail(slot)}`), restoredExercises: [] };
  const beforeDraft = draftFromTree(before);
  const changes = diffDrafts(beforeDraft, after);
  const current = new Set(after.slots.flatMap((slot) => slot.variants.flatMap((variant) => variant.items.map((item) => `${variant.lineageId}:${item.exerciseId}`))));
  const restored = beforeDraft.slots.flatMap((slot) => slot.variants.flatMap((variant) => variant.items.filter((item) => !current.has(`${variant.lineageId}:${item.exerciseId}`)).map((item) => item.exerciseId)));
  return { changes, first: false, firstSlots: [], restoredExercises: [...new Set(restored)] };
}

interface PainNotice {
  readonly exerciseId: Id;
  readonly pain: LatestZonePain;
}

interface VersionDiffProps {
  readonly entry: VersionEntry;
  readonly previous: VersionEntry | null;
  readonly name: ExerciseName;
  readonly zones: ReadonlyMap<Id, readonly ZoneKey[]>;
  readonly pain: ReadonlyMap<ZoneKey, LatestZonePain>;
}

export function VersionDiff({ entry, previous, name, zones, pain }: VersionDiffProps) {
  const comparison = useMemo(() => compare(entry, previous), [entry, previous]);
  const notices = useMemo(() => {
    if (!entry.revertible) return [];
    const found: PainNotice[] = [];
    for (const exerciseId of comparison.restoredExercises) {
      const worst = worstPain(zones.get(exerciseId) ?? [], pain);
      if (worst !== null) found.push({ exerciseId, pain: worst });
    }
    return found;
  }, [comparison, entry.revertible, zones, pain]);

  return (
    <View>
      {comparison.first ? (
        <Blocks block={{ before: null, after: { label: "Première version", text: `Rotation de ${plural(comparison.firstSlots.length, "séance")}` } }} />
      ) : null}
      {comparison.first
        ? comparison.firstSlots.map((line) => (
            <Text key={line} variant="small" tone="secondary" style={styles.slotLine}>
              {line}
            </Text>
          ))
        : null}
      {!comparison.first && comparison.changes.length === 0 ? (
        <Text variant="small" tone="secondary" style={styles.slotLine}>
          Contenu identique à la version précédente
        </Text>
      ) : null}
      {comparison.changes.map((change, index) => (
        <Blocks key={`${change.kind}-${index}`} block={describeChange(change, name)} />
      ))}
      {entry.version.reason === null ? null : <Reason reason={entry.version.reason} />}
      {notices.map((notice) => (
        <View key={notice.exerciseId} style={styles.notice}>
          <PainMark level={notice.pain.level} />
          <Text variant="small" tone="secondary" style={styles.noticeText}>
            Remet {lowerFirst(name(notice.exerciseId))} · {lowerFirst(zoneLabel(notice.pain.zone))} : {notice.pain.level === "stop" ? "arrêt" : "gêne"}{" "}
            {formatRelative(notice.pain.occurredAt, environment.now())}
          </Text>
        </View>
      ))}
    </View>
  );
}

interface BlocksProps {
  readonly block: DiffBlock;
}

function Blocks({ block }: BlocksProps) {
  const { colors, name } = useTheme();
  const background = name === "dark" ? colors.surface2 : colors.surface;
  return (
    <View style={styles.diff}>
      {block.before === null ? null : (
        <View style={[styles.side, { backgroundColor: background }]}>
          <Text variant="caption" tone="secondary">
            {block.before.label}
          </Text>
          <Text variant="bodyStrong" tone="secondary" style={styles.struck}>
            {block.before.text}
          </Text>
        </View>
      )}
      {block.after === null ? null : (
        <View style={[styles.side, { backgroundColor: background }]}>
          <Text variant="caption" tone="secondary">
            {block.after.label}
          </Text>
          <Text variant="bodyStrong" style={styles.after}>
            {block.after.text}
          </Text>
        </View>
      )}
    </View>
  );
}

interface ReasonProps {
  readonly reason: string;
}

function Reason({ reason }: ReasonProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.reason, { borderLeftColor: colors.controlBorder }]}>
      <Text tone="secondary" style={styles.reasonText}>
        <Text style={styles.reasonLabel}>Raison : </Text>
        {reason}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  diff: { marginTop: 14, gap: 2, borderRadius: radii.panel, overflow: "hidden" },
  side: { paddingVertical: 12, paddingHorizontal: 14, gap: 4 },
  struck: { textDecorationLine: "line-through" },
  after: { fontFamily: fonts.text700 },
  slotLine: { marginTop: 8 },
  reason: { marginTop: 14, paddingLeft: 12, borderLeftWidth: 2 },
  reasonText: { fontSize: 15, lineHeight: 22 },
  reasonLabel: { fontFamily: fonts.text600 },
  notice: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  noticeText: { flex: 1 },
});
