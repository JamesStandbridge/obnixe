import { useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { activityWeather, detailPrivacyMask, maskKey, measuredRecordingOf, NotMeasuredError, sessionEffortRanks, sessionSegmentEfforts, trackingAlgorithmVersion } from "@obnixe/core";
import type { ActivityWeather, EffortRank, PrivacyMask, SessionRecording, SessionSegmentEffort } from "@obnixe/core";
import { gear } from "@obnixe/schema";
import type { BestEffortKey, Gear, Id, MetricKey } from "@obnixe/schema";
import { eq } from "drizzle-orm";
import { db } from "@/data/database";
import { gearLabel } from "@/features/activity/presentation";
import { ActivityCharts } from "@/features/recordings/ActivityCharts";
import { ActivityMap } from "@/features/recordings/ActivityMap";
import { summaryFigures } from "@/features/recordings/format";
import { ClimbsSection, EffortsSection, EnergySection, LapsSection, QualitySection, SplitsSection, WeatherSection, ZonesSection } from "@/features/recordings/RecordingSections";
import { WorkoutStepsSection } from "@/features/recordings/WorkoutStepsSection";
import type { RecordedActivity, RecordedActivityState, TrackUnavailable } from "@/features/recordings/useRecordedActivity";
import { canDrawSegment } from "@/features/segments/SegmentSheet";
import { SegmentsSection } from "@/features/segments/SegmentsSection";
import { LinkButton } from "@/ui/Button";
import { Row, Section } from "@/ui/Layout";
import { BevelView } from "@/ui/Shapes";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, radii } from "@/ui/tokens";

/** What the detail of a recorded activity reads from the database, outside the track file. */
export interface RecordedData {
  readonly saved: SessionRecording;
  readonly mask: PrivacyMask | null;
  /** Changes with the session, the recording or the in-app mask: the track is measured again only then. */
  readonly revision: string;
  readonly ranks: ReadonlyMap<BestEffortKey, EffortRank>;
  readonly segments: readonly SessionSegmentEffort[];
  readonly gear: Gear | null;
  readonly weather: ActivityWeather;
}

export function loadRecorded(sessionId: Id): RecordedData | null {
  let saved: SessionRecording;
  try {
    saved = measuredRecordingOf(db(), sessionId);
  } catch (error) {
    if (error instanceof NotMeasuredError) return null;
    throw error;
  }
  const mask = detailPrivacyMask(db());
  const gearId = saved.session.gearId;
  return {
    saved,
    mask,
    revision: `${saved.session.updatedAt}|${saved.recording.updatedAt}|${mask === null ? "" : maskKey(mask)}`,
    ranks: sessionEffortRanks(db(), sessionId),
    segments: sessionSegmentEfforts(db(), sessionId),
    gear: gearId === null ? null : (db().select().from(gear).where(eq(gear.id, gearId)).get() ?? null),
    weather: activityWeather(db(), sessionId),
  };
}

/**
 * The parts of `SUM-001` after the summary, in order. Guided steps (`WKT-007`) belong to guided sessions.
 */
type LeadingSection = "map" | "summary" | "charts" | "splits" | "laps" | "climbs" | "efforts" | "segments" | "workout" | "zones" | "energy" | "weather" | "gear";

const leadingSections: readonly LeadingSection[] = ["map", "summary", "charts", "splits", "laps", "climbs", "efforts", "segments", "workout", "zones", "energy", "weather", "gear"];

function primaryKeys(activity: RecordedActivity): ReadonlySet<MetricKey> {
  return new Set<MetricKey>(["distance", "moving", activity.profile.primary === "pace" ? "pace_avg" : "speed_avg"]);
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function unavailableText(reason: TrackUnavailable): string {
  switch (reason) {
    case "missing":
      return "Le fichier de la trace est introuvable sur cet appareil : le résumé enregistré reste affiché.";
    case "damaged":
      return "Le fichier de la trace est illisible : le résumé enregistré reste affiché.";
    case "not_recordable":
      return "Ce sport n'enregistre pas de trace : change de sport pour la retrouver.";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

interface RecordedLeadingProps {
  readonly state: RecordedActivityState;
  readonly recorded: RecordedData;
  /** The stored summary, drawn while the track is read or when it cannot be. */
  readonly fallback: ReactNode;
  readonly rebuilding: boolean;
  readonly searchingSegments: boolean;
  readonly onRecompute: () => void;
  readonly onGear: () => void;
  readonly onCreateSegment: () => void;
}

export function RecordedLeading({ state, recorded, fallback, rebuilding, searchingSegments, onRecompute, onGear, onCreateSegment }: RecordedLeadingProps) {
  const { colors } = useTheme();
  switch (state.status) {
    case "loading":
      return (
        <>
          <View style={[styles.placeholder, { backgroundColor: colors.surface, borderColor: colors.line }]} accessibilityLabel="Lecture de la trace" />
          {fallback}
        </>
      );
    case "unavailable":
      return (
        <>
          <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.line }]}>
            <Text variant="bodyStrong">Trace indisponible</Text>
            <Text variant="small" tone="secondary">
              {unavailableText(state.reason)}
            </Text>
          </View>
          {fallback}
        </>
      );
    case "ready":
      return (
        <ActivityBody
          activity={state.activity}
          recorded={recorded}
          rebuilding={rebuilding}
          searchingSegments={searchingSegments}
          onRecompute={onRecompute}
          onGear={onGear}
          onCreateSegment={onCreateSegment}
        />
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

interface ActivityBodyProps {
  readonly activity: RecordedActivity;
  readonly recorded: RecordedData;
  readonly rebuilding: boolean;
  readonly searchingSegments: boolean;
  readonly onRecompute: () => void;
  readonly onGear: () => void;
  readonly onCreateSegment: () => void;
}

function ActivityBody({ activity, recorded, rebuilding, searchingSegments, onRecompute, onGear, onCreateSegment }: ActivityBodyProps) {
  const { colors } = useTheme();
  const [cursor, setCursor] = useState<number | null>(null);
  const { recording, session } = activity.saved;
  const figures = summaryFigures({ profile: activity.profile, summary: activity.processed.summary, details: activity.processed.details, energyKcal: recording.energyKcal });
  const primary = primaryKeys(activity);
  const lead: readonly StatValue[] = figures.filter((figure) => primary.has(figure.key));
  const rest = figures.filter((figure) => !primary.has(figure.key));

  const render = (section: LeadingSection): ReactNode => {
    switch (section) {
      case "map":
        return (
          <View key={section} style={styles.map}>
            {recording.algorithmVersion < trackingAlgorithmVersion ? (
              <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                <Text variant="small" tone="secondary">
                  Mesurée avec une ancienne version du calcul.
                </Text>
                <LinkButton label="Recalculer avec la dernière version" onPress={onRecompute} style={styles.noticeLink} />
              </View>
            ) : null}
            <ActivityMap activity={activity} cursor={cursor} onCursor={setCursor} />
            <LinkButton
              label="Carte hors ligne autour de l'activité"
              onPress={() => router.push({ pathname: "/settings/offline-region", params: { session: session.id } })}
              style={styles.offline}
            />
          </View>
        );
      case "summary":
        return (
          <BevelView key={section} fill={colors.surface} cut={bevels.tile} style={styles.stats}>
            <StatRow stats={lead} size="large" />
            {chunks(rest, 3).map((row) => (
              <StatRow key={row.map((figure) => figure.key).join()} stats={row} style={[styles.secondaryStats, { borderTopColor: colors.line }]} />
            ))}
          </BevelView>
        );
      case "charts":
        return (
          <Section key={section} title="Profil">
            <View style={styles.charts}>
              <ActivityCharts activity={activity} cursor={cursor} onCursor={setCursor} />
            </View>
          </Section>
        );
      case "splits":
        return <SplitsSection key={section} activity={activity} />;
      case "laps":
        return <LapsSection key={section} activity={activity} />;
      case "climbs":
        return <ClimbsSection key={section} activity={activity} />;
      case "efforts":
        return <EffortsSection key={section} activity={activity} ranks={recorded.ranks} rebuilding={rebuilding} />;
      case "zones":
        return <ZonesSection key={section} zones={activity.zones} />;
      case "energy":
        return <EnergySection key={section} recording={recording} />;
      case "gear":
        return (
          <Section key={section} title="Matériel">
            <Row title={gearLabel(session.sport)} detail={recorded.gear?.name ?? "Aucun"} trailing={<LinkButton label="Changer" onPress={onGear} style={styles.rowLink} />} last />
          </Section>
        );
      case "segments":
        return (
          <SegmentsSection
            key={section}
            efforts={recorded.segments}
            profile={activity.profile}
            searching={searchingSegments}
            onCreate={canDrawSegment(activity) ? onCreateSegment : null}
          />
        );
      case "workout":
        return <WorkoutStepsSection key={section} activity={activity} />;
      case "weather":
        return <WeatherSection key={section} weather={recorded.weather} session={session} />;
      default: {
        const unreachable: never = section;
        return unreachable;
      }
    }
  };

  return <>{leadingSections.map(render)}</>;
}

interface RecordedTrailingProps {
  readonly state: RecordedActivityState;
}

/** The data quality block, last of `SUM-001`, after the review. */
export function RecordedTrailing({ state }: RecordedTrailingProps) {
  return state.status === "ready" ? <QualitySection activity={state.activity} /> : null;
}

const styles = StyleSheet.create({
  placeholder: { height: 320, borderRadius: radii.panel, borderWidth: 1, marginTop: 8 },
  notice: { marginTop: 8, padding: 14, gap: 4, borderRadius: radii.panel, borderWidth: 1 },
  noticeLink: { alignSelf: "flex-start", marginLeft: -10, marginBottom: -8 },
  map: { marginTop: 8, gap: 8 },
  offline: { alignSelf: "flex-start", marginLeft: -10, marginTop: -4 },
  stats: { marginTop: 8, paddingHorizontal: 14, paddingVertical: 14 },
  secondaryStats: { marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  charts: { marginTop: 12 },
  rowLink: { marginRight: -10 },
});
