import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { ScrollViewInstance } from "react-native";
import { useRouter } from "expo-router";
import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import {
  ScaleChangeError,
  activeSeconds,
  climbDisciplines,
  climbStyles,
  climbSummary,
  defaultGrade,
  disciplineOf,
  localDateOf,
  normalizeDraft,
  planClimbItem,
  planClimbItemRemoval,
  planClimbItemUpdate,
  planClimbSettings,
  planSessionCompletion,
  readClimbItem,
  scaleForDiscipline,
  sessionPainMutations,
  zoneStatuses,
} from "@obnixe/core";
import type { ClimbDiscipline, ClimbItemDraft, ClimbResult, ClimbStyle, ZonePain } from "@obnixe/core";
import { gradeScales, painReport, sessionItem, sports, zoneKeys } from "@obnixe/schema";
import type { EpochMs, Id, PainLevel, PainPhase, Session, SessionItem, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { BottomPanel, ChoiceButton, Chips, Comparison, Figure, FigureRow, GradeGrid, PainIndicator, bottomPanelHeight } from "@/features/activity/components";
import { cellText, disciplineLabels, itemTitle, nounFor, resultLabels, scaleShortLabels, styleLabels, summaryText } from "@/features/activity/climbText";
import { formatHoursMinutes, lastPainLabel } from "@/features/activity/format";
import { capitalize, zoneLabel } from "@/format/labels";
import { deviceTimeZone } from "@/format/dates";
import { formatLongClock } from "@/format/durations";
import { TextSheet } from "@/features/activity/LogSheets";
import { PainSheet } from "@/features/activity/PainSheet";
import type { PainZoneRow } from "@/features/activity/PainSheet";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { Choices } from "@/ui/Inputs";
import { Screen } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { useKeepAwakeWhile } from "@/ui/useKeepAwakeWhile";

interface Draft {
  readonly grade: string;
  readonly attempts: number;
  readonly result: ClimbResult | null;
  readonly style: readonly ClimbStyle[];
}

interface Editing {
  readonly item: SessionItem;
  readonly index: number;
  readonly draft: Draft;
}

type ClimbSheet = "none" | "grades" | "pain" | "end" | "stop" | "discipline" | "place";

interface PainTarget {
  readonly sessionItemId: Id | null;
  readonly phase: PainPhase;
  readonly label: string;
  readonly pendingDraft: boolean;
}

const placement = { aboveTabBar: false, extraOffset: bottomPanelHeight } as const;

function toItemDraft(draft: Draft): ClimbItemDraft | null {
  return draft.result === null ? null : { grade: draft.grade, attempts: draft.attempts, result: draft.result, style: draft.style };
}

function worst(levels: readonly PainLevel[]): PainLevel | null {
  if (levels.includes("stop")) return "stop";
  if (levels.includes("discomfort")) return "discomfort";
  return null;
}

interface ClimbScreenProps {
  readonly current: Session;
}

export function ClimbScreen({ current }: ClimbScreenProps) {
  useKeepAwakeWhile(true);
  const router = useRouter();
  const notify = useSnackbar();
  const undoable = useUndoableWrite();
  const { colors } = useTheme();
  const timeZone = deviceTimeZone();
  const today = localDateOf(environment.now(), timeZone);

  const { data: items } = useLiveQuery(db().select().from(sessionItem).where(eq(sessionItem.sessionId, current.id)).orderBy(asc(sessionItem.position)), [current.id]);
  const { data: pains } = useLiveQuery(db().select().from(painReport).where(eq(painReport.sessionId, current.id)).orderBy(asc(painReport.occurredAt)), [current.id]);

  const discipline = disciplineOf(current.values);
  const scale = scaleForDiscipline(discipline);
  const grades: readonly string[] = gradeScales[scale].grades;
  const noun = nounFor(discipline);
  const place = typeof current.values.place === "string" ? current.values.place : null;

  const [draft, setDraft] = useState<Draft>(() => ({ grade: defaultGrade(db(), scale), attempts: 1, result: null, style: [] }));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [sheet, setSheet] = useState<ClimbSheet>("none");
  const [pendingPainIds, setPendingPainIds] = useState<readonly Id[]>([]);
  const [stopZones, setStopZones] = useState<readonly ZoneKey[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const track = useRef<ScrollViewInstance>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!grades.includes(draft.grade)) setDraft((previous) => ({ ...previous, grade: defaultGrade(db(), scale) }));
  }, [grades, draft.grade, scale]);

  useEffect(() => {
    if (editing === null) track.current?.scrollToEnd({ animated: false });
  }, [items.length, editing]);

  const readItems = items.map((item) => ({ item, values: readClimbItem(item.values) }));
  const summary = climbSummary(items.map((item) => item.values));
  const active = editing?.draft ?? draft;
  const gradeIndex = Math.max(0, grades.indexOf(active.grade));
  const elapsed = activeSeconds(current, now as EpochMs);

  const painsByItem = useMemo(() => {
    const map = new Map<Id, PainLevel[]>();
    for (const pain of pains) {
      if (pain.sessionItemId === null || pain.deletedAt !== null) continue;
      map.set(pain.sessionItemId, [...(map.get(pain.sessionItemId) ?? []), pain.level]);
    }
    return map;
  }, [pains]);
  const latestByZone = new Map(pains.filter((pain) => pain.deletedAt === null).map((pain) => [pain.zone, pain.level]));
  const sessionPain = worst([...latestByZone.values()]);

  const update = (patch: Partial<Draft>): void => {
    if (editing !== null) setEditing({ ...editing, draft: { ...editing.draft, ...patch } });
    else setDraft({ ...draft, ...patch });
  };

  const sameGrade = readItems.filter((entry, index) => entry.values?.grade === active.grade && index !== editing?.index);
  const sentSame = sameGrade.filter((entry) => entry.values?.result !== "project").length;
  const comparison = sameGrade.length === 0 ? { strong: "Premier essai à ce niveau", rest: "" } : { strong: `${sentSame} ${noun.done("enchaîné")}${sentSame > 1 ? "s" : ""} sur ${sameGrade.length}`, rest: `en ${active.grade} aujourd'hui` };

  const nextNumber = items.length + 1;

  const saveItem = (): void => {
    if (editing !== null) {
      const edited = toItemDraft(editing.draft);
      if (edited === null) return;
      const normalized = normalizeDraft(edited);
      const label = itemTitle(noun, editing.index + 1);
      undoable({ summary: `${label} corrigé`, mutations: [planClimbItemUpdate(current, editing.item, normalized)], message: `${label} ${noun.done("corrigé")} · ${normalized.grade} ${resultLabels[normalized.result].toLowerCase()}`, ...placement });
      setEditing(null);
      return;
    }
    const saved = toItemDraft(draft);
    if (saved === null) return;
    const normalized = normalizeDraft(saved);
    const plan = planClimbItem(db(), environment, current, normalized, pendingPainIds);
    const label = itemTitle(noun, nextNumber);
    const previous = draft;
    undoable({
      summary: `${label} enregistré`,
      mutations: plan.mutations,
      message: `${label} ${noun.done("enregistré")} · ${normalized.grade} ${resultLabels[normalized.result].toLowerCase()}`,
      ...placement,
      onUndone: () => setDraft(previous),
    });
    setPendingPainIds([]);
    setDraft({ grade: normalized.grade, attempts: 1, result: null, style: [] });
  };

  const removeItem = (): void => {
    if (editing === null) return;
    const label = itemTitle(noun, editing.index + 1);
    undoable({ summary: `${label} supprimé`, mutations: planClimbItemRemoval(db(), editing.item.id), message: `${label} ${noun.done("supprimé")}`, ...placement });
    setEditing(null);
  };

  const painTarget = ((): PainTarget => {
    if (editing !== null) return { sessionItemId: editing.item.id, phase: "during", label: `sur ${noun.the} ${editing.index + 1}, en correction`, pendingDraft: false };
    if (draft.result !== null) return { sessionItemId: null, phase: "during", label: `pendant ${noun.the} ${nextNumber}, en cours`, pendingDraft: true };
    const last = items.at(-1);
    if (last !== undefined) return { sessionItemId: last.id, phase: "between", label: `après ${noun.the} ${items.length}`, pendingDraft: false };
    return { sessionItemId: null, phase: "during", label: `avant ${noun.first}`, pendingDraft: false };
  })();

  const statuses = useMemo(() => (sheet === "pain" ? zoneStatuses(db(), zoneKeys) : []), [sheet]);
  const painRows: PainZoneRow[] = [
    ...statuses.filter((status) => status.tracked).map((status): PainZoneRow => ({ zone: status.zone, detail: status.last === null ? "suivi en cours" : lastPainLabel(status.last, today), levels: ["none", "discomfort", "stop"] })),
    ...sports.climb.painZones
      .filter((zone) => !statuses.some((status) => status.zone === zone && status.tracked))
      .map((zone): PainZoneRow => ({ zone, detail: "zone de l'escalade", levels: ["discomfort", "stop"] })),
  ];
  const otherZones = zoneKeys.filter((zone) => !painRows.some((row) => row.zone === zone));

  const savePains = (entries: readonly ZonePain[]): void => {
    const plan = sessionPainMutations(db(), environment, { sessionId: current.id, phase: painTarget.phase, strengthSetId: null, sessionItemId: painTarget.sessionItemId, occurredAt: environment.now(), timeZone }, entries);
    write("Douleur signalée", plan.mutations);
    if (painTarget.pendingDraft) setPendingPainIds([...pendingPainIds, ...plan.reportIds]);
    const stopped = entries.filter((entry) => entry.level === "stop").map((entry) => entry.zone);
    if (stopped.length > 0) {
      setStopZones(stopped);
      setSheet("stop");
      return;
    }
    setSheet("none");
    notify({ text: `Douleur enregistrée · ${painTarget.label}`, ...placement });
  };

  const pending = editing === null && draft.result !== null;

  const finish = (withPending: boolean): void => {
    const pendingDraft = toItemDraft(draft);
    const mutations = withPending && pendingDraft !== null ? [...planClimbItem(db(), environment, current, normalizeDraft(pendingDraft), pendingPainIds).mutations] : [];
    write("Séance d'escalade terminée", [...mutations, planSessionCompletion(environment, current)]);
    setSheet("none");
    router.replace({ pathname: "/session/[id]/review", params: { id: current.id } });
  };

  const discard = (): void => {
    write("Séance d'escalade abandonnée", [{ kind: "delete", table: "session", key: current.id }]);
    setSheet("none");
    router.replace("/");
  };

  const changeSettings = (nextDiscipline: ClimbDiscipline, nextPlace: string | null): void => {
    try {
      write("Séance d'escalade modifiée", [planClimbSettings(db(), current, nextDiscipline, nextPlace)]);
    } catch (error) {
      if (error instanceof ScaleChangeError) {
        notify({ text: "Échelle de cotation fixée par les passages saisis", ...placement });
        return;
      }
      throw error;
    }
  };

  const compatible = climbDisciplines.filter((option) => items.length === 0 || scaleForDiscipline(option) === scale);
  const primaryDisabled = active.result === null;
  const primaryLabel = editing !== null ? `Corriger ${noun.the} ${editing.index + 1}` : draft.result === null ? "Choisis un résultat" : `Enregistrer ${noun.the} ${nextNumber}`;
  const empty = items.length === 0 && pains.length === 0;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={120}>
        {editing === null ? (
          <View style={styles.context}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Lieu : ${place ?? "non précisé"}`} onPress={() => setSheet("place")} style={styles.where} hitSlop={8}>
              <Text variant="label" tone="secondary" numberOfLines={1}>
                {sports.climb.label} · {place ?? "Ajouter un lieu"}
              </Text>
            </Pressable>
            <Text style={styles.elapsed} tone="secondary" accessibilityLabel={`Durée ${formatHoursMinutes(elapsed)}`}>
              {formatLongClock(elapsed)}
            </Text>
            <LinkButton label="Terminer" onPress={() => setSheet("end")} style={styles.contextLink} />
          </View>
        ) : (
          <View style={styles.context}>
            <Text variant="label" style={styles.editingLabel} numberOfLines={1}>
              Correction {noun.of} {editing.index + 1}
            </Text>
            <LinkButton label="Quitter la correction" onPress={() => setEditing(null)} style={styles.contextLink} />
          </View>
        )}

        <Pressable accessibilityRole="button" accessibilityLabel={`Discipline : ${disciplineLabels[discipline]}, changer`} onPress={() => setSheet("discipline")} style={styles.titleRow}>
          <Text variant="title" accessibilityRole="header">
            {disciplineLabels[discipline]}
          </Text>
          <Icon name="expand" color={colors.text3} />
        </Pressable>
        <Text variant="body" tone="secondary" style={styles.summary}>
          {summaryText(noun, summary)}
        </Text>

        <ScrollView ref={track} horizontal showsHorizontalScrollIndicator={false} style={styles.track} contentContainerStyle={styles.trackContent} accessibilityLabel={`${capitalize(noun.many)} de la séance`}>
          {readItems.map((entry, index) => {
            const level = worst(painsByItem.get(entry.item.id) ?? []);
            const selected = editing?.item.id === entry.item.id;
            return (
              <Pressable
                key={entry.item.id}
                accessibilityRole="button"
                accessibilityLabel={`Corriger ${noun.the} ${index + 1}${entry.values === null ? "" : `, ${entry.values.grade}, ${cellText(entry.values.result, entry.values.attempts)}`}`}
                onPress={() => {
                  if (entry.values === null) return;
                  setEditing({ item: entry.item, index, draft: { grade: entry.values.grade, attempts: entry.values.attempts, result: entry.values.result, style: entry.values.style } });
                }}
                style={({ pressed }) => [
                  styles.attempt,
                  { backgroundColor: selected ? colors.surface2 : pressed ? colors.surfacePress : colors.surface },
                  selected && { borderColor: colors.text, borderWidth: 2 },
                ]}
              >
                <View style={styles.attemptLabel}>
                  <Text style={styles.attemptName} tone="secondary">
                    {itemTitle(noun, index + 1)}
                  </Text>
                  <PainIndicator level={level} />
                </View>
                <Text style={styles.attemptGrade}>{entry.values?.grade ?? "?"}</Text>
                <Text variant="caption" tone="secondary" numberOfLines={1} style={styles.attemptDetail}>
                  {entry.values === null ? "" : cellText(entry.values.result, entry.values.attempts)}
                </Text>
              </Pressable>
            );
          })}
          <View style={[styles.attempt, { backgroundColor: colors.surface2, borderBottomColor: colors.mark, borderBottomWidth: 3 }]}>
            <Text style={styles.attemptName}>{itemTitle(noun, nextNumber)}</Text>
            <Text style={styles.attemptCurrent}>en cours</Text>
          </View>
        </ScrollView>

        <View style={styles.readout}>
          <FigureRow
            left={
              <Figure
                value={active.grade}
                label={`Cotation · ${scaleShortLabels[scale]}`}
                size={active.grade.length > 2 ? 72 : 92}
                accessibilityLabel={`Cotation ${active.grade}, choisir`}
                onPress={() => setSheet("grades")}
              />
            }
            right={<Figure value={String(active.attempts)} label={active.attempts > 1 ? "essais" : "essai"} size={92} accessibilityLabel={`${active.attempts} ${active.attempts > 1 ? "essais" : "essai"}`} />}
          />
          <Comparison strong={comparison.strong} rest={comparison.rest} />
          <View style={styles.adjust}>
            <View style={styles.adjustGroup}>
              <AdjustButton
                label={gradeIndex === 0 ? "–" : (grades[gradeIndex - 1] ?? "–")}
                accessibilityLabel={gradeIndex === 0 ? "Aucune cotation inférieure" : `Passer en ${grades[gradeIndex - 1] ?? ""}`}
                disabled={gradeIndex === 0}
                small
                onPress={() => update({ grade: grades[gradeIndex - 1] ?? active.grade })}
              />
              <AdjustButton
                label={gradeIndex === grades.length - 1 ? "–" : (grades[gradeIndex + 1] ?? "–")}
                accessibilityLabel={gradeIndex === grades.length - 1 ? "Aucune cotation supérieure" : `Passer en ${grades[gradeIndex + 1] ?? ""}`}
                disabled={gradeIndex === grades.length - 1}
                small
                onPress={() => update({ grade: grades[gradeIndex + 1] ?? active.grade })}
              />
            </View>
            <View style={styles.adjustGroup}>
              <AdjustButton label="−1" accessibilityLabel="Un essai de moins" disabled={active.attempts <= 1} onPress={() => update({ attempts: Math.max(1, active.attempts - 1) })} />
              <AdjustButton label="+1" accessibilityLabel="Un essai de plus" onPress={() => update({ attempts: active.attempts + 1, result: active.result === "flash" ? "sent" : active.result })} />
            </View>
          </View>
          <View style={styles.question}>
            <Text variant="sectionTitle" tone="secondary">
              Résultat
            </Text>
            <Chips<ClimbResult>
              label="Résultat"
              multiple={false}
              options={[
                { value: "flash", label: resultLabels.flash, disabled: active.attempts > 1 },
                { value: "sent", label: resultLabels.sent },
                { value: "project", label: resultLabels.project },
              ]}
              selected={active.result === null ? [] : [active.result]}
              onToggle={(value) => update({ result: active.result === value ? null : value })}
            />
          </View>
          <View style={styles.question}>
            <Text variant="sectionTitle" tone="secondary">
              Style
            </Text>
            <Chips<ClimbStyle>
              label={`Style ${noun.of}`}
              multiple
              compact
              options={climbStyles.map((style) => ({ value: style, label: styleLabels[style] }))}
              selected={active.style}
              onToggle={(value) => update({ style: active.style.includes(value) ? active.style.filter((item) => item !== value) : [...active.style, value] })}
            />
          </View>
          {editing === null ? null : (
            <View style={styles.remove}>
              <LinkButton label={`Supprimer ${noun.the} ${editing.index + 1}`} onPress={removeItem} />
            </View>
          )}
        </View>
      </Screen>

      <BottomPanel>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sessionPain === null ? "Signaler une douleur" : `Signaler une douleur, ${sessionPain === "stop" ? "arrêt signalé" : "gêne signalée"}`}
            onPress={() => setSheet("pain")}
            style={({ pressed }) => [styles.painButton, { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }]}
          >
            <Text style={styles.painLabel}>Douleur</Text>
            <View style={styles.painIndicator}>
              <PainIndicator level={sessionPain} />
            </View>
          </Pressable>
          {editing === null ? (
            <PrimaryButton
              label={primaryLabel}
              disabled={primaryDisabled}
              icon={<Icon name="check" size={20} color={primaryDisabled ? colors.text2 : colors.actInk} />}
              onPress={saveItem}
              style={styles.primary}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: primaryDisabled }}
              disabled={primaryDisabled}
              onPress={saveItem}
              style={({ pressed }) => [styles.primary, styles.editButton, { backgroundColor: pressed ? colors.surfacePress : colors.surface2, borderColor: colors.text }]}
            >
              <Icon name="check" size={20} />
              <Text variant="bodyStrong" style={styles.editLabel}>
                {primaryLabel}
              </Text>
            </Pressable>
          )}
        </View>
      </BottomPanel>

      <Sheet open={sheet === "grades"} title="Cotation" onClose={() => setSheet("none")}>
        <GradeGrid
          grades={grades}
          selected={active.grade}
          onSelect={(grade) => {
            update({ grade });
            setSheet("none");
          }}
        />
      </Sheet>

      <PainSheet open={sheet === "pain"} context={capitalize(painTarget.label)} rows={painRows} others={otherZones} onSave={savePains} onClose={() => setSheet("none")} />

      <Sheet open={sheet === "stop"} title={`${stopZones.map(zoneLabel).join(", ")} : arrêt`} context="Douleur enregistrée" onClose={() => setSheet("none")}>
        <View style={styles.choices}>
          <PrimaryButton label="Terminer la séance" onPress={() => setSheet("end")} />
          <ChoiceButton label="Continuer quand même" onPress={() => setSheet("none")} />
        </View>
      </Sheet>

      <Sheet open={sheet === "end"} title="Terminer la séance ?" onClose={() => setSheet("none")}>
        <Text style={styles.endFacts}>
          {formatHoursMinutes(elapsed)} · {summaryText(noun, summary)}
        </Text>
        {pending ? (
          <Text variant="small" tone="secondary" style={styles.endContext}>
            {itemTitle(noun, nextNumber)} non {noun.done("enregistré")}
          </Text>
        ) : null}
        <View style={styles.choices}>
          {pending ? <PrimaryButton label="Enregistrer et terminer" onPress={() => finish(true)} /> : <PrimaryButton label="Terminer et faire le bilan" onPress={() => finish(false)} />}
          {pending ? <ChoiceButton label={`Terminer sans ${noun.this}`} onPress={() => finish(false)} /> : null}
          <ChoiceButton label="Continuer à grimper" onPress={() => setSheet("none")} />
          {empty ? <ChoiceButton label="Abandonner la séance" destructive onPress={discard} /> : null}
        </View>
      </Sheet>

      <Sheet open={sheet === "discipline"} title="Discipline" {...(items.length > 0 ? { context: `Même cotation que les ${noun.many} saisis` } : {})} onClose={() => setSheet("none")}>
        <Choices
          items={compatible.map((option) => ({ value: option, label: disciplineLabels[option], selected: option === discipline }))}
          onChoose={(value) => {
            setSheet("none");
            if (value !== discipline) changeSettings(value, place);
          }}
        />
      </Sheet>

      <TextSheet
        open={sheet === "place"}
        title="Lieu"
        value={place}
        placeholder="Salle ou site"
        onSubmit={(value) => {
          setSheet("none");
          if (value !== place) changeSettings(discipline, value);
        }}
        onClose={() => setSheet("none")}
      />
    </View>
  );
}

interface AdjustButtonProps {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly small?: boolean;
  readonly onPress: () => void;
}

function AdjustButton({ label, accessibilityLabel, disabled = false, small = false, onPress }: AdjustButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.adjustButton, { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }, disabled && styles.disabled]}
    >
      <Text style={small ? styles.adjustSmall : styles.adjustLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  context: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  where: { flex: 1, minHeight: 44, justifyContent: "center" },
  elapsed: { fontFamily: fonts.figure600, fontSize: 17, lineHeight: 20 },
  contextLink: { marginRight: -10 },
  editingLabel: { flex: 1, fontFamily: fonts.text700 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, minHeight: 44, alignSelf: "flex-start" },
  summary: { fontSize: 15 },
  track: { marginTop: 16, borderRadius: radii.panel, flexGrow: 0 },
  trackContent: { gap: 2 },
  attempt: { width: 92, height: 76, paddingVertical: 10, paddingHorizontal: 12, gap: 5 },
  attemptLabel: { flexDirection: "row", alignItems: "center", gap: 6 },
  attemptName: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 12, letterSpacing: 0.5 },
  attemptGrade: { fontFamily: fonts.figure700, fontSize: 21, lineHeight: 22 },
  attemptCurrent: { fontFamily: fonts.text700, fontSize: 17, lineHeight: 21 },
  attemptDetail: { fontFamily: fonts.text500 },
  readout: { marginTop: 20, gap: 16 },
  adjust: { flexDirection: "row", gap: 10 },
  adjustGroup: { flex: 1, flexDirection: "row", gap: 6 },
  adjustButton: { flex: 1, height: 64, borderRadius: radii.control, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center" },
  adjustLabel: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 24 },
  adjustSmall: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 22 },
  disabled: { opacity: 0.4 },
  question: { gap: 8, marginTop: 4 },
  remove: { alignItems: "center" },
  actions: { flexDirection: "row", gap: 10 },
  painButton: { width: 72, height: 64, borderRadius: radii.panel, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center" },
  painLabel: { fontFamily: fonts.text700, fontSize: 14, lineHeight: 16 },
  painIndicator: { position: "absolute", top: 9, right: 9 },
  primary: { flex: 1 },
  editButton: { minHeight: 64, borderRadius: radii.panel, borderWidth: 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  editLabel: { fontFamily: fonts.text700, fontSize: 18 },
  choices: { gap: 8, marginTop: 16 },
  endFacts: { fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25, marginTop: 6, marginBottom: 4 },
  endContext: { marginBottom: 4 },
});
