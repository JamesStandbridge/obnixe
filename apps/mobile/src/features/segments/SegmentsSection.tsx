import { StyleSheet } from "react-native";
import { router } from "expo-router";
import type { ResolvedProfile, SessionSegmentEffort } from "@obnixe/core";
import { elapsedText, rateFigure } from "@/features/recordings/format";
import { segmentMeasureText, segmentRankLabel } from "@/features/segments/format";
import { LinkButton } from "@/ui/Button";
import { Tag } from "@/ui/Controls";
import { Row, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";

interface SegmentsSectionProps {
  readonly efforts: readonly SessionSegmentEffort[];
  readonly profile: Pick<ResolvedProfile, "primary" | "pacePerMeters">;
  /** While segments are searched over the history, the passes and ranks are not final (`SEG-003`). */
  readonly searching: boolean;
  /** `null` when no segment can be drawn from this activity. */
  readonly onCreate: (() => void) | null;
}

/** The activity's passes over the segments, in track order, each with its place on the segment (`SEG-003`). */
export function SegmentsSection({ efforts, profile, searching, onCreate }: SegmentsSectionProps) {
  if (efforts.length === 0 && onCreate === null) return null;
  return (
    <Section title="Segments" action={onCreate === null ? undefined : <LinkButton label="Créer" onPress={onCreate} style={styles.sectionLink} />}>
      {searching ? (
        <Text variant="small" tone="secondary" style={styles.note}>
          Recherche des passages…
        </Text>
      ) : null}
      {efforts.length === 0 && !searching ? (
        <Text variant="small" tone="secondary" style={styles.note}>
          Aucun segment sur ce parcours. Crée-en un à partir d'une portion de l'activité.
        </Text>
      ) : null}
      {efforts.map((effort, index) => {
        const rate = rateFigure(profile, effort.segment.distanceMm, effort.elapsedMs);
        const badge = segmentRankLabel(effort.rank, effort.count);
        return (
          <Row
            key={`${effort.segment.id}:${effort.occurrence}`}
            title={effort.segment.name}
            detail={`${segmentMeasureText(effort.segment)} · à ${elapsedText(effort.startOffsetMs)} du départ`}
            value={elapsedText(effort.elapsedMs)}
            {...(rate === null ? {} : { valueDetail: `${rate.value} ${rate.unit}` })}
            trailing={badge === null ? undefined : <Tag label={badge} />}
            onPress={() => router.push({ pathname: "/segment/[id]", params: { id: effort.segment.id } })}
            last={index === efforts.length - 1}
          />
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  sectionLink: { marginVertical: -12, marginRight: -10 },
  note: { marginTop: 8, marginBottom: 4 },
});
