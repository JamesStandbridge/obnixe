import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import {
  addDays,
  completedSessions,
  currentProgram,
  daysBetween,
  estimatedSlotSeconds,
  finishOpenSessionMutations,
  localClock,
  mondayOf,
  nextSlot,
  openSession,
  resumeDeadlineDate,
  todayNotices,
  variantPlan,
  weekdayIndex,
  weekSummary,
} from "@obnixe/core";
import type { NextSlot, OpenSession, PainCarry, PlanItem, TodayNotices } from "@obnixe/core";
import { settings, sportPreference, sports } from "@obnixe/schema";
import type { Archetype, Id, LocalDate, ProgramSlot, SportKey, SportPreference } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { PainMark, Segmented } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { IconButton, MenuItem } from "@/ui/Inputs";
import { Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { CheckInSection } from "@/features/stats/CheckInSection";
import { capitalize, formatDuration, formatInteger, formatKilograms, formatTimeOf, localDateOf, longDate, lowerFirst, painWords, plural, relativeDay, shortDate, weekdayLong, zoneLabel } from "@/features/stats/format";
import { deviceTimeZone, useLiveValue, useLocalNow } from "@/features/stats/live";
import { sessionTitle, sportLabel } from "@/features/stats/presentation";
import { WeekStrip } from "@/features/stats/WeekStrip";

const bottomPanelHeight = 84;

interface TodayData {
  readonly open: OpenSession | null;
  readonly next: NextSlot | null;
  readonly programId: Id | null;
  readonly programName: string | null;
  readonly sessionsPerWeek: number | null;
  readonly notices: TodayNotices;
  readonly preferences: readonly SportPreference[];
}

function useTodayData(today: LocalDate): TodayData {
  return useLiveValue(
    () => {
      const database = db();
      const current = currentProgram(database);
      const seenAt = database.select({ seenAt: settings.agentChangesSeenAt }).from(settings).get()?.seenAt ?? null;
      return {
        open: openSession(database),
        next: nextSlot(database),
        programId: current?.program.id ?? null,
        programName: current?.version.name ?? null,
        sessionsPerWeek: current?.version.sessionsPerWeek ?? null,
        notices: todayNotices(database, { today, agentChangesSeenAt: seenAt }),
        preferences: database.select().from(sportPreference).all(),
      };
    },
    ["session", "program", "program_version", "program_slot", "program_variant", "rotation_skip", "pain_report", "changeset", "settings", "sport_preference", "strength_set", "session_item"],
    [today],
  );
}

function slotSessionLabel(name: string | null): string {
  const match = name === null ? null : /^séance\s+(.+)$/i.exec(name);
  return match?.[1] === undefined ? "la séance" : `la séance ${match[1]}`;
}

function quickSports(preferences: readonly SportPreference[]): SportKey[] {
  if (preferences.length === 0) return ["run", "hike", "climb"];
  return [...preferences]
    .filter((preference) => preference.enabled && preference.sport !== "strength")
    .sort((left, right) => left.position - right.position)
    .map((preference) => preference.sport)
    .slice(0, 3);
}

function startQuick(sport: SportKey): void {
  if (sport === "climb") router.push({ pathname: "/climb/[id]", params: { id: "new" } });
  else router.push({ pathname: "/log", params: { sport } });
}

function startSlot(slot: ProgramSlot, variantId: Id | null): void {
  const archetype: Archetype = sports[slot.sport].archetype;
  switch (archetype) {
    case "strength":
      router.push({ pathname: "/workout/[id]", params: variantId === null ? { id: "new", slotId: slot.id } : { id: "new", slotId: slot.id, variantId } });
      return;
    case "itemized":
    case "continuous":
      if (slot.sport === "climb") router.push({ pathname: "/climb/[id]", params: { id: "new" } });
      else router.push({ pathname: "/log", params: { sport: slot.sport, slotId: slot.id } });
      return;
    default: {
      const unreachable: never = archetype;
      throw new Error(`Unhandled archetype ${String(unreachable)}`);
    }
  }
}

function resumeOpen(open: OpenSession): void {
  if (open.session.sport === "climb") router.push({ pathname: "/climb/[id]", params: { id: open.session.id } });
  else if (sports[open.session.sport].archetype === "strength") router.push({ pathname: "/workout/[id]", params: { id: open.session.id } });
  else router.push({ pathname: "/session/[id]", params: { id: open.session.id } });
}

function formatPrescription(item: PlanItem): string {
  if (item.repsMin !== null) return `${item.sets} × ${item.repsMax === null || item.repsMax === item.repsMin ? item.repsMin : `${item.repsMin}–${item.repsMax}`}`;
  const min = item.durationMinSeconds ?? 0;
  const max = item.durationMaxSeconds ?? min;
  return `${item.sets} × ${min === max ? min : `${min}–${max}`} s`;
}

function formatLast(item: PlanItem): string | null {
  const top = item.last?.top;
  if (top === undefined) return null;
  if (top.loadGrams !== null && top.loadGrams > 0) return `${formatKilograms(top.loadGrams)} kg`;
  if (top.reps !== null) return `${top.reps} rép.`;
  if (top.durationSeconds !== null) return `${top.durationSeconds} s`;
  return null;
}

export function TodayScreen() {
  const { colors } = useTheme();
  const { today } = useLocalNow();
  const data = useTodayData(today);
  const write = useUndoableWrite();
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [chosenVariant, setChosenVariant] = useState<Id | null>(null);
  const variantId = effectiveVariant(data.next, chosenVariant);
  const isEmpty = data.open === null && data.programId === null;
  const hasBottomPanel = data.open !== null || data.next !== null;
  const snackbarOffset = hasBottomPanel ? bottomPanelHeight : 0;

  const week = useLiveValue(
    () => weekSummary(today, completedSessions(db(), { from: mondayOf(today), to: addDays(mondayOf(today), 6) }), data.sessionsPerWeek),
    ["session"],
    [today, data.sessionsPerWeek],
  );

  const finish = (open: OpenSession): void => {
    write({ summary: "Séance terminée sans reprise", mutations: finishOpenSessionMutations(open), message: "Séance terminée", aboveTabBar: false });
    router.push({ pathname: "/session/[id]/review", params: { id: open.session.id } });
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={hasBottomPanel ? bottomPanelHeight + 36 : 32}>
        <View style={styles.appbar}>
          <Text tone="secondary" style={styles.appbarDate}>
            {capitalize(longDate(today))}
          </Text>
          <IconButton icon="agent" label="Connecter un agent" onPress={() => router.push("/agent")} />
          <IconButton icon="settings" label="Réglages et données" edge="end" onPress={() => router.push("/settings")} />
        </View>

        {data.open !== null ? (
          <ResumeCard open={data.open} onFinish={finish} />
        ) : isEmpty ? (
          <EmptyCard />
        ) : data.next === null ? (
          <View style={styles.next}>
            <Text variant="eyebrow" tone="secondary">
              {data.programName ?? "Programme"}
            </Text>
            <Text accessibilityRole="header" style={styles.nextTitle}>
              Aucune séance prévue
            </Text>
            {data.programId === null ? null : (
              <ControlButton label="Modifier le programme" onPress={() => router.push({ pathname: "/program/[id]", params: { id: data.programId ?? "" } })} style={styles.fullControl} />
            )}
          </View>
        ) : (
          <NextCard next={data.next} variantId={variantId} onVariant={setChosenVariant} notices={data.notices} today={today} onOpenNotices={() => setNoticesOpen(true)} />
        )}

        <Section title={isEmpty ? "Noter une activité" : "Hors programme"}>
          <View style={styles.quick}>
            {quickSports(data.preferences).map((sport) => (
              <ControlButton
                key={sport}
                label={sportLabel(sport)}
                icon={<SportIcon sport={sport} variant="inline" />}
                onPress={() => startQuick(sport)}
                style={styles.quickButton}
              />
            ))}
            <ControlButton
              label="Autre sport"
              icon={<SportIcon sport="new" variant="inline" />}
              onPress={() => router.push({ pathname: "/log", params: { sport: "catalogue" } })}
              style={styles.quickButton}
            />
          </View>
        </Section>

        <CheckInSection today={today} timeZone={deviceTimeZone} snackbarOffset={snackbarOffset} />

        {isEmpty && week.sessionsDone === 0 ? null : (
          <Section title="Cette semaine" action={<LinkButton label="Journal" onPress={() => router.navigate("/journal")} style={styles.sectionLink} />}>
            <WeekStrip days={week.days} />
            <View style={styles.weekSummary}>
              <Text variant="small" tone="secondary">
                <Text style={styles.weekFigure}>{formatInteger(week.sessionsDone)}</Text>
                {week.sessionsPlanned === null ? ` ${week.sessionsDone > 1 ? "séances" : "séance"}` : ` ${week.sessionsDone > 1 ? "séances" : "séance"} sur ${week.sessionsPlanned} prévues`}
              </Text>
              {week.durationSeconds === 0 ? null : <Text style={styles.weekFigure}>{formatDuration(week.durationSeconds)}</Text>}
            </View>
          </Section>
        )}
      </Screen>

      {hasBottomPanel ? (
        <View style={[styles.bottomPanel, { backgroundColor: colors.bg }]}>
          {data.open !== null ? (
            <PrimaryButton label={`Reprendre ${slotSessionLabel(data.open.slotName)}`} icon={<Icon name="play" color={colors.actInk} />} onPress={() => (data.open === null ? undefined : resumeOpen(data.open))} />
          ) : data.next !== null ? (
            <PrimaryButton
              label={`Commencer ${slotSessionLabel(data.next.slot.name)}`}
              icon={<Icon name="play" color={colors.actInk} />}
              onPress={() => (data.next === null ? undefined : startSlot(data.next.slot, variantId))}
            />
          ) : null}
        </View>
      ) : null}

      <NoticesSheet open={noticesOpen} notices={data.notices} today={today} onClose={() => setNoticesOpen(false)} />
    </View>
  );
}

function effectiveVariant(next: NextSlot | null, chosen: Id | null): Id | null {
  if (next === null) return null;
  return next.variants.some((variant) => variant.id === chosen) ? chosen : (next.variants[0]?.id ?? null);
}

function ResumeCard({ open, onFinish }: { readonly open: OpenSession; readonly onFinish: (open: OpenSession) => void }) {
  const { colors } = useTheme();
  const last = localClock(open.lastActivityAt, deviceTimeZone);
  const deadline = resumeDeadlineDate(last);
  const eyebrow = open.session.status === "interrupted" ? `Séance interrompue · ${formatTimeOf(open.lastActivityAt)}` : `Séance en cours · depuis ${formatTimeOf(open.session.startedAt)}`;
  const recorded = open.setCount > 0 ? `${plural(open.setCount, "série enregistrée", "séries enregistrées")}` : open.itemCount > 0 ? plural(open.itemCount, "passage noté", "passages notés") : null;
  const window = `reprise jusqu'à ${deadline === last.date ? "" : "demain "}6 h`;
  return (
    <View style={[styles.resume, { backgroundColor: colors.surface, borderLeftColor: colors.mark }]}>
      <Text variant="eyebrow" tone="secondary">
        {eyebrow}
      </Text>
      <Text accessibilityRole="header" style={styles.resumeTitle}>
        {sessionTitle({ sport: open.session.sport, title: open.session.title, slotName: open.slotName, variantName: open.variantName, values: open.session.values })}
      </Text>
      <Text tone="secondary" style={styles.resumeText}>
        {[recorded, window].filter((part): part is string => part !== null).join(" · ")}
      </Text>
      <ControlButton label="Terminer sans reprendre" onPress={() => onFinish(open)} style={styles.resumeFinish} />
    </View>
  );
}

function EmptyCard() {
  return (
    <View style={styles.next}>
      <Text variant="eyebrow" tone="secondary">
        Aucun programme
      </Text>
      <Text accessibilityRole="header" style={styles.nextTitle}>
        Note ce que tu fais
      </Text>
      <View style={styles.emptyActions}>
        <ControlButton label="Créer un programme" onPress={() => router.push({ pathname: "/program/[id]", params: { id: "new" } })} style={styles.emptyAction} />
        <ControlButton label="Connecter un agent" onPress={() => router.push("/agent")} style={styles.emptyAction} />
      </View>
    </View>
  );
}

interface NextCardProps {
  readonly next: NextSlot;
  readonly variantId: Id | null;
  readonly onVariant: (variantId: Id) => void;
  readonly notices: TodayNotices;
  readonly today: LocalDate;
  readonly onOpenNotices: () => void;
}

function NextCard({ next, variantId, onVariant, notices, today, onOpenNotices }: NextCardProps) {
  const { colors } = useTheme();
  const variant = next.variants.find((item) => item.id === variantId) ?? null;
  const plan = useLiveValue(() => (variantId === null ? [] : variantPlan(db(), variantId)), ["program_item", "exercise", "exercise_zone", "strength_set", "session"], [variantId]);
  const duration = estimatedSlotSeconds(next.slot, plan);
  const isStrength = sports[next.slot.sport].archetype === "strength";
  const meta = [isStrength && plan.length > 0 ? plural(plan.length, "exercice") : null, duration === null ? null : formatDuration(duration)].filter((part): part is string => part !== null).join(" · ");
  const stopZones = new Set(notices.pains.filter((pain) => pain.level === "stop").map((pain) => pain.zone));
  const affected = (pain: PainCarry): boolean => plan.some((item) => item.zones.includes(pain.zone));
  const others = otherPoints(notices, today, notices.pains.length > 0);

  return (
    <View style={styles.next}>
      <Text variant="eyebrow" tone="secondary">
        {`Prochaine séance · ${next.current.version.name}`}
      </Text>
      <Text accessibilityRole="header" style={styles.nextTitle}>
        {variant === null ? next.slot.name : `${next.slot.name} · ${variant.name}`}
      </Text>
      {meta === "" ? null : <Text tone="secondary">{meta}</Text>}
      {next.variants.length > 1 ? (
        <View style={styles.variants} accessibilityLabel="Variante">
          <Segmented<Id> options={next.variants.map((item) => ({ value: item.id, label: item.name }))} value={variantId} onChange={onVariant} />
        </View>
      ) : null}

      {notices.pains.length === 0 && others.count === 0 ? null : (
        <View style={styles.notices}>
          {notices.pains.map((pain) => (
            <View key={pain.zone} style={[styles.notice, { backgroundColor: colors.surface }]} accessible accessibilityLabel={`${zoneLabel(pain.zone)} : ${painWords[pain.level]} ${relativeDay(pain.localDate, today)}`}>
              <PainMark level={pain.level} />
              <View style={styles.noticeText}>
                <Text style={styles.noticeTitle}>{`${zoneLabel(pain.zone)} : ${painWords[pain.level]} ${relativeDay(pain.localDate, today)}`}</Text>
                {pain.level === "stop" && affected(pain) ? (
                  <Text variant="caption" tone="secondary" style={styles.noticeDetail}>
                    progression suspendue
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
          {others.count === 0 ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${others.title}, ${others.detail}. Voir`}
              onPress={onOpenNotices}
              style={({ pressed }) => [styles.notice, { backgroundColor: pressed ? colors.surfacePress : colors.surface }]}
            >
              <View style={[styles.noticeMark, { borderColor: colors.warn }]} />
              <View style={styles.noticeText}>
                <Text style={styles.noticeTitle}>{others.title}</Text>
                <Text variant="caption" tone="secondary" style={styles.noticeDetail}>
                  {others.detail}
                </Text>
              </View>
              <Text variant="label" style={styles.noticeLink}>
                Voir
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {plan.length === 0 ? null : (
        <View style={styles.plan}>
          {plan.map((item, index) => {
            const suspended = item.zones.some((zone) => stopZones.has(zone));
            const last = formatLast(item);
            return (
              <View key={item.itemId} style={[styles.planRow, { borderBottomColor: colors.line, borderBottomWidth: index === plan.length - 1 ? 0 : 1 }]}>
                <Text tone="tertiary" style={styles.planIndex}>
                  {index + 1}
                </Text>
                <View style={styles.planMain}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {item.name}
                  </Text>
                  {suspended ? (
                    <View style={styles.planFlag}>
                      <PainMark level="stop" />
                      <Text variant="small" tone="secondary">
                        à confirmer
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={styles.planValue}>
                  <Text tone="secondary" style={styles.planPrescription}>
                    {formatPrescription(item)}
                  </Text>
                  {last === null ? null : (
                    <Text variant="caption" tone="tertiary" accessibilityLabel={`dernière charge ${last}`}>
                      {last}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      {next.after === null ? null : (
        <View style={styles.then}>
          <SportIcon sport={next.after.sport} variant="inline" color={colors.text2} />
          <Text variant="small" tone="secondary">
            {`Ensuite : ${lowerFirst(next.after.name)}${next.after.targetDurationSeconds === null ? "" : ` ${formatDuration(next.after.targetDurationSeconds)}`}`}
          </Text>
        </View>
      )}
    </View>
  );
}

interface OtherPoints {
  readonly count: number;
  readonly title: string;
  readonly detail: string;
}

function otherPoints(notices: TodayNotices, today: LocalDate, afterPains: boolean): OtherPoints {
  const parts: string[] = [];
  if (notices.agent !== null) parts.push(`${notices.agent.client ?? "Agent"} ${relativeDay(localDateOf(notices.agent.latestAt), today)}`);
  const firstReview = notices.reviews[0];
  if (notices.reviews.length === 1 && firstReview !== undefined) parts.push(lowerFirst(reviewLabel(firstReview.localDate, today)));
  if (notices.reviews.length > 1) parts.push(plural(notices.reviews.length, "bilan"));
  const count = (notices.agent === null ? 0 : 1) + notices.reviews.length;
  const title = afterPains ? (count > 1 ? `${count} autres points` : "1 autre point") : count > 1 ? `${count} points à voir` : "1 point à voir";
  return { count, title, detail: parts.join(" · ") };
}

function reviewLabel(date: LocalDate, today: LocalDate): string {
  const days = daysBetween(date, today);
  if (days === 0) return "Bilan du jour";
  if (days > 0 && days < 7) return `Bilan de ${weekdayLong[weekdayIndex(date)] ?? shortDate(date)}`;
  return `Bilan du ${shortDate(date)}`;
}

interface NoticesSheetProps {
  readonly open: boolean;
  readonly notices: TodayNotices;
  readonly today: LocalDate;
  readonly onClose: () => void;
}

function NoticesSheet({ open, notices, today, onClose }: NoticesSheetProps) {
  const openAgentLog = (): void => {
    db().update(settings).set({ agentChangesSeenAt: environment.now(), updatedAt: environment.now() }).run();
    onClose();
    router.push("/agent/log");
  };
  return (
    <Sheet open={open} title="À voir" onClose={onClose}>
      <View style={styles.menu}>
        {notices.agent === null ? null : (
          <MenuItem
            label={`${plural(notices.agent.count, "modification")} de ${notices.agent.client ?? "l'agent"}`}
            detail={relativeDay(localDateOf(notices.agent.latestAt), today)}
            onPress={openAgentLog}
          />
        )}
        {notices.reviews.map((review) => (
          <MenuItem
            key={review.sessionId}
            label={reviewLabel(review.localDate, today)}
            detail="à compléter"
            onPress={() => {
              onClose();
              router.push({ pathname: "/session/[id]/review", params: { id: review.sessionId } });
            }}
          />
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  appbarDate: { flex: 1, fontFamily: fonts.text600, fontSize: 15 },
  next: { marginTop: 18, gap: 6 },
  nextTitle: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 32, letterSpacing: -0.6 },
  variants: { marginTop: 10 },
  notices: { marginTop: 10, gap: 2, borderRadius: radii.panel, overflow: "hidden" },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingVertical: 6, paddingLeft: 12, paddingRight: 4 },
  noticeText: { flex: 1, minWidth: 0 },
  noticeTitle: { fontFamily: fonts.text600, fontSize: 14, lineHeight: 18 },
  noticeDetail: { fontFamily: fonts.text500 },
  noticeMark: { width: 8, height: 8, borderWidth: 2, transform: [{ rotate: "45deg" }] },
  noticeLink: { fontFamily: fonts.text700, textDecorationLine: "underline", paddingHorizontal: 10, minHeight: 44, lineHeight: 44 },
  plan: { marginTop: 8 },
  planRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 8 },
  planIndex: { width: 22, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 16 },
  planMain: { flex: 1, minWidth: 0, gap: 3 },
  planFlag: { flexDirection: "row", alignItems: "center", gap: 6 },
  planValue: { alignItems: "flex-end", gap: 2 },
  planPrescription: { fontFamily: fonts.figure700, fontSize: 16, lineHeight: 18 },
  then: { marginTop: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  resume: { marginTop: 18, padding: 16, borderRadius: radii.panel, borderLeftWidth: 3, gap: 6 },
  resumeTitle: { fontFamily: fonts.text700, fontSize: 26, lineHeight: 29, letterSpacing: -0.4 },
  resumeText: { fontSize: 15 },
  resumeFinish: { marginTop: 14 },
  fullControl: { marginTop: 12 },
  emptyActions: { marginTop: 18, flexDirection: "row", gap: 8 },
  emptyAction: { flex: 1 },
  quick: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  quickButton: { width: "48.9%", flexGrow: 1, minHeight: 56, justifyContent: "flex-start", gap: 10, paddingHorizontal: 12 },
  sectionLink: { marginVertical: -12, marginRight: -10 },
  weekSummary: { marginTop: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  weekFigure: { fontFamily: fonts.figure700, fontSize: 16, lineHeight: 18 },
  bottomPanel: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: layout.gutter, paddingVertical: 10 },
  menu: { marginTop: 8 },
});
