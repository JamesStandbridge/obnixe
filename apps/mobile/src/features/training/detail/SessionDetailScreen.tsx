import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ZodError } from "zod";
import {
  AlreadyRevertedError,
  correctSetMutations,
  deleteSetMutations,
  DependentRowsError,
  InvalidSetError,
  loadSessionReport,
  localDateOf,
  RevertConflictError,
  sessionHistory,
} from "@obnixe/core";
import type { HistoryEntry, PainAnchor, SessionReport } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { Id, PainPhase } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { undo, useUndoableWrite, write } from "@/data/write";
import { effortLabels, formatDay, formatLongDate, formatMass, formatTime, sensationPhrases } from "@/features/training/format";
import { capitalize, lowerFirst, sessionTitle, zoneLabel } from "@/format/labels";
import { formatClock } from "@/format/durations";
import { Message } from "@/features/training/Message";
import { DateSheet } from "@/features/training/detail/DateSheet";
import type { SessionTiming } from "@/features/training/detail/DateSheet";
import { EditSheet } from "@/features/training/detail/EditSheet";
import type { SessionPatch } from "@/features/training/detail/EditSheet";
import { ExerciseBlock } from "@/features/training/detail/ExerciseBlock";
import { GradeLadder } from "@/features/training/detail/GradeLadder";
import { heroStats } from "@/features/training/detail/sessionStats";
import { SetSheet } from "@/features/training/detail/SetSheet";
import type { SetTarget } from "@/features/training/detail/SetSheet";
import { climbItemWord, fieldValueText, shortTitle, timeRange, titleSource } from "@/features/training/sessionText";
import { useLiveLoad } from "@/features/training/useLiveLoad";
import { deviceTimeZone } from "@/format/dates";
import { useMassUnit } from "@/data/settings";
import { setText } from "@/features/training/workout/liveWorkout";
import type { Draft } from "@/features/training/workout/liveWorkout";
import { cancelRestAlert } from "@/features/training/workout/restAlert";
import { ControlButton, LinkButton } from "@/ui/Button";
import { PainMark, Tag } from "@/ui/Controls";
import { SportIcon } from "@/ui/icons/SportIcon";
import { IconButton, MenuItem, painLevelLabels } from "@/ui/Inputs";
import { Row, Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { StatRow } from "@/ui/Stats";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";
import { goBack } from "@/ui/navigation";

interface DetailData {
  readonly report: SessionReport;
  readonly history: readonly HistoryEntry[];
}

function loadDetail(sessionId: Id): DetailData | null {
  const report = loadSessionReport(db(), sessionId, environment.now());
  if (report === null) return null;
  return { report, history: sessionHistory(db(), sessionId) };
}

interface SessionDetailScreenProps {
  readonly sessionId: Id;
}

export function SessionDetailScreen({ sessionId }: SessionDetailScreenProps) {
  const data = useLiveLoad(() => loadDetail(sessionId), [sessionId]);
  const notify = useSnackbar();
  if (data === null) return <Message title="Séance introuvable" detail="Elle n'existe pas ou plus." action={null} />;
  const { session } = data.report.data;
  if (session.deletedAt !== null) {
    return (
      <Message
        title="Séance supprimée"
        detail="Elle reste 30 jours dans la corbeille."
        action={{
          label: "Restaurer",
          run: () => {
            write(`Restauration : ${sessionTitle(titleSource(data.report))}`, [{ kind: "update", table: "session", key: session.id, patch: { deletedAt: null } }]);
            notify({ text: "Séance restaurée", aboveTabBar: false });
          },
        }}
      />
    );
  }
  return <Detail data={data} />;
}

function phaseText(phase: PainPhase | null): string {
  switch (phase) {
    case "before":
      return "avant la séance";
    case "during":
      return "pendant la séance";
    case "between":
      return "entre deux séries";
    case "end":
      return "en fin de séance";
    case null:
      return "";
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

function anchorText(anchor: PainAnchor | undefined, itemWord: string): string {
  if (anchor === undefined) return "";
  switch (anchor.kind) {
    case "set":
      return `${lowerFirst(anchor.exerciseName)}, série ${anchor.setIndex + 1}`;
    case "item":
      return `après le ${itemWord} ${anchor.itemIndex + 1}`;
    case "phase":
      return phaseText(anchor.phase);
    default: {
      const unreachable: never = anchor;
      return unreachable;
    }
  }
}

function authorTag(entry: HistoryEntry): string {
  switch (entry.author) {
    case "user":
      return "Toi";
    case "agent":
      return entry.client ?? "Agent";
    case "import":
      return "Import";
    default: {
      const unreachable: never = entry.author;
      return unreachable;
    }
  }
}

interface FeelingPart {
  readonly text: string;
  readonly soft: boolean;
}

function feelingsParts(report: SessionReport): readonly FeelingPart[] {
  const { session } = report.data;
  const parts: FeelingPart[] = [];
  if (session.effort !== null) parts.push({ text: effortLabels[session.effort], soft: false });
  if (session.sensation !== null) parts.push({ text: sensationPhrases[session.sensation], soft: true });
  if (session.enjoyment !== null) parts.push({ text: `plaisir ${session.enjoyment}/5`, soft: false });
  return parts;
}

interface DetailProps {
  readonly data: DetailData;
}

function Detail({ data }: DetailProps) {
  const { colors } = useTheme();
  const unit = useMassUnit();
  const notify = useSnackbar();
  const undoableWrite = useUndoableWrite();
  const { report, history } = data;
  const { session } = report.data;
  const now = environment.now();
  const today = localDateOf(now, deviceTimeZone());
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dating, setDating] = useState(false);
  const [setTarget, setSetTarget] = useState<SetTarget | null>(null);
  const title = sessionTitle(titleSource(report));
  const sport = sports[session.sport];
  const completed = session.status === "completed";
  const itemWord = climbItemWord(session);
  const creation = history.find((entry) => entry.creation);
  const placement = { aboveTabBar: false } as const;

  const stats = heroStats(report, now, unit);
  const isContinuous = sport.archetype === "continuous";
  const details = isContinuous
    ? sport.sessionFields.flatMap((field) => {
        if (stats.shownFields.has(field.key)) return [];
        const text = fieldValueText(field, session.values[field.key], unit);
        return text === null ? [] : [{ key: field.key, label: field.label, text }];
      })
    : [];
  const feelings = feelingsParts(report);
  const tags: string[] = [];
  if (!completed) tags.push(session.status === "interrupted" ? "Interrompue" : "En cours");
  if (report.data.version !== null) tags.push(`${report.data.version.name} v${report.data.version.number}`);
  if (creation !== undefined && creation.author === "agent") tags.push(`Ajoutée par ${creation.client ?? "l'agent"}`);
  if (creation !== undefined && creation.author === "import") tags.push("Importée");

  const resume = (): void => {
    if (session.sport === "climb") router.push({ pathname: "/climb/[id]", params: { id: session.id } });
    else router.push({ pathname: "/workout/[id]", params: { id: session.id } });
  };

  const saveSet = (target: SetTarget, draft: Draft): void => {
    const before = target.set;
    const changes: string[] = [];
    if (before.loadGrams !== draft.loadGrams && draft.loadGrams !== null) changes.push(`${formatMass(before.loadGrams ?? 0, unit)} → ${formatMass(draft.loadGrams, unit)} ${unit}`);
    if (before.reps !== draft.reps) changes.push(`${before.reps ?? 0} → ${draft.reps ?? 0} rép.`);
    if (before.durationSeconds !== draft.durationSeconds) changes.push(`${formatClock(before.durationSeconds ?? 0)} → ${formatClock(draft.durationSeconds ?? 0)}`);
    if (before.rir !== draft.rir) changes.push(`RIR ${before.rir ?? "–"} → ${draft.rir ?? "–"}`);
    setSetTarget(null);
    if (changes.length === 0) return;
    const summary = `${target.exercise.exercise.name}, série ${target.index + 1} : ${changes.join(", ")}`;
    try {
      undoableWrite({ summary, mutations: correctSetMutations(report.data, before.id, draft), message: `Série ${target.index + 1} corrigée · ${setText(draft, unit)}`, ...placement });
    } catch (error) {
      if (error instanceof InvalidSetError) {
        notify({ text: "Valeurs invalides", ...placement });
        return;
      }
      throw error;
    }
  };

  const deleteSet = (target: SetTarget): void => {
    setSetTarget(null);
    undoableWrite({
      summary: `${target.exercise.exercise.name}, série ${target.index + 1} supprimée`,
      mutations: deleteSetMutations(report.data, target.set.id),
      message: `Série ${target.index + 1} supprimée`,
      ...placement,
    });
  };

  const saveFields = (patch: SessionPatch): void => {
    setEditing(false);
    try {
      undoableWrite({ summary: `Saisie corrigée : ${title}`, mutations: [{ kind: "update", table: "session", key: session.id, patch }], message: "Saisie corrigée", ...placement });
    } catch (error) {
      if (error instanceof ZodError) {
        notify({ text: "Valeurs invalides", ...placement });
        return;
      }
      throw error;
    }
  };

  const saveTiming = (timing: SessionTiming): void => {
    setDating(false);
    undoableWrite({ summary: `Date ou heure modifiée : ${title}`, mutations: [{ kind: "update", table: "session", key: session.id, patch: timing }], message: "Date et heure modifiées", ...placement });
  };

  const toggleRotation = (): void => {
    setMore(false);
    const counts = !session.countsInRotation;
    undoableWrite({
      summary: counts ? `Compte dans la rotation : ${title}` : `Ne compte plus dans la rotation : ${title}`,
      mutations: [{ kind: "update", table: "session", key: session.id, patch: { countsInRotation: counts } }],
      message: counts ? "Compte dans la rotation" : "Ne compte plus dans la rotation",
      ...placement,
    });
  };

  const remove = (): void => {
    setMore(false);
    if (session.status !== "completed") cancelRestAlert();
    undoableWrite({
      summary: `Suppression : ${title}`,
      mutations: [{ kind: "update", table: "session", key: session.id, patch: { deletedAt: environment.now() } }],
      message: "Séance supprimée · dans la corbeille 30 jours",
      aboveTabBar: true,
    });
    goBack("/");
  };

  const revertEntry = (entry: HistoryEntry): void => {
    try {
      undo(entry.changesetId, entry.summary);
      notify({ text: "Modification annulée", ...placement });
    } catch (error) {
      if (error instanceof RevertConflictError || error instanceof DependentRowsError || error instanceof AlreadyRevertedError) {
        notify({ text: "Impossible de revenir : modifié depuis", ...placement });
        return;
      }
      throw error;
    }
  };

  const correct = (): void => {
    setMore(false);
    if (session.sport === "climb") router.push({ pathname: "/climb/[id]", params: { id: session.id } });
    else setEditing(true);
  };

  return (
    <>
      <Screen>
        <View style={styles.appbar}>
          <IconButton icon="back" label="Retour" edge="start" onPress={() => goBack("/")} />
          <Text style={styles.appbarContext} tone="secondary">
            Journal
          </Text>
          <IconButton icon="more" label="Plus d'actions" edge="end" onPress={() => setMore(true)} />
        </View>

        <View style={styles.hero}>
          <View style={styles.heroHead}>
            <SportIcon sport={session.sport} variant="badge" label={sport.label} />
            <View style={styles.heroMeta}>
              <Text variant="eyebrow" style={{ color: colors.sport[session.sport] }}>
                {sport.label}
              </Text>
              <Text variant="small" tone="secondary" numberOfLines={1}>
                {capitalize(formatLongDate(session.localDate))} · {timeRange(session)}
              </Text>
            </View>
          </View>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {tags.length === 0 ? null : (
            <View style={styles.tags}>
              {tags.map((tag) => (
                <Tag key={tag} label={tag} />
              ))}
            </View>
          )}
          <View style={[styles.stats, { backgroundColor: colors.surface }]}>
            <StatRow stats={stats.primary} size="large" />
            {stats.secondary.length === 0 ? null : <StatRow stats={stats.secondary} style={[styles.secondaryStats, { borderTopColor: colors.line }]} />}
          </View>
          {completed ? null : <ControlButton label="Reprendre la séance" onPress={resume} style={styles.resume} />}
        </View>

        {session.sport === "strength" && report.exercises.length > 0 ? (
          <Section title="Exercices">
            {report.exercises.map((exercise) => (
              <ExerciseBlock key={exercise.exercise.entry.id} report={report} exercise={exercise} today={today} unit={unit} onSet={setSetTarget} />
            ))}
          </Section>
        ) : null}

        {report.climb !== null && report.items.length > 0 ? (
          <Section title={capitalize(itemWord.plural)}>
            <GradeLadder items={report.items} pains={report.data.pains} itemWord={itemWord} />
          </Section>
        ) : null}

        {details.length === 0 ? null : (
          <Section title="Détails">
            {details.map((row, index) => (
              <Row key={row.key} title={row.label} trailing={<Text style={styles.detailValue}>{row.text}</Text>} last={index === details.length - 1} />
            ))}
          </Section>
        )}

        {completed ? (
          <Section title="Ressenti" action={<LinkButton label={session.review === "pending" ? "Faire le bilan" : "Modifier"} onPress={() => router.push({ pathname: "/session/[id]/review", params: { id: session.id } })} style={styles.sectionLink} />}>
            {feelings.length === 0 ? (
              <Text tone="secondary" style={styles.feelingsEmpty}>
                {session.review === "pending" ? "Bilan à compléter" : "Non renseigné"}
              </Text>
            ) : (
              <Text style={styles.feelings}>
                {feelings.map((part, index) => (
                  <Text key={part.text} style={styles.feelingsStrong}>
                    {index === 0 ? null : <Text style={[styles.feelingsSoft, { color: colors.text2 }]}> · </Text>}
                    <Text style={part.soft ? [styles.feelingsSoft, { color: colors.text2 }] : styles.feelingsStrong}>{part.text}</Text>
                  </Text>
                ))}
              </Text>
            )}
          </Section>
        ) : null}

        {report.data.pains.length === 0 ? null : (
          <Section title="Douleurs">
            {report.data.pains.map((pain, index) => {
              const level = pain.level === "none" ? null : pain.level;
              return (
                <Row
                  key={pain.id}
                  title={zoneLabel(pain.zone)}
                  detail={anchorText(report.painAnchors.get(pain.id), itemWord.singular)}
                  trailing={
                    <View style={styles.painValue}>
                      {level === null ? null : <PainMark level={level} />}
                      <Text style={styles.painLabel}>{painLevelLabels[pain.level]}</Text>
                    </View>
                  }
                  last={index === report.data.pains.length - 1}
                />
              );
            })}
          </Section>
        )}

        {session.note === null ? null : (
          <Section title="Note">
            <Text style={styles.note}>{session.note}</Text>
          </Section>
        )}

        {history.length === 0 ? null : (
          <Section title="Historique">
            {history.map((entry, index) => (
              <Row
                key={entry.changesetId}
                title={entry.creation ? (entry.author === "user" ? "Créée" : "Ajoutée") : entry.summary}
                detail={
                  <View style={styles.historyDetail}>
                    {entry.author === "user" ? (
                      <Text variant="eyebrow" tone="secondary" style={styles.plainTag}>
                        Toi
                      </Text>
                    ) : (
                      <Tag label={authorTag(entry)} />
                    )}
                    <Text variant="small" tone="secondary">
                      {formatDay(localDateOf(entry.createdAt, session.timeZone))}, {formatTime(entry.createdAt, session.timeZone)}
                      {entry.reverted ? " · annulée" : ""}
                    </Text>
                  </View>
                }
                trailing={entry.revertible ? <LinkButton label="Revenir" onPress={() => revertEntry(entry)} style={styles.revert} /> : undefined}
                last={index === history.length - 1}
              />
            ))}
          </Section>
        )}
      </Screen>

      <Sheet open={more} title={`${shortTitle(report)} · ${formatDay(session.localDate)}`} onClose={() => setMore(false)}>
        <View style={styles.menu}>
          <MenuItem label="Corriger la saisie" onPress={correct} />
          {completed ? (
            <MenuItem
              label="Changer la date ou l'heure"
              onPress={() => {
                setMore(false);
                setDating(true);
              }}
            />
          ) : null}
          {session.slotId === null ? null : <MenuItem label={session.countsInRotation ? "Ne pas compter dans la rotation" : "Compter dans la rotation"} onPress={toggleRotation} />}
          <MenuItem label="Supprimer la séance" detail="30 jours dans la corbeille" onPress={remove} />
        </View>
      </Sheet>
      <EditSheet open={editing} session={session} placeholder={title} unit={unit} onClose={() => setEditing(false)} onSave={saveFields} />
      {completed ? <DateSheet open={dating} session={session} onClose={() => setDating(false)} onSave={saveTiming} /> : null}
      <SetSheet target={setTarget} unit={unit} onClose={() => setSetTarget(null)} onSave={saveSet} onDelete={deleteSet} />
    </>
  );
}

const styles = StyleSheet.create({
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  appbarContext: { flex: 1, fontFamily: fonts.text600, fontSize: 15 },
  hero: { marginTop: 14, gap: 8 },
  heroHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  heroMeta: { flex: 1, minWidth: 0, gap: 5 },
  title: { marginTop: 4, fontFamily: fonts.text700, fontSize: 30, lineHeight: 32, letterSpacing: -0.6 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  stats: { marginTop: 8, borderRadius: radii.panel, paddingHorizontal: 14, paddingVertical: 14 },
  secondaryStats: { marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  resume: { marginTop: 4 },
  sectionLink: { marginVertical: -12, marginRight: -10 },
  feelings: { marginTop: 8, fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  feelingsStrong: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  feelingsSoft: { fontFamily: fonts.figure600, fontSize: 19, lineHeight: 25 },
  feelingsEmpty: { marginTop: 8 },
  painValue: { flexDirection: "row", alignItems: "center", gap: 6 },
  painLabel: { fontFamily: fonts.text600, fontSize: 15 },
  detailValue: { fontFamily: fonts.text600, fontSize: 16 },
  note: { marginTop: 10, lineHeight: 23 },
  historyDetail: { flexDirection: "row", alignItems: "center", gap: 6 },
  plainTag: { letterSpacing: 0.24, textTransform: "none" },
  revert: { marginRight: -10 },
  menu: { marginTop: 8 },
});
