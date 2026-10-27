import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { daysBetween, latestPainByZone, loadSessionReport, localDateOf, nextSlot, openSlotsOfSport, reviewMutations, rotationChoice, trackedZones, worstLevel } from "@obnixe/core";
import type { PainAnchor, RotationChoice, SessionReport } from "@obnixe/core";
import { sports, zoneKeys } from "@obnixe/schema";
import type { Effort, EpochMs, Id, LocalDate, MassUnit, PainLevel, PainReport, ProgramSlot, Sensation, Session, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { effortLabels, formatDay, formatTime, painPhrases, sensationLabels } from "@/features/training/format";
import { capitalize, lowerFirst, plural, sessionTitle, zoneLabel } from "@/format/labels";
import { formatClock } from "@/format/durations";
import { Message } from "@/features/training/Message";
import { climbFacts, climbItemWord, continuousIndicators, durationText, fieldValueText, outcomeText, setsFact, strengthValue, titleSource } from "@/features/training/sessionText";
import { useLiveLoad } from "@/features/training/useLiveLoad";
import { positioned, SlotMenuItem, useAttachSession } from "@/features/training/attach";
import type { PositionedSlot } from "@/features/training/attach";
import { deviceTimeZone } from "@/format/dates";
import { useMassUnit } from "@/data/settings";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { PainMark, Switch } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { Choices, MenuItem, Question, Scale, TextField, ZoneRow } from "@/ui/Inputs";
import type { ScaleOption } from "@/ui/Inputs";
import { Row, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout } from "@/ui/tokens";

interface AttachOffer {
  readonly programName: string;
  readonly slots: readonly PositionedSlot[];
}

interface ReviewData {
  readonly report: SessionReport;
  readonly choice: RotationChoice | null;
  readonly offer: AttachOffer | null;
  readonly tracked: readonly ZoneKey[];
  readonly latest: ReadonlyMap<ZoneKey, PainReport>;
}

function attachOffer(current: Session): AttachOffer | null {
  if (current.slotId !== null || current.status !== "completed") return null;
  const next = nextSlot(db());
  if (next === null) return null;
  const open = openSlotsOfSport(next, current.sport);
  return open.length === 0 ? null : { programName: next.current.version.name, slots: positioned(next.cycle, open) };
}

function loadReview(sessionId: Id): ReviewData | null {
  const now = environment.now();
  const report = loadSessionReport(db(), sessionId, now);
  if (report === null) return null;
  return { report, choice: rotationChoice(db(), report.data.session), offer: attachOffer(report.data.session), tracked: trackedZones(db()), latest: latestPainByZone(db(), now) };
}

type AttachPrompt = "closed" | "ask" | "choose";
type AttachAnswer = "yes" | "choose" | "no";

const effortOptions: readonly ScaleOption<Effort>[] = (Object.keys(effortLabels) as Effort[]).map((value) => ({ value, label: effortLabels[value] }));
const sensationOptions: readonly ScaleOption<Sensation>[] = (Object.keys(sensationLabels) as Sensation[]).map((value) => ({ value, label: sensationLabels[value] }));
const enjoymentOptions: readonly ScaleOption<number>[] = [
  { value: 1, label: "1", caption: "corvée" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5", caption: "excellent" },
];

interface ReviewScreenProps {
  readonly sessionId: Id;
  readonly offerAttach: boolean;
}

export function ReviewScreen({ sessionId, offerAttach }: ReviewScreenProps) {
  const data = useLiveLoad(() => loadReview(sessionId), [sessionId]);
  if (data === null || data.report.data.session.deletedAt !== null) return <Message title="Séance introuvable" detail="Elle a été supprimée ou n'existe pas." action={null} />;
  const { session } = data.report.data;
  if (session.status !== "completed") {
    return (
      <Message
        title="Séance en cours"
        detail="Le bilan se fait une fois la séance terminée."
        action={{
          label: "Reprendre la séance",
          run: () => router.replace(session.sport === "climb" ? { pathname: "/climb/[id]", params: { id: session.id } } : { pathname: "/workout/[id]", params: { id: session.id } }),
        }}
      />
    );
  }
  return <ReviewForm data={data} offerAttach={offerAttach} />;
}

function anchorText(anchor: PainAnchor | undefined, itemWord: string): string {
  if (anchor === undefined) return "";
  switch (anchor.kind) {
    case "set":
      return `série ${anchor.setIndex + 1}`;
    case "item":
      return `${itemWord} ${anchor.itemIndex + 1}`;
    case "phase":
      return "";
    default: {
      const unreachable: never = anchor;
      return unreachable;
    }
  }
}

interface ZoneEntry {
  readonly zone: ZoneKey;
  readonly detail: string | undefined;
}

function reviewZones(data: ReviewData, today: LocalDate): readonly ZoneEntry[] {
  const { report } = data;
  const itemWord = climbItemWord(report.data.session).singular;
  const sessionPains = report.data.pains.filter((pain) => pain.phase !== "end");
  const endZones = report.data.pains.filter((pain) => pain.phase === "end").map((pain) => pain.zone);
  const zones = [...new Set([...sessionPains.map((pain) => pain.zone), ...data.tracked, ...endZones])];
  return zones.map((zone) => {
    const own = sessionPains.filter((pain) => pain.zone === zone);
    const level = worstLevel(own.map((pain) => pain.level));
    if (level !== null) {
      const worst = [...own].reverse().find((pain) => pain.level === level);
      const where = anchorText(worst === undefined ? undefined : report.painAnchors.get(worst.id), itemWord);
      return { zone, detail: where === "" ? painPhrases[level] : `${painPhrases[level]}, ${where}` };
    }
    const latest = data.latest.get(zone);
    if (latest === undefined || latest.level === "none" || latest.sessionId === report.data.session.id) return { zone, detail: undefined };
    const days = daysBetween(latest.localDate, today);
    return { zone, detail: days <= 0 ? `${painPhrases[latest.level]} aujourd'hui` : `${painPhrases[latest.level]} il y a ${days} j` };
  });
}

interface DoneRow {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly mark: "discomfort" | "stop" | null;
  readonly value: string;
  readonly valueDetail: string;
}

function doneRows(report: SessionReport, today: LocalDate, unit: MassUnit): readonly DoneRow[] {
  const { session } = report.data;
  if (session.sport === "strength") {
    return report.exercises.map((exercise) => {
      const value = strengthValue(exercise, unit);
      const setIds = new Set(exercise.exercise.sets.map((set) => set.id));
      const mark = exercise.outcome.kind === "stopped" ? (worstLevel(report.data.pains.filter((pain) => pain.strengthSetId !== null && setIds.has(pain.strengthSetId)).map((pain) => pain.level)) ?? "stop") : null;
      return { key: exercise.exercise.entry.id, title: exercise.exercise.exercise.name, detail: outcomeText(exercise.outcome, exercise.exercise.exercise.loadMode, today, unit, true), mark, value: value.value, valueDetail: value.detail };
    });
  }
  if (report.climb !== null) {
    const word = climbItemWord(session);
    return report.climb.groups.map((group) => ({
      key: group.label,
      title: group.lowest === null ? group.label : `${group.lowest} à ${group.label}`,
      detail: plural(group.count, word.singular, word.plural),
      mark: null,
      value: group.sent === 0 ? "pas encore" : group.flash === group.sent ? `${group.flash} flash` : plural(group.sent, "enchaîné", "enchaînés"),
      valueDetail: group.sent === 0 || group.flash === group.sent ? (group.sent === 0 ? plural(group.attempts, "essai", "essais") : "") : group.flash > 0 ? `${group.flash} flash` : plural(group.attempts, "essai", "essais"),
    }));
  }
  return sports[session.sport].sessionFields.flatMap((field) => {
    const text = fieldValueText(field, session.values[field.key], unit);
    return text === null ? [] : [{ key: field.key, title: field.label, detail: "", mark: null, value: text, valueDetail: "" }];
  });
}

function factsFor(report: SessionReport, now: EpochMs): string {
  const { session } = report.data;
  const duration = durationText(session, now);
  if (session.sport === "strength") {
    const facts = [duration, setsFact(report.summary)];
    if (report.summary.averageRestSeconds !== null) facts.push(`repos ${formatClock(report.summary.averageRestSeconds)}`);
    return facts.join(" · ");
  }
  if (report.climb !== null) return [duration, ...climbFacts(report.climb, climbItemWord(session))].join(" · ");
  const distance = session.values.distance;
  const distanceField = sports[session.sport].sessionFields.find((field) => field.key === "distance");
  const distanceText = distanceField === undefined ? null : fieldValueText(distanceField, distance, "kg");
  return [duration, ...(distanceText === null ? [] : [distanceText]), ...continuousIndicators(session, now)].join(" · ");
}

interface ReviewFormProps {
  readonly data: ReviewData;
  readonly offerAttach: boolean;
}

function ReviewForm({ data, offerAttach }: ReviewFormProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const unit = useMassUnit();
  const undoableWrite = useUndoableWrite();
  const { report, choice } = data;
  const { session } = report.data;
  const now = environment.now();
  const today = localDateOf(now, deviceTimeZone());
  const [effort, setEffort] = useState<Effort | null>(session.effort);
  const [sensation, setSensation] = useState<Sensation | null>(session.sensation);
  const [enjoyment, setEnjoyment] = useState<number | null>(session.enjoyment);
  const [note, setNote] = useState(session.note ?? "");
  const [counts, setCounts] = useState(session.countsInRotation);
  const endPains = report.data.pains.filter((pain) => pain.phase === "end");
  const [pains, setPains] = useState<ReadonlyMap<ZoneKey, PainLevel | null>>(() => new Map(endPains.map((pain) => [pain.zone, pain.level])));
  const [extraZones, setExtraZones] = useState<readonly ZoneKey[]>([]);
  const [showOther, setShowOther] = useState(false);
  const [panelHeight, setPanelHeight] = useState(100);
  const [prompt, setPrompt] = useState<AttachPrompt>(offerAttach && data.offer !== null ? "ask" : "closed");
  const attach = useAttachSession();

  const listed = reviewZones(data, today);
  const listedKeys = [...listed.map((entry) => entry.zone), ...extraZones];
  const zones: readonly ZoneEntry[] = [...listed, ...extraZones.filter((zone) => !listed.some((entry) => entry.zone === zone)).map((zone) => ({ zone, detail: undefined }))];
  const otherZones = [...new Set([...sports[session.sport].painZones, ...zoneKeys])].filter((zone) => !listedKeys.includes(zone));
  const title = sessionTitle(titleSource(report));
  const rows = doneRows(report, today, unit);
  const ended = session.endedAt ?? session.startedAt;
  const offer = data.offer;
  const proposed = offer?.slots[0] ?? null;

  const attachTo = (slot: ProgramSlot): void => {
    setPrompt("closed");
    setCounts(true);
    attach({ session, slot, title, extraOffset: panelHeight });
  };

  const answer = (value: AttachAnswer): void => {
    switch (value) {
      case "yes":
        if (proposed !== null) attachTo(proposed.entry.slot);
        return;
      case "choose":
        setPrompt("choose");
        return;
      case "no":
        setPrompt("closed");
        return;
      default: {
        const unreachable: never = value;
        throw new Error(`Unhandled answer ${String(unreachable)}`);
      }
    }
  };

  const save = (): void => {
        undoableWrite({
      summary: `Bilan : ${title}`,
      mutations: reviewMutations({
        session,
        effort,
        sensation,
        enjoyment,
        note,
        countsInRotation: choice === null ? session.countsInRotation : counts,
        pains: [...pains.entries()].map(([zone, level]) => ({ zone, level })),
        existingEndPains: endPains,
        tracked: data.tracked,
        now: environment.now(),
        newId: environment.newId,
      }),
      message: "Bilan enregistré",
      aboveTabBar: true,
    });
    router.dismissTo("/");
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 14, paddingHorizontal: layout.gutter, paddingBottom: panelHeight + 32 }} keyboardShouldPersistTaps="handled">
        <View style={styles.appbar}>
          <Text style={styles.when} tone="secondary">
            {capitalize(formatDay(session.localDate))} · {formatTime(ended, session.timeZone)}
          </Text>
          <LinkButton label="Plus tard" onPress={() => router.dismissTo("/")} style={styles.later} />
        </View>

        <View style={styles.head}>
          <Text variant="eyebrow" tone="secondary">
            Bilan
          </Text>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <Text style={styles.facts}>{factsFor(report, now)}</Text>
        </View>

        <Section
          title="Ressenti"
          action={
            <Text variant="small" tone="secondary">
              facultatif
            </Text>
          }
        >
          <Question title="Effort">
            <Scale label="Effort" options={effortOptions} value={effort} onChange={setEffort} words optional />
          </Question>
          <Question title="Sensation">
            <Scale label="Sensation physique" options={sensationOptions} value={sensation} onChange={setSensation} words optional />
          </Question>
          <Question title="Plaisir">
            <Scale label="Plaisir, de 1 (corvée) à 5 (excellent)" options={enjoymentOptions} value={enjoyment} onChange={setEnjoyment} optional />
          </Question>
        </Section>

        <Section title="Douleurs maintenant">
          <View>
            {zones.map((entry, index) => (
              <View key={entry.zone} style={index === 0 ? styles.firstZone : undefined}>
                <ZoneRow
                  name={zoneLabel(entry.zone)}
                  {...(entry.detail === undefined ? {} : { detail: entry.detail })}
                  value={pains.get(entry.zone) ?? null}
                  onChange={(level) => {
                    const next = new Map(pains);
                    next.set(entry.zone, level);
                    setPains(next);
                  }}
                />
              </View>
            ))}
            {showOther ? (
              otherZones.map((zone) => (
                <ZoneRow
                  key={zone}
                  name={zoneLabel(zone)}
                  value={pains.get(zone) ?? null}
                  onChange={(level) => {
                    const next = new Map(pains);
                    next.set(zone, level);
                    setPains(next);
                    if (!extraZones.includes(zone)) setExtraZones([...extraZones, zone]);
                  }}
                />
              ))
            ) : (
              <Pressable accessibilityRole="button" onPress={() => setShowOther(true)} style={({ pressed }) => [styles.other, { borderTopColor: colors.line }, zones.length === 0 && styles.firstZone, pressed && { backgroundColor: colors.surface }]}>
                <Text style={styles.otherLabel} tone="secondary">
                  {zones.length === 0 ? "Signaler une zone…" : "Autre zone…"}
                </Text>
              </Pressable>
            )}
          </View>
        </Section>

        <Section title="Réalisé" action={<LinkButton label="Corriger" onPress={() => router.push({ pathname: "/session/[id]", params: { id: session.id } })} style={styles.sectionLink} />}>
          {rows.length === 0 ? (
            <Text tone="secondary" style={styles.empty}>
              Rien d'enregistré
            </Text>
          ) : (
            rows.map((row, index) => (
              <Row
                key={row.key}
                title={row.title}
                detail={
                  <View style={styles.detail}>
                    {row.mark === null ? null : <PainMark level={row.mark} />}
                    <Text variant="small" tone="secondary">
                      {row.detail}
                    </Text>
                  </View>
                }
                value={row.value}
                {...(row.valueDetail === "" ? {} : { valueDetail: row.valueDetail })}
                last={index === rows.length - 1}
              />
            ))
          )}
        </Section>

        <Section title="Note">
          <TextField value={note} onChangeText={setNote} placeholder="Note libre" accessibilityLabel="Note" multiline style={styles.note} />
          {choice === null ? null : (
            <Pressable accessibilityRole="switch" accessibilityState={{ checked: counts }} onPress={() => setCounts(!counts)} style={styles.program}>
              <View style={styles.programText}>
                <Text variant="bodyStrong">Compte comme {lowerFirst(choice.slot.name)}</Text>
                {choice.next === null ? null : (
                  <Text variant="small" tone="secondary">
                    puis {lowerFirst(choice.next.name)}
                  </Text>
                )}
              </View>
              <View pointerEvents="none" aria-hidden>
                <Switch value={counts} onChange={setCounts} label={`Compte comme ${lowerFirst(choice.slot.name)}`} />
              </View>
            </Pressable>
          )}
        </Section>
      </ScrollView>

      <View onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)} style={[styles.panel, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>
        <PrimaryButton label="Enregistrer le bilan" icon={<Icon name="check" color={colors.actInk} />} onPress={save} />
      </View>

      <Sheet
        open={prompt !== "closed" && offer !== null && proposed !== null}
        title={prompt === "choose" || proposed === null ? "Compter comme…" : `Compter comme ${proposed.entry.slot.name} ?`}
        context={offer === null || proposed === null ? "" : prompt === "choose" ? `${offer.programName} · à faire dans ce cycle` : `${offer.programName} · séance ${proposed.position}, ${proposed.entry.state.kind === "next" ? "la prochaine" : "à faire dans ce cycle"}`}
        onClose={() => setPrompt("closed")}
      >
        {offer === null ? null : prompt === "choose" ? (
          <View style={styles.menu}>
            {offer.slots.map((slot) => (
              <SlotMenuItem key={slot.entry.slot.id} slot={slot} today={today} onPress={() => attachTo(slot.entry.slot)} />
            ))}
            <MenuItem label="Hors programme" detail="Ne compte pas dans la rotation" onPress={() => setPrompt("closed")} />
          </View>
        ) : (
          <Choices<AttachAnswer>
            items={[{ value: "yes", label: "Oui", primary: true }, ...(offer.slots.length > 1 ? [{ value: "choose" as const, label: "Une autre séance du programme" }] : []), { value: "no", label: "Non, hors programme" }]}
            onChoose={answer}
          />
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  when: { flex: 1, fontFamily: fonts.text600, fontSize: 15 },
  later: { marginRight: -10 },
  head: { marginTop: 14, gap: 6 },
  title: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 32, letterSpacing: -0.6 },
  facts: { marginTop: 4, fontFamily: fonts.figure700, fontSize: 19, lineHeight: 25 },
  firstZone: { marginTop: -1 },
  other: { minHeight: 48, borderTopWidth: 1, alignItems: "center", justifyContent: "center" },
  otherLabel: { fontFamily: fonts.text600, fontSize: 16 },
  sectionLink: { marginVertical: -12, marginRight: -10 },
  detail: { flexDirection: "row", alignItems: "center", gap: 6 },
  empty: { paddingVertical: 14 },
  note: { marginTop: 10 },
  program: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 10 },
  programText: { flex: 1, gap: 3 },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingTop: 10, paddingHorizontal: layout.gutter },
  menu: { marginTop: 8 },
});
