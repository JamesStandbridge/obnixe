import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { router } from "expo-router";
import { activityRecords, dateParts, effortBoards, effortScore } from "@obnixe/core";
import type { ActivityRecord, ActivityRecordKind, EffortBoard, EffortEntry } from "@obnixe/core";
import { sportKeys, sports } from "@obnixe/schema";
import type { Id, LocalDate, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { BackButton } from "@/features/data/parts";
import { distanceText, effortFigure, effortName, elapsedText, speedFigure } from "@/features/recordings/format";
import { useLiveValue, useLocalNow } from "@/features/stats/live";
import { FilterChips } from "@/features/stats/parts";
import type { ChipOption } from "@/features/stats/parts";
import { useDerivedRebuildState } from "@/features/tracking/recorder";
import { shortDate } from "@/format/dates";
import { formatInteger } from "@/format/numbers";
import { Icon } from "@/ui/icons/Icon";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { BevelView } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, fonts, radii } from "@/ui/tokens";

const recordSports: readonly SportKey[] = sportKeys.filter((key) => sports[key].recording !== null);

function dateText(date: LocalDate): string {
  return `${shortDate(date)} ${dateParts(date).year}`;
}

function openSession(sessionId: Id): void {
  router.push({ pathname: "/session/[id]", params: { id: sessionId } });
}

function entryValue(entry: EffortEntry): string {
  const figure = effortFigure(entry);
  return `${figure.value}${figure.unit === "" ? "" : ` ${figure.unit}`}`;
}

function activityRecordLabel(kind: ActivityRecordKind): string {
  switch (kind) {
    case "distance":
      return "Plus longue distance";
    case "moving":
      return "Plus long temps en mouvement";
    case "ascent":
      return "Plus gros D+";
    case "altitude":
      return "Plus haute altitude";
    case "speed":
      return "Vitesse moyenne sur 20 km et plus";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function activityRecordValue(record: ActivityRecord): string {
  switch (record.kind) {
    case "distance": {
      const figure = distanceText(record.value);
      return `${figure.value} ${figure.unit}`;
    }
    case "moving":
      return elapsedText(record.value);
    case "ascent":
    case "altitude":
      return `${formatInteger(record.value / 1000)} m`;
    case "speed": {
      const figure = speedFigure(record.value / 1000);
      return `${figure.value} ${figure.unit}`;
    }
    default: {
      const unreachable: never = record.kind;
      return unreachable;
    }
  }
}

interface RecordsData {
  readonly boards: readonly EffortBoard[];
  readonly records: readonly ActivityRecord[];
}

interface RecordsScreenProps {
  readonly initialSport: SportKey | null;
}

/** `PR-005`: best efforts and activity records per sport, read from the derived rows (`PR-003`). */
export function RecordsScreen({ initialSport }: RecordsScreenProps) {
  const { today } = useLocalNow();
  const year = dateParts(today).year;
  const rebuild = useDerivedRebuildState();
  const [sport, setSport] = useState<SportKey>(initialSport !== null && recordSports.includes(initialSport) ? initialSport : (recordSports[0] ?? "run"));
  const data = useLiveValue<RecordsData>(() => ({ boards: effortBoards(db(), sport, year), records: activityRecords(db(), sport) }), ["best_effort", "session", "recording"], [sport, year]);
  const options: readonly ChipOption<SportKey>[] = recordSports.map((key) => ({ value: key, label: sports[key].label, sport: key }));

  return (
    <Screen>
      <AppBar title="Records" leading={<BackButton />} />
      <FilterChips label="Sport" options={options} value={sport} onChange={setSport} />
      {rebuild.running ? (
        <Text variant="small" tone="secondary" style={styles.rebuilding} accessibilityLiveRegion="polite">
          Calcul des records…
        </Text>
      ) : null}
      <Section title="Meilleurs efforts">
        {data.boards.length === 0 ? (
          <Text tone="secondary" style={styles.empty}>
            Enregistre une activité avec le GPS pour obtenir tes meilleurs efforts.
          </Text>
        ) : (
          <View style={styles.boards}>
            {data.boards.map((board) => (
              <BoardCard key={board.effort} board={board} year={year} />
            ))}
          </View>
        )}
      </Section>
      <Section title="Records d'activité">
        {data.records.length === 0 ? (
          <Text tone="secondary" style={styles.empty}>
            Aucune activité terminée pour ce sport.
          </Text>
        ) : (
          data.records.map((record, index) => (
            <Row
              key={record.kind}
              title={activityRecordLabel(record.kind)}
              detail={`${record.title ?? sports[sport].label} · ${dateText(record.localDate)}`}
              value={activityRecordValue(record)}
              onPress={() => openSession(record.sessionId)}
              last={index === data.records.length - 1}
            />
          ))
        )}
      </Section>
    </Screen>
  );
}

interface BoardCardProps {
  readonly board: EffortBoard;
  readonly year: number;
}

function BoardCard({ board, year }: BoardCardProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const best = board.podium[0];
  if (best === undefined) return null;
  return (
    <BevelView fill={colors.surface} cut={bevels.tile} style={styles.card}>
      <Pressable accessibilityRole="button" aria-expanded={open} onPress={() => setOpen(!open)} style={styles.cardHead}>
        <View style={styles.cardTitle}>
          <Text variant="eyebrow" tone="secondary">
            {effortName(board.effort)}
          </Text>
          <Text style={styles.best}>{entryValue(best)}</Text>
          <Text variant="small" tone="secondary">
            {dateText(best.localDate)} · {board.count} {board.count > 1 ? "efforts" : "effort"}
          </Text>
        </View>
        <Icon name={open ? "collapse" : "expand"} color={colors.text2} />
      </Pressable>
      {board.yearBest !== null && board.yearBest.sessionId !== best.sessionId ? (
        <Row title={`Meilleur de ${year}`} detail={dateText(board.yearBest.localDate)} value={entryValue(board.yearBest)} onPress={() => board.yearBest !== null && openSession(board.yearBest.sessionId)} last={!open} />
      ) : null}
      {open ? (
        <>
          {board.podium.map((entry, index) => (
            <Row
              key={`${entry.sessionId}${entry.effort}`}
              leading={<Text style={[styles.rank, { color: index === 0 ? colors.mark : colors.text2 }]}>{index + 1}</Text>}
              title={entry.title ?? effortName(entry.effort)}
              detail={dateText(entry.localDate)}
              value={entryValue(entry)}
              onPress={() => openSession(entry.sessionId)}
              last={index === board.podium.length - 1 && board.progression.length < 2}
            />
          ))}
          {board.progression.length < 2 ? null : <Progression entries={board.progression} />}
        </>
      ) : null}
    </BevelView>
  );
}

const progressionHeight = 84;

interface ProgressionProps {
  readonly entries: readonly EffortEntry[];
}

/** Each record in the order it was set: a step line over time, better upwards. */
function Progression({ entries }: ProgressionProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const first = entries[0];
  const last = entries[entries.length - 1];
  const scores = entries.map(effortScore);
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  const x = (entry: EffortEntry): number => (first === undefined || last === undefined || last.startedAt === first.startedAt ? width / 2 : 8 + ((entry.startedAt - first.startedAt) / (last.startedAt - first.startedAt)) * (width - 16));
  const y = (score: number): number => (high === low ? progressionHeight / 2 : progressionHeight - 10 - ((score - low) / (high - low)) * (progressionHeight - 20));
  const path = entries
    .map((entry, index) => {
      const px = x(entry).toFixed(1);
      const py = y(scores[index] ?? 0).toFixed(1);
      return index === 0 ? `M${px},${py}` : `H${px}V${py}`;
    })
    .join("");
  return (
    <View style={styles.progression} onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)} accessibilityLabel={`Progression : ${entries.map(entryValue).join(", ")}`}>
      <Text variant="caption" tone="secondary">
        Progression
      </Text>
      {width === 0 ? null : (
        <Svg width={width} height={progressionHeight}>
          <Path d={path} fill="none" stroke={colors.mark} strokeWidth={2} strokeLinejoin="round" />
          {entries.map((entry, index) => (
            <Circle key={entry.sessionId} cx={x(entry)} cy={y(scores[index] ?? 0)} r={3.5} fill={colors.bg} stroke={colors.mark} strokeWidth={2} />
          ))}
        </Svg>
      )}
      <View style={styles.progressionDates}>
        <Text variant="caption" tone="tertiary">
          {first === undefined ? "" : dateText(first.localDate)}
        </Text>
        <Text variant="caption" tone="tertiary">
          {last === undefined ? "" : dateText(last.localDate)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rebuilding: { marginTop: 12 },
  empty: { marginTop: 10 },
  boards: { marginTop: 12, gap: 10 },
  card: { paddingHorizontal: 14, paddingVertical: 12 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardTitle: { flex: 1, gap: 2 },
  best: { fontFamily: fonts.figure800, fontSize: 30, lineHeight: 34, letterSpacing: -0.3 },
  rank: { width: 22, fontFamily: fonts.figure700, fontSize: 17 },
  progression: { marginTop: 10, gap: 4, borderRadius: radii.control },
  progressionDates: { flexDirection: "row", justifyContent: "space-between" },
});
