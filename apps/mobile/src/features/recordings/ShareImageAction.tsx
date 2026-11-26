import { useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import type { HostInstance } from "react-native";
import { CodedError } from "expo";
import { activePrivacyMask, exportFileName, shareTrack } from "@obnixe/core";
import type { PrivacyMask } from "@obnixe/core";
import type { MetricKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { Chevron } from "@/features/data/parts";
import { summaryFigures } from "@/features/recordings/format";
import { ShareCard, shareImageSize, shareTrackFrame } from "@/features/recordings/ShareCard";
import type { ShareCardContent } from "@/features/recordings/ShareCard";
import { shareCardImage } from "@/features/recordings/shareImage";
import type { RecordedActivity } from "@/features/recordings/useRecordedActivity";
import { sportLabel } from "@/features/stats/presentation";
import { PrimaryButton } from "@/ui/Button";
import { Row } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";

const previewMaxWidth = 340;

/** Distance, moving time, the sport's average pace or speed, then the D+ when there is one. */
function shareFigureKeys(activity: RecordedActivity): readonly MetricKey[] {
  const ascent = activity.processed.summary.ascentMm;
  return ["distance", "moving", activity.profile.primary === "pace" ? "pace_avg" : "speed_avg", ...(ascent !== null && ascent > 0 ? (["ascent"] as const) : [])];
}

function shareContent(activity: RecordedActivity, title: string, date: string, mask: PrivacyMask): ShareCardContent {
  const { profile, processed, saved } = activity;
  const figures = summaryFigures({ profile, summary: processed.summary, details: processed.details, energyKcal: saved.recording.energyKcal });
  const shown = shareFigureKeys(activity).flatMap((key) => figures.filter((figure) => figure.key === key));
  const track = shareTrack(processed.series, mask, shareTrackFrame);
  return {
    sport: saved.session.sport,
    sportLabel: sportLabel(saved.session.sport),
    title,
    date,
    figures: shown,
    track: track !== null ? { kind: "drawn", track } : processed.series.length > 0 ? { kind: "masked" } : { kind: "none" },
  };
}

interface ShareImageActionProps {
  readonly activity: RecordedActivity;
  readonly title: string;
  readonly date: string;
  readonly last?: boolean;
}

/**
 * « Partager une image » of a measured activity (`SUM-006`): the share sheet, or a download on the web. The privacy zones and
 * the hidden ends always apply, as for the stored preview, whatever the in-app mask setting (`PRV-010`).
 */
export function ShareImageAction({ activity, title, date, last = false }: ShareImageActionProps) {
  const notify = useSnackbar();
  const { width } = useWindowDimensions();
  const card = useRef<HostInstance>(null);
  const [content, setContent] = useState<ShareCardContent | null>(null);
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const { session } = activity.saved;

  const share = async (): Promise<void> => {
    setSharing(true);
    try {
      await shareCardImage(card, shareImageSize, exportFileName(session, "png"));
      setOpen(false);
    } catch (error) {
      if (error instanceof CodedError) notify({ text: "Partage impossible" });
      else throw error;
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <Row
        title="Partager une image"
        detail="Trace sans carte et chiffres clés"
        trailing={<Chevron />}
        onPress={() => {
          setContent(shareContent(activity, title, date, activePrivacyMask(db())));
          setOpen(true);
        }}
        last={last}
      />
      <Sheet open={open} title="Partager une image" context="Sans fond de carte, zones de confidentialité et extrémités masquées" onClose={() => setOpen(false)}>
        <View style={styles.body}>
          {content === null ? null : (
            <View ref={card} collapsable={false} style={styles.card}>
              <ShareCard content={content} width={Math.min(width - 48, previewMaxWidth)} />
            </View>
          )}
          <PrimaryButton label={sharing ? "Préparation de l'image" : "Partager l'image"} disabled={sharing} onPress={() => void share()} />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingTop: 8 },
  card: { alignSelf: "center", overflow: "hidden" },
});
