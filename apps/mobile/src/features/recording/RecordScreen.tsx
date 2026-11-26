import { useMemo, useState } from "react";
import { View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import type { GearWearAlert, ZoneProposal } from "@obnixe/core";
import { gearWearAlert, recordAnnouncements } from "@obnixe/core";
import type { Id, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { bottomPanelHeight } from "@/features/activity/components";
import { useRetireGear } from "@/features/activity/gearWear";
import { LiveScreen } from "@/features/recording/LiveScreen";
import { sessionExists, sessionTargetOf } from "@/features/recording/queries";
import { recordLines } from "@/features/recording/records";
import type { RecordLine } from "@/features/recording/records";
import { FinishView, RecoveryView, SavedView } from "@/features/recording/SummaryScreen";
import { recorder, useRecorderView } from "@/features/tracking/recorder";
import type { RecorderOutcome, RecordingView } from "@/features/tracking/recorderHost";
import { settleZoneProposal, zoneFromProposal } from "@/features/tracking/zoneProposals";
import { useSnackbar } from "@/ui/SnackbarHost";
import { useTheme } from "@/ui/theme";

interface AfterSave {
  readonly sessionId: Id;
  readonly sport: SportKey;
  readonly lines: readonly RecordLine[];
  readonly proposal: ZoneProposal | null;
  readonly wear: GearWearAlert | null;
}

const zoneLabel = "Lieu fréquent";

interface RecordScreenProps {
  readonly sessionId: Id;
}

/** One recording from its start to its save: live pages, stop summary, recovery prompt, then records. */
export function RecordScreen({ sessionId }: RecordScreenProps) {
  const { colors } = useTheme();
  const view = useRecorderView();
  const router = useRouter();
  const notify = useSnackbar();
  const undoableWrite = useUndoableWrite();
  const retireGear = useRetireGear();
  const [after, setAfter] = useState<AfterSave | null>(null);
  const [leaving, setLeaving] = useState(false);
  const target = useMemo(() => sessionTargetOf(sessionId), [sessionId]);
  const placement = { aboveTabBar: false, extraOffset: bottomPanelHeight + 48 } as const;

  const review = (id: Id): void => {
    router.replace({ pathname: "/session/[id]/review", params: { id, attach: "1" } });
  };

  const settled = <T,>(outcome: RecorderOutcome<T>): outcome is { readonly ok: true; readonly value: T } => {
    if (outcome.ok) return true;
    setLeaving(false);
    notify({ text: outcome.failure.kind === "storage_full" ? "Stockage plein : libère de la place puis réessaie" : "Action impossible, réessaie", ...placement });
    return false;
  };

  const save = async (recording: RecordingView): Promise<void> => {
    setLeaving(true);
    const outcome = await recorder.save();
    if (!settled(outcome)) return;
    const saved = outcome.value;
    const lines = recordLines(recordAnnouncements(db(), saved.sessionId));
    const wear = gearWearAlert(db(), saved.sessionId);
    if (lines.length === 0 && saved.zoneProposal === null && wear === null) review(saved.sessionId);
    else setAfter({ sessionId: saved.sessionId, sport: recording.profile.sport, lines, proposal: saved.zoneProposal, wear });
  };

  const discard = async (): Promise<void> => {
    setLeaving(true);
    const outcome = await recorder.discard();
    if (!settled(outcome)) return;
    const { undoUntil } = outcome.value;
    router.replace("/");
    notify({
      text: "Sortie supprimée",
      durationMs: Math.max(0, undoUntil - Date.now()),
      action: {
        label: "Annuler",
        run: () => {
          if (recorder.undoDiscard().ok) router.push({ pathname: "/record/[id]", params: { id: sessionId } });
          else notify({ text: "Trop tard pour annuler" });
        },
      },
    });
  };

  const act = (task: Promise<RecorderOutcome<unknown>> | RecorderOutcome<unknown>): void => {
    void Promise.resolve(task).then(settled);
  };

  if (after !== null) {
    const proposal = after.proposal;
    return (
      <SavedView
        sport={after.sport}
        lines={after.lines}
        proposal={proposal}
        wear={after.wear}
        onRetireGear={() => {
          if (after.wear === null) return;
          retireGear(after.wear);
          setAfter({ ...after, wear: null });
        }}
        onCreateZone={() => {
          if (proposal === null) return;
          undoableWrite({ summary: `Zone de confidentialité : ${zoneLabel}`, mutations: [zoneFromProposal(proposal, zoneLabel).mutation], message: "Zone créée", ...placement });
          settleZoneProposal(proposal);
          setAfter({ ...after, proposal: null });
        }}
        onDeclineZone={() => {
          if (proposal === null) return;
          settleZoneProposal(proposal);
          setAfter({ ...after, proposal: null });
        }}
        onContinue={() => {
          if (proposal !== null) settleZoneProposal(proposal);
          review(after.sessionId);
        }}
      />
    );
  }

  if (view.kind === "recording" && view.recording.sessionId === sessionId) {
    const recording = view.recording;
    const state = recording.state;
    switch (state.phase) {
      case "preparing":
      case "recording":
      case "auto_paused":
      case "paused":
        return <LiveScreen recording={recording} />;
      case "finishing":
        return <FinishView recording={recording} reason={state.reason} target={target} onSave={() => void save(recording)} onResume={() => act(recorder.resume())} onDiscard={() => void discard()} onDistance={(distanceMm) => act(recorder.setStopwatchDistance(distanceMm))} />;
      case "interrupted":
        return <RecoveryView recording={recording} endT={state.endT} onResume={() => act(recorder.resume())} onFinish={() => act(recorder.stop())} />;
      case "saved":
      case "discarded":
        return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
      default: {
        const unreachable: never = state;
        return unreachable;
      }
    }
  }

  if (leaving) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return sessionExists(sessionId) ? <Redirect href={{ pathname: "/session/[id]", params: { id: sessionId } }} /> : <Redirect href="/" />;
}
