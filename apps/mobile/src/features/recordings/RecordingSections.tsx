import { Linking, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { ActivityWeather, EffortRank, HeartRateZone, HeartRateZoneReport, SplitSummary } from "@obnixe/core";
import type { BestEffortKey, CadenceSource, ElevationSource, EnergyMethod, Recording, SensorSource, Session } from "@obnixe/schema";
import { climbText, descentText, distanceText, effortFigure, effortTitle, elapsedText, paceFigure, paceSeconds, rateFigure } from "@/features/recordings/format";
import { trackPalettes } from "@/features/recordings/palette";
import type { RecordedActivity } from "@/features/recordings/useRecordedActivity";
import { weatherText } from "@/features/recordings/weatherText";
import { formatInteger, formatNumber } from "@/format/numbers";
import { LinkButton } from "@/ui/Button";
import { Tag } from "@/ui/Controls";
import { Row, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, wash } from "@/ui/tokens";

interface ActivityProps {
  readonly activity: RecordedActivity;
}

/** A last split shorter than half the split length does not compete for the fastest one. */
function fastestSplit(splits: readonly SplitSummary[], splitMeters: number): number | null {
  let best: number | null = null;
  let bestSpeed = 0;
  for (const split of splits) {
    if (split.movingMs <= 0 || (splits.length > 1 && split.distanceMm < splitMeters * 500)) continue;
    const speed = split.distanceMm / split.movingMs;
    if (speed > bestSpeed) {
      bestSpeed = speed;
      best = split.index;
    }
  }
  return best;
}

function elevationText(ascentMm: number | null, descentMm: number | null): string {
  if (ascentMm === null || descentMm === null) return "–";
  return `+${formatInteger(ascentMm / 1000)} −${formatInteger(descentMm / 1000)}`;
}

/** `SUM-003`: number, pace or speed with a proportional bar, D+ and D−, and the GAP of the sports that have it. */
export function SplitsSection({ activity }: ActivityProps) {
  const { colors } = useTheme();
  const { processed, profile } = activity;
  const splitMeters = profile.splitMeters;
  if (splitMeters === null || processed.splits.length < 2) return null;
  const fastest = fastestSplit(processed.splits, splitMeters);
  const speeds = processed.splits.map((split) => (split.movingMs <= 0 ? 0 : split.distanceMm / split.movingMs));
  const top = Math.max(...speeds, 0.001);
  const gap = profile.gradeAdjustedPace;
  const unit = splitMeters >= 1000 ? `${formatNumber(splitMeters / 1000, 1)} km` : `${formatInteger(splitMeters)} m`;
  return (
    <Section title="Splits">
      <View style={[styles.splitHead, { borderBottomColor: colors.line }]}>
        <Text variant="caption" tone="tertiary" style={styles.splitIndex}>
          {unit}
        </Text>
        <Text variant="caption" tone="tertiary" style={styles.splitRate}>
          {profile.primary === "pace" ? "Allure" : "Vitesse"}
        </Text>
        <View style={styles.splitBar} />
        <Text variant="caption" tone="tertiary" style={styles.splitElevation}>
          D+ D−
        </Text>
        {gap ? (
          <Text variant="caption" tone="tertiary" style={styles.splitGap}>
            GAP
          </Text>
        ) : null}
      </View>
      {processed.splits.map((split, position) => {
        const isFastest = split.index === fastest;
        const rate = rateFigure(profile, split.distanceMm, split.movingMs);
        const partial = split.distanceMm < splitMeters * 990;
        const gapSeconds = split.gradeAdjustedDistanceMm === null ? null : paceSeconds(split.gradeAdjustedDistanceMm, split.movingMs, profile.pacePerMeters);
        return (
          <View
            key={split.index}
            style={[styles.splitRow, { borderBottomColor: colors.line, borderBottomWidth: position === processed.splits.length - 1 ? 0 : 1 }]}
            accessible
            accessibilityLabel={`Split ${split.index + 1}${isFastest ? ", le plus rapide" : ""} : ${rate === null ? "" : `${rate.value} ${rate.unit}`}`}
          >
            <Text style={[styles.splitIndex, styles.splitFigure, { color: colors.text2 }]}>{partial ? distanceText(split.distanceMm).value : String(split.index + 1)}</Text>
            <Text style={[styles.splitRate, styles.splitFigure, isFastest && { color: colors.mark }]}>{rate === null ? "–" : rate.value}</Text>
            <View style={styles.splitBar}>
              <View style={[styles.splitFill, { width: `${Math.max(4, ((speeds[position] ?? 0) / top) * 100)}%`, backgroundColor: isFastest ? colors.mark : wash(colors.sport[activity.saved.session.sport], 0.55) }]} />
            </View>
            <Text style={[styles.splitElevation, styles.splitSmall, { color: colors.text2 }]}>{elevationText(split.ascentMm, split.descentMm)}</Text>
            {gap ? <Text style={[styles.splitGap, styles.splitSmall, { color: colors.text2 }]}>{gapSeconds === null ? "–" : paceFigure(gapSeconds, profile.pacePerMeters).value}</Text> : null}
          </View>
        );
      })}
    </Section>
  );
}

/** Laps when there are more than one (`SUM-001`); the steps of a guided workout show in their own table (`WKT-007`). */
export function LapsSection({ activity }: ActivityProps) {
  const { processed, profile } = activity;
  if (processed.laps.length < 2 || activity.saved.recording.workout !== null) return null;
  return (
    <Section title="Tours">
      {processed.laps.map((lap, index) => {
        const rate = rateFigure(profile, lap.distanceMm, lap.movingMs);
        const distance = distanceText(lap.distanceMm);
        return (
          <Row
            key={lap.bounds.startOffsetMs}
            title={`Tour ${index + 1}`}
            detail={`${distance.value} ${distance.unit}${lap.heartRateAvg === null ? "" : ` · ${formatInteger(lap.heartRateAvg)} bpm`}`}
            value={elapsedText(lap.elapsedMs)}
            {...(rate === null ? {} : { valueDetail: `${rate.value} ${rate.unit}` })}
            last={index === processed.laps.length - 1}
          />
        );
      })}
    </Section>
  );
}

/** `GPS-062`: the climbs of the sports that detect them, in track order. */
export function ClimbsSection({ activity }: ActivityProps) {
  const climbs = activity.processed.climbs;
  if (climbs.length === 0) return null;
  return (
    <Section title="Montées">
      {climbs.map((climb, index) => {
        const text = climbText(climb);
        return <Row key={climb.startDistanceMm} title={`Montée ${index + 1}`} detail={text.detail} value={text.ascent} valueDetail={text.effort} last={index === climbs.length - 1} />;
      })}
    </Section>
  );
}

/** The descents of the snow sports that detect them (`runs`), in track order. */
export function DescentsSection({ activity }: ActivityProps) {
  const descents = activity.processed.descents;
  if (descents.length === 0) return null;
  return (
    <Section title="Descentes">
      {descents.map((descent, index) => {
        const text = descentText(descent);
        return <Row key={descent.startDistanceMm} title={`Descente ${index + 1}`} detail={text.detail} value={text.descent} valueDetail={text.effort} last={index === descents.length - 1} />;
      })}
    </Section>
  );
}

function rankLabel(rank: EffortRank): string | null {
  if (rank.rank === 1) return "Record";
  if (rank.standing === "former") return "Ancien record";
  if (rank.rank <= 3) return `${rank.rank}e`;
  return null;
}

interface EffortsSectionProps extends ActivityProps {
  readonly ranks: ReadonlyMap<BestEffortKey, EffortRank>;
  /** While the derived rows catch up, the badges are not final (`DAT-012`). */
  readonly rebuilding: boolean;
}

/** The activity's best efforts with their record badges (`SUM-001`, `PR-003`). */
export function EffortsSection({ activity, ranks, rebuilding }: EffortsSectionProps) {
  const efforts = activity.processed.bestEfforts;
  if (efforts.length === 0) return null;
  const counted = ranks.size > 0;
  return (
    <Section title="Meilleurs efforts" action={<LinkButton label="Records" onPress={() => router.push({ pathname: "/records", params: { sport: activity.saved.session.sport } })} style={styles.sectionLink} />}>
      {counted || rebuilding ? null : (
        <Text variant="small" tone="secondary" style={styles.note}>
          Cette activité ne compte pas dans les records.
        </Text>
      )}
      {efforts.map((effort, index) => {
        const figure = effortFigure(effort);
        const rank = ranks.get(effort.effort);
        const badge = rank === undefined ? null : rankLabel(rank);
        return (
          <Row
            key={effort.effort}
            title={effortTitle(effort.effort)}
            detail={`à ${elapsedText(effort.startOffsetMs)} du départ`}
            value={`${figure.value}${figure.unit === "" ? "" : ` ${figure.unit}`}`}
            trailing={badge === null ? undefined : <Tag label={badge} />}
            last={index === efforts.length - 1}
          />
        );
      })}
    </Section>
  );
}

const zoneNames: Readonly<Record<HeartRateZone, string>> = { 1: "Récupération", 2: "Endurance", 3: "Tempo", 4: "Seuil", 5: "Maximum" };

interface ZonesSectionProps {
  readonly zones: HeartRateZoneReport | null;
}

/** Moving time per heart-rate zone (`CAL-004`). */
export function ZonesSection({ zones }: ZonesSectionProps) {
  const { colors, name } = useTheme();
  if (zones === null || zones.time.coveredMs <= 0) return null;
  const palette = trackPalettes[name].zones;
  const total = zones.time.coveredMs;
  return (
    <Section title="Zones cardiaques">
      <Text variant="small" tone="secondary" style={styles.note}>
        FC max {formatInteger(zones.maxHeartRate)} bpm · {zones.source === "settings" ? "réglée dans les paramètres" : "estimée d'après l'âge"}
      </Text>
      {zones.zones.map((zone) => {
        const ms = zones.time.byZone[zone.zone];
        const share = ms / total;
        return (
          <View key={zone.zone} style={styles.zoneRow} accessible accessibilityLabel={`Zone ${zone.zone}, ${zoneNames[zone.zone]} : ${elapsedText(ms)}`}>
            <Text style={[styles.zoneName, { color: colors.text2 }]}>{`Z${zone.zone}`}</Text>
            <View style={styles.zoneMain}>
              <View style={styles.zoneLabels}>
                <Text variant="small">{zoneNames[zone.zone]}</Text>
                <Text variant="caption" tone="tertiary">{`${formatInteger(zone.minBpm)}–${formatInteger(zone.maxBpm)} bpm`}</Text>
              </View>
              <View style={[styles.zoneTrack, { backgroundColor: colors.surface2 }]}>
                <View style={[styles.zoneFill, { width: `${Math.max(share * 100, ms > 0 ? 2 : 0)}%`, backgroundColor: palette[zone.zone - 1] }]} />
              </View>
            </View>
            <View style={styles.zoneValue}>
              <Text style={styles.zoneTime}>{elapsedText(ms)}</Text>
              <Text variant="caption" tone="tertiary">{`${formatInteger(share * 100)} %`}</Text>
            </View>
          </View>
        );
      })}
    </Section>
  );
}

function energyMethodText(method: EnergyMethod): string {
  switch (method) {
    case "power":
      return "d'après la puissance mesurée";
    case "heart_rate":
      return "d'après la fréquence cardiaque";
    case "mechanical":
      return "d'après la vitesse et la pente";
    case "met":
      return "d'après l'intensité moyenne du sport";
    default: {
      const unreachable: never = method;
      return unreachable;
    }
  }
}

interface EnergySectionProps {
  readonly recording: Pick<Recording, "energyKcal" | "energyMethod" | "importedEnergyKcal">;
}

/** `CAL-001`: always presented as an estimate, with its method; the file's value shown aside for an import. */
export function EnergySection({ recording }: EnergySectionProps) {
  if (recording.energyKcal === null || recording.energyMethod === null) {
    return (
      <Section title="Énergie">
        <Text variant="small" tone="secondary" style={styles.note}>
          Pas d'estimation : ajoute une pesée avant la date de l'activité pour l'obtenir.
        </Text>
      </Section>
    );
  }
  return (
    <Section title="Énergie">
      <Row title="Estimation" detail={energyMethodText(recording.energyMethod)} value={`${formatInteger(recording.energyKcal)} kcal`} last={recording.importedEnergyKcal === null} />
      {recording.importedEnergyKcal === null ? null : <Row title="Selon le fichier importé" value={`${formatInteger(recording.importedEnergyKcal)} kcal`} last />}
    </Section>
  );
}

const openMeteoUrl = "https://open-meteo.com/";

interface WeatherSectionProps {
  readonly weather: ActivityWeather;
  readonly session: Pick<Session, "startedAt" | "endedAt">;
}

/** `WTH-002`: the activity's weather in one line, credited to Open-Meteo as its CC BY licence asks. */
export function WeatherSection({ weather, session }: WeatherSectionProps) {
  switch (weather.status) {
    case "none":
      return null;
    case "pending":
      return (
        <Section title="Météo">
          <Text variant="small" tone="secondary" style={styles.note}>
            Demandée à Open-Meteo dès que le téléphone a du réseau.
          </Text>
        </Section>
      );
    case "unavailable":
      return (
        <Section title="Météo">
          <Text variant="small" tone="secondary" style={styles.note}>
            Indisponible pour cette activité.
          </Text>
        </Section>
      );
    case "stored": {
      const text = weatherText(weather.weather, session.startedAt, session.endedAt ?? session.startedAt);
      return (
        <Section title="Météo">
          <View style={styles.weather}>
            <Text variant="bodyStrong">{text.headline}</Text>
            <Text variant="small" tone="secondary">
              {text.details}
            </Text>
            <Text
              variant="caption"
              tone="tertiary"
              accessibilityRole="link"
              onPress={() => {
                Linking.openURL(openMeteoUrl).catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
              }}
              style={styles.attribution}
            >
              Météo : Open-Meteo.com
            </Text>
          </View>
        </Section>
      );
    }
    default: {
      const unreachable: never = weather;
      return unreachable;
    }
  }
}

function elevationSourceText(source: ElevationSource): string {
  switch (source) {
    case "barometer":
      return "Baromètre";
    case "gnss":
      return "GPS";
    case "file":
      return "Fichier importé";
    case "dem":
      return "Modèle numérique de terrain";
    case "none":
      return "Aucune";
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}

function sensorText(source: SensorSource | CadenceSource): string {
  switch (source) {
    case "sensor":
      return "Capteur";
    case "pedometer":
      return "Podomètre";
    case "file":
      return "Fichier importé";
    case "none":
      return "Aucune";
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}

/** Sources, share of the moving time within 10 m, gaps and rejected fixes (`SUM-001`, `GPS-0xx`). */
export function QualitySection({ activity }: ActivityProps) {
  const { processed, saved } = activity;
  const { summary, details } = processed;
  const gaps = processed.intervals.filter((interval) => interval.kind === "gap");
  const gapMs = gaps.reduce((total, interval) => total + interval.endMs - interval.startMs, 0);
  const rejected = details.gateRejections + details.outlierRejections;
  const rows: { readonly title: string; readonly value: string; readonly detail?: string }[] = [
    { title: "Précision ≤ 10 m", value: `${formatInteger(details.preciseFixPermille / 10)} %`, detail: "du temps en mouvement" },
    { title: "Trous de signal", value: gaps.length === 0 ? "Aucun" : elapsedText(gapMs), ...(gaps.length === 0 ? {} : { detail: `${formatInteger(gaps.length)} interruption${gaps.length > 1 ? "s" : ""}` }) },
    { title: "Points écartés", value: formatInteger(rejected), detail: `sur ${formatInteger(summary.pointCount)} enregistrés` },
    { title: "Altitude", value: elevationSourceText(summary.elevationSource) },
    { title: "Cadence", value: sensorText(summary.cadenceSource), ...(summary.cadenceSource !== "sensor" || saved.recording.cadenceDevice === null ? {} : { detail: saved.recording.cadenceDevice }) },
    { title: "Fréquence cardiaque", value: sensorText(summary.heartRateSource), ...(saved.recording.heartRateDevice === null ? {} : { detail: saved.recording.heartRateDevice }) },
    ...(summary.powerAvg === null && saved.recording.powerDevice === null
      ? []
      : [{ title: "Puissance", value: sensorText(saved.recording.source === "live" ? "sensor" : "file"), ...(saved.recording.powerDevice === null ? {} : { detail: saved.recording.powerDevice }) }]),
  ];
  if (summary.simulated) rows.unshift({ title: "Activité simulée", value: "Hors records" });
  return (
    <Section title="Qualité des données">
      {rows.map((row, index) => (
        <Row key={row.title} title={row.title} {...(row.detail === undefined ? {} : { detail: row.detail })} value={row.value} last={index === rows.length - 1} />
      ))}
    </Section>
  );
}

const styles = StyleSheet.create({
  sectionLink: { marginVertical: -12, marginRight: -10 },
  note: { marginTop: 8, marginBottom: 4 },
  weather: { marginTop: 10, gap: 4 },
  attribution: { marginTop: 4, alignSelf: "flex-start" },
  splitHead: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 12, paddingBottom: 6, borderBottomWidth: 1 },
  splitRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40 },
  splitIndex: { width: 34 },
  splitRate: { width: 56 },
  splitBar: { flex: 1, height: 10, justifyContent: "center" },
  splitFill: { height: 10, borderRadius: 3 },
  splitElevation: { width: 64, textAlign: "right" },
  splitGap: { width: 46, textAlign: "right" },
  splitFigure: { fontFamily: fonts.figure700, fontSize: 16 },
  splitSmall: { fontFamily: fonts.figure600, fontSize: 13 },
  zoneRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  zoneName: { width: 24, fontFamily: fonts.figure700, fontSize: 15 },
  zoneMain: { flex: 1, gap: 5 },
  zoneLabels: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  zoneTrack: { height: 8, borderRadius: 4, overflow: "hidden" },
  zoneFill: { height: 8, borderRadius: 4 },
  zoneValue: { width: 62, alignItems: "flex-end" },
  zoneTime: { fontFamily: fonts.figure700, fontSize: 15 },
});
