import { router } from "expo-router";
import type { SessionSummary } from "@obnixe/core";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Row } from "@/ui/Layout";
import { rowDay } from "@/features/stats/format";
import { sessionTitle, zoneLabel } from "@/format/labels";
import { DetailLine } from "@/features/stats/parts";
import type { DetailPart } from "@/features/stats/parts";
import { sessionFigure, sportLabel } from "@/features/stats/presentation";

export function openSession(sessionId: string): void {
  router.push({ pathname: "/session/[id]", params: { id: sessionId } });
}

export function sessionDetailParts(summary: SessionSummary, withDate: boolean): DetailPart[] {
  const { details } = sessionFigure(summary);
  const parts: DetailPart[] = [];
  if (withDate) parts.push({ kind: "text", text: rowDay(summary.localDate) });
  for (const detail of details) parts.push({ kind: "text", text: detail });
  for (const pain of summary.pains.slice(0, 2)) parts.push({ kind: "pain", level: pain.level, text: zoneLabel(pain.zone).toLowerCase() });
  if (summary.addedBy !== null) parts.push({ kind: "tag", label: `Ajoutée par ${summary.addedBy}` });
  return parts;
}

interface SessionRowProps {
  readonly summary: SessionSummary;
  readonly withDate: boolean;
  readonly last?: boolean;
}

export function SessionRow({ summary, withDate, last = false }: SessionRowProps) {
  const { figure } = sessionFigure(summary);
  const parts = sessionDetailParts(summary, withDate);
  return (
    <Row
      leading={<SportIcon sport={summary.sport} label={sportLabel(summary.sport)} />}
      title={sessionTitle(summary)}
      detail={parts.length === 0 ? undefined : <DetailLine parts={parts} />}
      {...(figure === null ? {} : { value: figure.value, valueDetail: figure.unit === "" ? " " : figure.unit })}
      onPress={() => openSession(summary.id)}
      last={last}
    />
  );
}
