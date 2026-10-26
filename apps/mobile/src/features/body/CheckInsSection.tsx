import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import type { CheckIn, PainLevel, PainReport, SleepBucket, ZoneKey } from "@obnixe/schema";
import { formatCompactDay } from "@/features/activity/format";
import { zoneLabel } from "@/format/labels";
import { LinkButton } from "@/ui/Button";
import { PainMark } from "@/ui/Controls";
import { Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

interface CheckInsSectionProps {
  readonly checkIns: readonly CheckIn[];
  readonly pains: readonly PainReport[];
  readonly tracked: readonly ZoneKey[];
}

const sleepLabels: Readonly<Record<SleepBucket, string>> = { lt6: "< 6 h", h6: "6 h", h7: "7 h", h8: "8 h", gte9: "9 h +" };

const levelWords: Readonly<Record<PainLevel, string>> = { none: "calme", discomfort: "gêne", stop: "arrêt" };

const shown = 4;

function shortZone(zone: ZoneKey): string {
  return zoneLabel(zone).replace(/ droite?$/, " dr.").replace(/ gauche$/, " g.").replace(/^Doigts, main/, "Doigts");
}

export function CheckInsSection({ checkIns, pains, tracked }: CheckInsSectionProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const recent = [...checkIns].sort((left, right) => right.localDate.localeCompare(left.localDate)).slice(0, shown);
  const reportsFor = (checkIn: CheckIn): PainReport[] => pains.filter((pain) => pain.checkInId === checkIn.id && pain.deletedAt === null);
  const reported = recent.flatMap(reportsFor).filter((pain) => pain.level !== "none").map((pain) => pain.zone);
  const zones = [...tracked, ...reported].filter((zone, index, list) => list.indexOf(zone) === index).slice(0, 2);

  return (
    <Section title="Check-ins" action={<LinkButton label="Aujourd'hui" onPress={() => router.navigate("/")} style={styles.headLink} />}>
      {recent.length === 0 ? (
        <Text variant="small" tone="secondary" style={styles.empty}>
          Aucun check-in pour l'instant.
        </Text>
      ) : (
        <>
          <View style={[styles.row, { borderBottomColor: colors.line }]}>
            <Text style={[styles.cellDay, styles.header]} />
            <Text style={[styles.cellEnergy, styles.header]} tone="secondary">
              Énergie
            </Text>
            <Text style={[styles.cellSleep, styles.header]} tone="secondary">
              Sommeil
            </Text>
            {zones.map((zone) => (
              <Text key={zone} style={[styles.cellZone, styles.header]} tone="secondary" numberOfLines={1}>
                {shortZone(zone)}
              </Text>
            ))}
          </View>
          {recent.map((checkIn, index) => {
            const reports = reportsFor(checkIn);
            return (
              <View
                key={checkIn.id}
                style={[styles.row, { borderBottomColor: colors.line, borderBottomWidth: index === recent.length - 1 ? 0 : 1 }]}
                accessible
                accessibilityLabel={`${formatCompactDay(checkIn.localDate)}, énergie ${checkIn.energy ?? "non renseignée"}, sommeil ${checkIn.sleep === null ? "non renseigné" : sleepLabels[checkIn.sleep]}${zones
                  .map((zone) => {
                    const level = reports.find((report) => report.zone === zone)?.level;
                    return level === undefined ? "" : `, ${zoneLabel(zone)} ${levelWords[level]}`;
                  })
                  .join("")}`}
              >
                <Text style={styles.cellDay} tone="secondary">
                  {formatCompactDay(checkIn.localDate)}
                </Text>
                <Text style={[styles.cellEnergy, styles.figure]}>{checkIn.energy ?? "–"}</Text>
                <Text style={[styles.cellSleep, styles.figure]}>{checkIn.sleep === null ? "–" : sleepLabels[checkIn.sleep]}</Text>
                {zones.map((zone) => {
                  const level = reports.find((report) => report.zone === zone)?.level;
                  return (
                    <View key={zone} style={[styles.cellZone, styles.zoneCell]}>
                      {level === undefined || level === "none" ? null : <PainMark level={level} />}
                      <Text style={styles.figure}>{level === undefined ? "–" : levelWords[level]}</Text>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  headLink: { marginVertical: -12, marginRight: -10 },
  empty: { paddingVertical: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingVertical: 6, borderBottomWidth: 1 },
  header: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 14 },
  cellDay: { width: 58, fontFamily: fonts.text600, fontSize: 14, lineHeight: 16 },
  cellEnergy: { width: 50 },
  cellSleep: { width: 56 },
  cellZone: { flex: 1, minWidth: 0 },
  zoneCell: { flexDirection: "row", alignItems: "center", gap: 6 },
  figure: { fontFamily: fonts.figure600, fontSize: 15, lineHeight: 17 },
});
