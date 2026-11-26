import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { CodedError } from "expo";
import { exportFormats, TrackDecodeError } from "@obnixe/core";
import type { ExportFormat } from "@obnixe/core";
import { recording } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import { db } from "@/data/database";
import { activityFile, TrackUnavailableError } from "@/features/activityFiles/exportActivity";
import { useExportPrivacy } from "@/features/activityFiles/exportPrivacy";
import { shareFile } from "@/features/data/files";
import { Chevron, SwitchRow } from "@/features/data/parts";
import { PrimaryButton } from "@/ui/Button";
import { Row } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";

interface ExportTrackActionsProps {
  readonly sessionId: Id;
}

interface FormatTexts {
  readonly title: string;
  readonly detail: string;
  readonly share: string;
}

const formatTexts: Readonly<Record<ExportFormat, FormatTexts>> = {
  gpx: { title: "Exporter en GPX", detail: "Strava, Garmin Connect, Komoot", share: "Partager le fichier GPX" },
  fit: { title: "Exporter en FIT", detail: "Garmin Connect, TrainingPeaks, intervals.icu", share: "Partager le fichier FIT" },
  tcx: { title: "Exporter en TCX", detail: "Tours, cardio et cadence pour les anciens logiciels", share: "Partager le fichier TCX" },
};

/**
 * « Exporter en GPX », « en FIT » and « en TCX » of an activity with a track (`IO-001`, `IO-003`, `IO-004`): the share sheet, or
 * a download on the web. The full track box is asked again at each export, unchecked while the zones apply to exports
 * (`PRV-011`). Renders nothing for a session without a track.
 */
export function ExportTrackActions({ sessionId }: ExportTrackActionsProps) {
  const notify = useSnackbar();
  const { data: tracks } = useLiveQuery(db().select({ file: recording.trackFile }).from(recording).where(eq(recording.sessionId, sessionId)), [sessionId]);
  const privacy = useExportPrivacy();
  const [format, setFormat] = useState<ExportFormat>("gpx");
  const [open, setOpen] = useState(false);
  const [includeFullTrack, setIncludeFullTrack] = useState(false);
  const [sharing, setSharing] = useState(false);
  if ((tracks[0]?.file ?? null) === null || privacy === null) return null;

  const show = (shown: ExportFormat): void => {
    setFormat(shown);
    setIncludeFullTrack(privacy.includeFullTrack);
    setOpen(true);
  };

  const share = async (): Promise<void> => {
    setSharing(true);
    try {
      const exported = await activityFile(sessionId, format, includeFullTrack || !privacy.masks);
      setOpen(false);
      await shareFile({ name: exported.name, bytes: exported.bytes, mimeType: exported.mimeType });
    } catch (error) {
      if (error instanceof TrackUnavailableError || error instanceof TrackDecodeError) notify({ text: "Trace indisponible" });
      else if (error instanceof CodedError) notify({ text: "Partage impossible" });
      else throw error;
    } finally {
      setSharing(false);
    }
  };

  const texts = formatTexts[format];
  return (
    <>
      {exportFormats.map((shown, index) => (
        <Row key={shown} title={formatTexts[shown].title} detail={formatTexts[shown].detail} trailing={<Chevron />} onPress={() => show(shown)} last={index === exportFormats.length - 1} />
      ))}
      <Sheet open={open} title={texts.title} context="Les points gardés après le rejet des aberrations, sans lissage, rognage compris" onClose={() => setOpen(false)}>
        <View style={styles.body}>
          {privacy.masks ? (
            <SwitchRow title="Inclure la trace complète" detail={privacy.detail} value={includeFullTrack} onChange={setIncludeFullTrack} />
          ) : (
            <Text variant="small" tone="secondary">
              Aucune zone de confidentialité : la trace est exportée en entier.
            </Text>
          )}
          <PrimaryButton label={sharing ? "Préparation du fichier" : texts.share} disabled={sharing} onPress={() => void share()} />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingTop: 8 },
});
