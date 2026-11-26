import { router } from "expo-router";
import type { SessionSummary } from "@obnixe/core";
import { TrackPreview } from "@/features/recordings/TrackPreview";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Row } from "@/ui/Layout";
import { rowDay } from "@/features/stats/format";
import { summaryTitle, zoneLabel } from "@/format/labels";
import { DetailLine } from "@/features/stats/parts";
import type { DetailPart } from "@/features/stats/parts";
import { sessionFigure, sportLabel } from "@/features/stats/presentation";
import { useTheme } from "@/ui/theme";

export function openSession(sessionId: string): void {
  router.push({ pathname: "/session/[id]", params: { id: sessionId } });
}

export function sessionDetailParts(summary: SessionSummary, withDate: boolean): DetailPart[] {
  const { details } = sessionFigure(summary);
  const parts: DetailPart[] = [];
  if (withDate) parts.push({ kind: "text", text: rowDay(summary.localDate) });
  for (const detail of details) parts.push({ kind: "text", text: detail });
  parts.push(...sessionFlagParts(summary));
  return parts;
}

export function sessionFlagParts(summary: Pick<SessionSummary, "pains" | "addedBy">): DetailPart[] {
  const parts: DetailPart[] = summary.pains.slice(0, 2).map((pain) => ({ kind: "pain", level: pain.level, text: zoneLabel(pain.zone).toLowerCase() }));
  if (summary.addedBy !== null) parts.push({ kind: "tag", label: `Ajoutée par ${summary.addedBy}` });
  return parts;
}

interface SessionRowProps {
  readonly summary: SessionSummary;
  readonly withDate: boolean;
  readonly last?: boolean;
}

export function SessionRow({ summary, withDate, last = false }: SessionRowProps) {
  const { colors } = useTheme();
  const { figure } = sessionFigure(summary);
  const preview = summary.recording?.previewPolyline ?? null;
  const parts = sessionDetailParts(summary, withDate);
  return (
    <Row
      leading={<SportIcon sport={summary.sport} label={sportLabel(summary.sport)} />}
      title={summaryTitle(summary)}
      detail={parts.length === 0 ? undefined : <DetailLine parts={parts} />}
      {...(figure === null ? {} : { value: figure.value, valueDetail: figure.unit === "" ? " " : figure.unit })}
      {...(preview === null ? {} : { trailing: <TrackPreview polyline={preview} color={colors.sport[summary.sport]} width={44} height={32} /> })}
      onPress={() => openSession(summary.id)}
      last={last}
    />
  );
}
