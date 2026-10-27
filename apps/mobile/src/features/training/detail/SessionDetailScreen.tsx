import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ZodError } from "zod";
import {
  activeSeconds,
  AlreadyRevertedError,
  correctSetMutations,
  deleteSetMutations,
  DependentRowsError,
  InvalidSetError,
  loadSessionReport,
  localDateOf,
  RevertConflictError,
  sessionHistory,
  worstLevel,
} from "@obnixe/core";
import type { ExerciseReport, HistoryEntry, PainAnchor, SessionReport } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { Id, LocalDate, MassUnit, PainPhase } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { undo, useUndoableWrite, write } from "@/data/write";
import { effortLabels, formatDay, formatLongDate, formatMass, formatTime, loadContext, sensationPhrases } from "@/features/training/format";
import { capitalize, lowerFirst, sessionTitle, zoneLabel } from "@/format/labels";
import { formatClock, formatLongClock } from "@/format/durations";
import { Message } from "@/features/training/Message";
import { DateSheet } from "@/features/training/detail/DateSheet";
import type { SessionTiming } from "@/features/training/detail/DateSheet";
import { EditSheet } from "@/features/training/detail/EditSheet";
import type { SessionPatch } from "@/features/training/detail/EditSheet";
import { SetSheet } from "@/features/training/detail/SetSheet";
import type { SetTarget } from "@/features/training/detail/SetSheet";
import { climbFacts, climbItemText, climbItemWord, continuousIndicators, distanceFigure, durationText, fieldValueText, outcomeText, setsFact, shortTitle, timeRange, titleSource } from "@/features/training/sessionText";
import { useLiveLoad } from "@/features/training/useLiveLoad";
import { deviceTimeZone } from "@/format/dates";
import { useMassUnit } from "@/data/settings";
import { setText, targetText } from "@/features/training/workout/liveWorkout";
import type { Draft } from "@/features/training/workout/liveWorkout";
import { cancelRestAlert } from "@/features/training/workout/restAlert";
import { ControlButton, LinkButton } from "@/ui/Button";
import { PainMark, Tag } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { IconButton, MenuItem, painLevelLabels } from "@/ui/Inputs";
import { Row, Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";
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

function exerciseDetail(report: ExerciseReport, today: LocalDate, unit: MassUnit): string {
  const { outcome, exercise } = report;
  const plan = exercise.item === null ? "hors programme" : `prévu ${targetText(exercise)}${exercise.target.rir === null ? "" : ` · RIR ${exercise.target.rir}`}`;
  switch (outcome.kind) {
    case "stopped":
      return `arrêté · ${outcome.setsDone} ${outcome.setsDone > 1 ? "séries" : "série"}${outcome.setsPlanned === null ? "" : ` sur ${outcome.setsPlanned}`}`;
    case "skipped":
      return "passé";
    case "suspended":
      return "progression suspendue";
    case "same":
    case "reps":
    case "duration":
      return outcomeText(outcome, exercise.exercise.loadMode, today, unit, false);
    case "load":
    case "first":
      return plan;
    default: {
      const unreachable: never = outcome;
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

  const facts: string[] = [];
  if (session.sport === "strength") facts.push(timeRange(session), durationText(session, now), setsFact(report.summary));
  else if (report.climb !== null) facts.push(timeRange(session), ...climbFacts(report.climb, itemWord));
  else facts.push(...continuousIndicators(session, now));
  if (!completed) facts.push(session.status === "interrupted" ? "interrompue" : "en cours");

  const distance = typeof session.values.distance === "number" ? distanceFigure(session.values.distance) : null;
  const isContinuous = sport.archetype === "continuous";
  const feelings = feelingsParts(report);
  const tags: string[] = [];
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

        <View style={styles.head}>
          <Text variant="eyebrow" tone="secondary">
            {sport.label} · {formatLongDate(session.localDate)}
          </Text>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {isContinuous ? (
            <View style={styles.figures}>
              {distance === null ? null : <StaticFigure text={distance.text} unit={distance.unit} />}
              {distance === null ? null : <Text style={[styles.times, { color: colors.text3 }]}>·</Text>}
              <StaticFigure text={formatLongClock(activeSeconds(session, now))} unit="durée" />
            </View>
          ) : null}
          {facts.length === 0 ? null : <Text style={styles.facts}>{facts.join(" · ")}</Text>}
          {tags.length === 0 ? null : (
            <View style={styles.tags}>
              {tags.map((tag) => (
                <Tag key={tag} label={tag} />
              ))}
            </View>
          )}
          {completed ? null : <ControlButton label="Reprendre la séance" onPress={resume} style={styles.resume} />}
        </View>

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

        {session.sport === "strength" && report.exercises.length > 0 ? (
          <View>
            <View style={styles.setsHead} accessible={false} importantForAccessibility="no-hide-descendants">
              <Text style={[styles.setsHeadText, styles.colLabel]} tone="secondary" />
              <Text style={[styles.setsHeadText, styles.colValue]} tone="secondary">
                Charge × rép.
              </Text>
              <Text style={styles.setsHeadText} tone="secondary">
                RIR
              </Text>
              <Text style={[styles.setsHeadText, styles.colRest]} tone="secondary">
                Repos avant
              </Text>
            </View>
            {report.exercises.map((exercise) => (
              <ExerciseBlock key={exercise.exercise.entry.id} report={report} exercise={exercise} today={today} unit={unit} onSet={setSetTarget} />
            ))}
          </View>
        ) : null}

        {report.climb !== null && report.items.length > 0 ? (
          <Section title={capitalize(itemWord.plural)}>
            {report.items.map((item, index) => {
              const text = climbItemText(item);
              const level = worstLevel(report.data.pains.filter((pain) => pain.sessionItemId === item.id).map((pain) => pain.level));
              return (
                <View key={item.id} style={[styles.bloc, { borderBottomColor: colors.line, borderBottomWidth: index === report.items.length - 1 ? 0 : 1 }]}>
                  <View style={styles.blocLabel}>
                    <Text style={styles.blocLabelText} tone="secondary">
                      {capitalize(itemWord.singular)} {index + 1}
                    </Text>
                    {level === null ? null : <PainMark level={level} />}
                  </View>
                  <Text style={styles.blocGrade}>{text.grade}</Text>
                  <Text variant="small" tone="secondary" style={styles.blocStyle} numberOfLines={1}>
                    {text.style}
                  </Text>
                  <Text style={styles.blocResult} tone="secondary">
                    {text.result}
                  </Text>
                </View>
              );
            })}
          </Section>
        ) : null}

        {isContinuous ? (
          <Section title="Détails">
            {[
              ...sport.sessionFields.flatMap((field) => {
                if (field.key === "distance") return [];
                const text = fieldValueText(field, session.values[field.key], unit);
                return text === null ? [] : [{ key: field.key, label: field.label, text }];
              }),
              { key: "time", label: "Heure", text: formatTime(session.startedAt, session.timeZone) },
            ].map((row, index, rows) => (
              <Row key={row.key} title={row.label} trailing={<Text style={styles.detailValue}>{row.text}</Text>} last={index === rows.length - 1} />
            ))}
          </Section>
        ) : null}

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

interface ExerciseBlockProps {
  readonly report: SessionReport;
  readonly exercise: ExerciseReport;
  readonly today: LocalDate;
  readonly unit: MassUnit;
  readonly onSet: (target: SetTarget) => void;
}

function ExerciseBlock({ report, exercise, today, unit, onSet }: ExerciseBlockProps) {
  const { colors } = useTheme();
  const target = exercise.exercise;
  const name = target.exercise.name;
  const context = loadContext(target.exercise, unit);
  return (
    <View style={styles.exercise}>
      <View style={[styles.exerciseHead, { borderBottomColor: colors.line }]}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${name}, voir la progression`}
          onPress={() => router.push({ pathname: "/journal/progress", params: { exercise: target.exercise.id } })}
          style={styles.exerciseLink}
        >
          <Text style={styles.exerciseName} numberOfLines={1}>
            {name}
          </Text>
          <Icon name="chevron" size={14} color={colors.text3} />
        </Pressable>
        <Text variant="small" tone="secondary" numberOfLines={1} style={styles.exerciseDetail}>
          {context === null ? exerciseDetail(exercise, today, unit) : `${exerciseDetail(exercise, today, unit)} · ${context}`}
        </Text>
      </View>
      {target.sets.map((set, index) => {
        const level = worstLevel(report.data.pains.filter((pain) => pain.strengthSetId === set.id).map((pain) => pain.level));
        const rest = set.restBeforeSeconds === null ? "–" : formatClock(set.restBeforeSeconds);
        const loaded = set.loadGrams !== null && set.loadGrams > 0;
        const value = set.interrupted
          ? set.loadGrams === null
            ? "–"
            : `${formatMass(set.loadGrams, unit)} ${unit}`
          : loaded && set.durationSeconds === null
            ? `${formatMass(set.loadGrams ?? 0, unit)} ${unit} × ${set.reps ?? 0}`
            : setText(set, unit);
        return (
          <Pressable
            key={set.id}
            accessibilityRole="button"
            accessibilityLabel={`Série ${index + 1}, ${set.interrupted ? "interrompue" : `${value}, RIR ${set.rir ?? "non noté"}`}, repos ${set.restBeforeSeconds === null ? (index === 0 ? "aucun" : "non mesuré") : rest}`}
            accessibilityHint="Corriger la série"
            onPress={() => onSet({ exercise: target, set, index })}
            style={({ pressed }) => [styles.setRow, { borderBottomColor: colors.line, borderBottomWidth: index === target.sets.length - 1 ? 0 : 1 }, pressed && { backgroundColor: colors.surface }]}
          >
            <View style={[styles.colLabel, styles.setLabel]}>
              <Text style={styles.setLabelText} tone="secondary">
                Série {index + 1}
              </Text>
              {level === null ? null : <PainMark level={level} />}
            </View>
            <Text style={[styles.setValue, styles.colValue]} numberOfLines={1}>
              {value}
            </Text>
            <Text style={styles.setRir} tone="secondary">
              {set.interrupted ? "interrompue" : `RIR ${set.rir === null ? "–" : set.rir >= 4 ? "4+" : set.rir}`}
            </Text>
            <Text style={[styles.setRest, styles.colRest]} tone="secondary">
              {rest}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface StaticFigureProps {
  readonly text: string;
  readonly unit: string;
}

function StaticFigure({ text, unit }: StaticFigureProps) {
  const [integer = "", decimal] = text.split(",");
  return (
    <View style={styles.staticFigure} accessible accessibilityLabel={`${text} ${unit}`}>
      <View style={styles.staticValue}>
        <Text style={styles.staticText}>{integer}</Text>
        {decimal === undefined ? null : <Text style={styles.staticDecimal}>,{decimal}</Text>}
      </View>
      <Text style={styles.staticUnit} tone="secondary">
        {unit.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  appbarContext: { flex: 1, fontFamily: fonts.text600, fontSize: 15 },
  head: { marginTop: 14, gap: 6 },
  title: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 32, letterSpacing: -0.6 },
  facts: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  resume: { marginTop: 10 },
  figures: { marginTop: 16, flexDirection: "row", alignItems: "flex-end" },
  times: { width: 28, textAlign: "center", fontFamily: fonts.figure600, fontSize: 36, lineHeight: 38, paddingBottom: 30 },
  staticFigure: { flex: 1, alignItems: "center", gap: 6, paddingTop: 6, paddingBottom: 8 },
  staticValue: { flexDirection: "row", alignItems: "flex-start" },
  staticText: { fontFamily: fonts.figure800, fontSize: 64, lineHeight: 60, letterSpacing: -1.6 },
  staticDecimal: { fontFamily: fonts.figure700, fontSize: 35, lineHeight: 38, marginLeft: 1 },
  staticUnit: { fontFamily: fonts.text600, fontSize: 13, lineHeight: 15, letterSpacing: 0.52 },
  sectionLink: { marginVertical: -12, marginRight: -10 },
  feelings: { marginTop: 8, fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  feelingsStrong: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  feelingsSoft: { fontFamily: fonts.figure600, fontSize: 19, lineHeight: 25 },
  feelingsEmpty: { marginTop: 8 },
  painValue: { flexDirection: "row", alignItems: "center", gap: 6 },
  painLabel: { fontFamily: fonts.text600, fontSize: 15 },
  setsHead: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 12 },
  setsHeadText: { fontFamily: fonts.text600, fontSize: 13, lineHeight: 16 },
  colLabel: { width: 64 },
  colValue: { flex: 1, minWidth: 0 },
  colRest: { minWidth: 72, textAlign: "right" },
  exercise: { marginTop: 20 },
  exerciseHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 6, borderBottomWidth: 1 },
  exerciseLink: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, flexShrink: 1 },
  exerciseName: { fontFamily: fonts.text700, fontSize: 17, flexShrink: 1 },
  exerciseDetail: { flexShrink: 1, textAlign: "right" },
  setRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 6 },
  setLabel: { flexDirection: "row", alignItems: "center", gap: 6 },
  setLabelText: { fontFamily: fonts.text600, fontSize: 14 },
  setValue: { fontFamily: fonts.figure700, fontSize: 18, lineHeight: 20 },
  setRir: { fontFamily: fonts.text600, fontSize: 14 },
  setRest: { fontFamily: fonts.figure600, fontSize: 15 },
  bloc: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingVertical: 10 },
  blocLabel: { width: 64, flexDirection: "row", alignItems: "center", gap: 6 },
  blocLabelText: { fontFamily: fonts.text600, fontSize: 14 },
  blocGrade: { width: 56, fontFamily: fonts.figure700, fontSize: 20, lineHeight: 22 },
  blocStyle: { flex: 1, minWidth: 0 },
  blocResult: { fontFamily: fonts.text600, fontSize: 15 },
  detailValue: { fontFamily: fonts.text600, fontSize: 16 },
  note: { marginTop: 10, lineHeight: 23 },
  historyDetail: { flexDirection: "row", alignItems: "center", gap: 6 },
  plainTag: { letterSpacing: 0.24, textTransform: "none" },
  revert: { marginRight: -10 },
  menu: { marginTop: 8 },
});
