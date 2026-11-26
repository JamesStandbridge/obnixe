import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { eq, isNull } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { CodedError } from "expo";
import { TrackDecodeError } from "@obnixe/core";
import { privacyZone, recording, settings } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import { db } from "@/data/database";
import { activityGpx, gpxMimeType, TrackUnavailableError } from "@/features/activityFiles/exportActivity";
import { shareFile } from "@/features/data/files";
import { Chevron, SwitchRow } from "@/features/data/parts";
import { plural } from "@/format/labels";
import { formatInteger } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { Row } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";

interface ExportGpxActionProps {
  readonly sessionId: Id;
  readonly last?: boolean;
}

function maskDetail(zones: number, hideEndsMeters: number): string {
  const parts = [...(zones === 0 ? [] : [plural(zones, "zone de confidentialité", "zones de confidentialité")]), ...(hideEndsMeters === 0 ? [] : [`${formatInteger(hideEndsMeters)} m au début et à la fin`])];
  return `Sinon masqués : ${parts.join(", ")}`;
}

/**
 * « Exporter en GPX » of an activity with a track (`IO-001`, `IO-004`): the share sheet, or a download on the web. The full
 * track box is asked again at each export, unchecked while the zones apply to exports (`PRV-011`). Renders nothing for a
 * session without a track.
 */
export function ExportGpxAction({ sessionId, last = false }: ExportGpxActionProps) {
  const notify = useSnackbar();
  const { data: tracks } = useLiveQuery(db().select({ file: recording.trackFile }).from(recording).where(eq(recording.sessionId, sessionId)), [sessionId]);
  const { data: settingsRows } = useLiveQuery(db().select({ exportPrivacy: settings.exportPrivacy, hideTrackEndsMeters: settings.hideTrackEndsMeters }).from(settings));
  const { data: zones } = useLiveQuery(db().select({ id: privacyZone.id }).from(privacyZone).where(isNull(privacyZone.deletedAt)));
  const [open, setOpen] = useState(false);
  const [includeFullTrack, setIncludeFullTrack] = useState(false);
  const [sharing, setSharing] = useState(false);
  const current = settingsRows[0];
  if ((tracks[0]?.file ?? null) === null || current === undefined) return null;
  const masks = zones.length > 0 || current.hideTrackEndsMeters > 0;

  const show = (): void => {
    setIncludeFullTrack(!current.exportPrivacy);
    setOpen(true);
  };

  const share = async (): Promise<void> => {
    setSharing(true);
    try {
      const gpx = await activityGpx(sessionId, includeFullTrack || !masks);
      setOpen(false);
      await shareFile({ name: gpx.name, bytes: gpx.text, mimeType: gpxMimeType });
    } catch (error) {
      if (error instanceof TrackUnavailableError || error instanceof TrackDecodeError) notify({ text: "Trace indisponible" });
      else if (error instanceof CodedError) notify({ text: "Partage impossible" });
      else throw error;
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <Row title="Exporter en GPX" detail="Strava, Garmin Connect, Komoot" trailing={<Chevron />} onPress={show} last={last} />
      <Sheet open={open} title="Exporter en GPX" context="Les points gardés après le rejet des aberrations, sans lissage, rognage compris" onClose={() => setOpen(false)}>
        <View style={styles.body}>
          {masks ? (
            <SwitchRow title="Inclure la trace complète" detail={maskDetail(zones.length, current.hideTrackEndsMeters)} value={includeFullTrack} onChange={setIncludeFullTrack} />
          ) : (
            <Text variant="small" tone="secondary">
              Aucune zone de confidentialité : la trace est exportée en entier.
            </Text>
          )}
          <PrimaryButton label={sharing ? "Préparation du fichier" : "Partager le fichier GPX"} disabled={sharing} onPress={() => void share()} />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingTop: 8 },
});
