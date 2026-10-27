import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import {
  addDays,
  completedSessions,
  currentProgram,
  daysBetween,
  emphasisQuantity,
  estimatedSlotSeconds,
  finishOpenSessionMutations,
  lastSessionSuggestion,
  localDateOf,
  localTimeOf,
  mondayOf,
  nextSlot,
  openSession,
  resumeDeadlineDate,
  todayNotices,
  variantPlan,
  weekdayIndex,
  weekSummary,
} from "@obnixe/core";
import type { NextSlot, OpenSession, PainCarry, PlanItem, SessionSuggestion, TodayNotices } from "@obnixe/core";
import { settings, sportPreference, sports } from "@obnixe/schema";
import type { Archetype, Id, LocalDate, ProgramSlot, SportKey, SportPreference } from "@obnixe/schema";
import { db } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { ControlButton, PrimaryButton } from "@/ui/Button";
import { PainMark, Segmented } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { IconButton, MenuItem } from "@/ui/Inputs";
import { Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii, wash } from "@/ui/tokens";
import { formatAgo } from "@/features/activity/format";
import { markAgentChangesSeen } from "@/features/agent/queries";
import { CheckInSection } from "@/features/stats/CheckInSection";
import { durationFigure, formatDuration, formatKilograms, longDate, painWords } from "@/features/stats/format";
import { capitalize, lowerFirst, plural, sessionTitle, zoneLabel } from "@/format/labels";
import { formatInteger } from "@/format/numbers";
import { deviceTimeZone, formatTimeAt, relativeDay, shortDate, weekdayLong } from "@/format/dates";
import { useLiveValue, useLocalNow } from "@/features/stats/live";
import { distanceFigure, sportLabel } from "@/features/stats/presentation";
import { WeekHero } from "@/features/stats/WeekStrip";

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

        {isEmpty && week.sessionsDone === 0 ? null : <WeekHero week={week} onJournal={() => router.navigate("/journal")} />}

        {data.open !== null ? (
          <ResumeCard open={data.open} onFinish={finish} />
        ) : isEmpty ? (
          <EmptyCard />
        ) : data.next === null ? (
          <Card>
            <Text variant="eyebrow" tone="secondary">
              {data.programName ?? "Programme"}
            </Text>
            <Text accessibilityRole="header" style={styles.cardTitle}>
              Aucune séance prévue
            </Text>
            {data.programId === null ? null : (
              <ControlButton label="Modifier le programme" onPress={() => router.push({ pathname: "/program/[id]", params: { id: data.programId ?? "" } })} style={styles.fullControl} />
            )}
          </Card>
        ) : (
          <NextCard next={data.next} variantId={variantId} onVariant={setChosenVariant} notices={data.notices} today={today} onOpenNotices={() => setNoticesOpen(true)} />
        )}

        <Section title={isEmpty ? "Noter une activité" : "Hors programme"}>
          <QuickLog sports={quickSports(data.preferences)} today={today} />
        </Section>

        <CheckInSection today={today} timeZone={deviceTimeZone()} snackbarOffset={snackbarOffset} />
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

interface CardProps {
  readonly sport?: SportKey;
  readonly children: ReactNode;
}

function Card({ sport, children }: CardProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface }]}>
      {sport === undefined ? null : <View style={[styles.cardAccent, { backgroundColor: colors.sport[sport] }]} />}
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

interface CardHeadProps {
  readonly sport: SportKey;
  readonly eyebrow: string;
  readonly detail: string | null;
  readonly live?: boolean;
}

function CardHead({ sport, eyebrow, detail, live = false }: CardHeadProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.cardHead}>
      <SportIcon sport={sport} variant="badge" />
      <View style={styles.cardHeadText}>
        <View style={styles.eyebrowRow}>
          {live ? <View style={[styles.liveDot, { backgroundColor: colors.mark }]} /> : null}
          <Text variant="eyebrow" style={{ color: colors.sport[sport] }} numberOfLines={1}>
            {eyebrow}
          </Text>
        </View>
        {detail === null ? null : (
          <Text variant="small" tone="secondary" numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
    </View>
  );
}

function ResumeCard({ open, onFinish }: { readonly open: OpenSession; readonly onFinish: (open: OpenSession) => void }) {
  const last = localTimeOf(open.lastActivityAt, deviceTimeZone());
  const deadline = resumeDeadlineDate(last);
  const interrupted = open.session.status === "interrupted";
  const eyebrow = interrupted ? "Séance interrompue" : "Séance en cours";
  const detail = interrupted ? `Dernière action à ${formatTimeAt(open.lastActivityAt, deviceTimeZone())}` : `Depuis ${formatTimeAt(open.session.startedAt, deviceTimeZone())}`;
  const recorded: StatValue | null =
    open.setCount > 0
      ? { label: open.setCount > 1 ? "Séries notées" : "Série notée", value: formatInteger(open.setCount), unit: "" }
      : open.itemCount > 0
        ? { label: open.itemCount > 1 ? "Passages notés" : "Passage noté", value: formatInteger(open.itemCount), unit: "" }
        : null;
  const window: StatValue = { label: deadline === last.date ? "Reprise jusqu'à" : "Reprise jusqu'à demain", value: "6 h", unit: "" };
  return (
    <Card sport={open.session.sport}>
      <CardHead sport={open.session.sport} eyebrow={eyebrow} detail={detail} live={!interrupted} />
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {sessionTitle({ sport: open.session.sport, title: open.session.title, slotName: open.slotName, variantName: open.variantName, values: open.session.values })}
      </Text>
      <StatRow stats={recorded === null ? [window] : [recorded, window]} style={styles.cardStats} />
      <ControlButton label="Terminer sans reprendre" onPress={() => onFinish(open)} style={styles.fullControl} />
    </Card>
  );
}

interface ActionCardProps {
  readonly icon: IconName;
  readonly title: string;
  readonly detail: string;
  readonly onPress: () => void;
}

function ActionCard({ icon, title, detail, onPress }: ActionCardProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.action, { backgroundColor: pressed ? colors.surfacePress : colors.surface }]}
    >
      <View style={[styles.actionIcon, { backgroundColor: wash(colors.mark, 0.14) }]}>
        <Icon name={icon} color={colors.mark} />
      </View>
      <View style={styles.actionText}>
        <Text variant="bodyStrong">{title}</Text>
        <Text variant="small" tone="secondary">
          {detail}
        </Text>
      </View>
      <Icon name="forward" size={18} color={colors.text3} />
    </Pressable>
  );
}

function EmptyCard() {
  return (
    <View style={styles.empty}>
      <Text variant="eyebrow" tone="secondary">
        Aucun programme
      </Text>
      <Text accessibilityRole="header" style={styles.emptyTitle}>
        Note ce que tu fais
      </Text>
      <Text tone="secondary" style={styles.emptyLead}>
        Chaque séance notée ici reste sur ton téléphone et nourrit ta semaine.
      </Text>
      <View style={styles.emptyActions}>
        <ActionCard
          icon="tabPrograms"
          title="Créer un programme"
          detail="Fixe tes séances de la semaine, l'app propose la suivante."
          onPress={() => router.push({ pathname: "/program/[id]", params: { id: "new" } })}
        />
        <ActionCard icon="agent" title="Connecter un agent" detail="Un assistant lit ton journal et prépare le programme." onPress={() => router.push("/agent")} />
      </View>
    </View>
  );
}

interface QuickTile {
  readonly sport: SportKey;
  readonly last: SessionSuggestion | null;
}

function lastFigure(sport: SportKey, last: SessionSuggestion): string {
  const definition = sports[sport];
  const figure =
    last.emphasis !== null && emphasisQuantity(definition)?.dimension === "distance" ? distanceFigure(definition, last.emphasis) : durationFigure(last.durationSeconds);
  return figure.unit === "" ? figure.value : `${figure.value} ${figure.unit}`;
}

function QuickLog({ sports: quick, today }: { readonly sports: readonly SportKey[]; readonly today: LocalDate }) {
  const { colors } = useTheme();
  const tiles = useLiveValue<QuickTile[]>(() => quick.map((sport) => ({ sport, last: lastSessionSuggestion(db(), sport) })), ["session"], [quick.join(",")]);
  return (
    <View style={styles.quick}>
      <View style={styles.tiles}>
        {tiles.map((tile) => {
          const tone = colors.sport[tile.sport];
          return (
            <Pressable
              key={tile.sport}
              accessibilityRole="button"
              accessibilityLabel={`Noter : ${sportLabel(tile.sport)}${tile.last === null ? "" : `, dernière fois ${formatAgo(tile.last.localDate, today)}, ${lastFigure(tile.sport, tile.last)}`}`}
              onPress={() => startQuick(tile.sport)}
              style={({ pressed }) => [styles.tile, { backgroundColor: wash(tone, pressed ? 0.24 : 0.1) }]}
            >
              <SportIcon sport={tile.sport} variant="badge" />
              <View style={styles.tileText}>
                <Text variant="label" numberOfLines={1}>
                  {sportLabel(tile.sport)}
                </Text>
                {tile.last === null ? (
                  <>
                    <Text tone="tertiary" style={styles.tileFigure}>
                      –
                    </Text>
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                      jamais noté
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.tileFigure} numberOfLines={1}>
                      {lastFigure(tile.sport, tile.last)}
                    </Text>
                    <Text variant="caption" tone="secondary" numberOfLines={1}>
                      {formatAgo(tile.last.localDate, today)}
                    </Text>
                  </>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Autre sport"
        onPress={() => router.push({ pathname: "/log", params: { sport: "catalogue" } })}
        style={({ pressed }) => [styles.other, { borderColor: colors.line }, pressed && { backgroundColor: colors.surface }]}
      >
        <Icon name="plus" size={18} color={colors.text2} />
        <Text variant="label" tone="secondary" style={styles.otherLabel}>
          Autre sport
        </Text>
        <Icon name="forward" size={16} color={colors.text3} />
      </Pressable>
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

function nextStats(isStrength: boolean, plan: readonly PlanItem[], duration: number | null): StatValue[] {
  const stats: StatValue[] = [];
  if (duration !== null) {
    const figure = durationFigure(duration);
    stats.push({ label: "Durée", value: figure.value, unit: figure.unit });
  }
  if (isStrength && plan.length > 0) {
    stats.push({ label: "Exercices", value: formatInteger(plan.length), unit: "" });
    stats.push({ label: "Séries", value: formatInteger(plan.reduce((sum, item) => sum + item.sets, 0)), unit: "" });
  }
  return stats;
}

function NextCard({ next, variantId, onVariant, notices, today, onOpenNotices }: NextCardProps) {
  const { colors } = useTheme();
  const variant = next.variants.find((item) => item.id === variantId) ?? null;
  const plan = useLiveValue(() => (variantId === null ? [] : variantPlan(db(), variantId)), ["program_item", "exercise", "exercise_zone", "strength_set", "session"], [variantId]);
  const duration = estimatedSlotSeconds(next.slot, plan);
  const isStrength = sports[next.slot.sport].archetype === "strength";
  const stats = nextStats(isStrength, plan, duration);
  const stopZones = new Set(notices.pains.filter((pain) => pain.level === "stop").map((pain) => pain.zone));
  const affected = (pain: PainCarry): boolean => plan.some((item) => item.zones.includes(pain.zone));
  const others = otherPoints(notices, today, notices.pains.length > 0);

  return (
    <Card sport={next.slot.sport}>
      <CardHead sport={next.slot.sport} eyebrow="Prochaine séance" detail={next.current.version.name} />
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {variant === null ? next.slot.name : `${next.slot.name} · ${variant.name}`}
      </Text>
      {stats.length === 0 ? null : <StatRow stats={stats} style={styles.cardStats} />}
      {next.variants.length > 1 ? (
        <View style={styles.variants} accessibilityLabel="Variante">
          <Segmented<Id> options={next.variants.map((item) => ({ value: item.id, label: item.name }))} value={variantId} onChange={onVariant} />
        </View>
      ) : null}

      {notices.pains.length === 0 && others.count === 0 ? null : (
        <View style={styles.notices}>
          {notices.pains.map((pain) => (
            <View key={pain.zone} style={[styles.notice, { backgroundColor: colors.surface2 }]} accessible accessibilityLabel={`${zoneLabel(pain.zone)} : ${painWords[pain.level]} ${relativeDay(pain.localDate, today)}`}>
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
              style={({ pressed }) => [styles.notice, { backgroundColor: pressed ? colors.surfacePress : colors.surface2 }]}
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
        <View style={[styles.plan, { borderTopColor: colors.line }]}>
          <View style={styles.planHead}>
            <Text variant="eyebrow" tone="tertiary" style={styles.planHeadMain}>
              Exercice
            </Text>
            <Text variant="eyebrow" tone="tertiary" style={styles.planHeadValue}>
              Prévu
            </Text>
            <Text variant="eyebrow" tone="tertiary" style={styles.planHeadLast}>
              Dernier
            </Text>
          </View>
          {plan.map((item, index) => {
            const suspended = item.zones.some((zone) => stopZones.has(zone));
            const last = formatLast(item);
            return (
              <View key={item.itemId} style={[styles.planRow, { borderTopColor: colors.line }]}>
                <Text tone="tertiary" style={styles.planIndex}>
                  {index + 1}
                </Text>
                <View style={styles.planMain}>
                  <Text style={styles.planName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  {suspended ? (
                    <View style={styles.planFlag}>
                      <PainMark level="stop" />
                      <Text variant="caption" tone="secondary">
                        à confirmer
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.planPrescription} numberOfLines={1}>
                  {formatPrescription(item)}
                </Text>
                <Text tone="secondary" style={styles.planLast} {...(last === null ? {} : { accessibilityLabel: `dernière charge ${last}` })}>
                  {last ?? "–"}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {next.after === null ? null : (
        <View style={[styles.then, { borderTopColor: colors.line }]}>
          <SportIcon sport={next.after.sport} variant="inline" color={colors.sport[next.after.sport]} />
          <Text variant="small" tone="secondary" style={styles.thenText}>
            {`Ensuite : ${lowerFirst(next.after.name)}${next.after.targetDurationSeconds === null ? "" : ` ${formatDuration(next.after.targetDurationSeconds)}`}`}
          </Text>
        </View>
      )}
    </Card>
  );
}

interface OtherPoints {
  readonly count: number;
  readonly title: string;
  readonly detail: string;
}

function otherPoints(notices: TodayNotices, today: LocalDate, afterPains: boolean): OtherPoints {
  const parts: string[] = [];
  if (notices.agent !== null) parts.push(`${notices.agent.client ?? "Agent"} ${relativeDay(localDateOf(notices.agent.latestAt, deviceTimeZone()), today)}`);
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
    markAgentChangesSeen();
    onClose();
    router.push("/agent/log");
  };
  return (
    <Sheet open={open} title="À voir" onClose={onClose}>
      <View style={styles.menu}>
        {notices.agent === null ? null : (
          <MenuItem
            label={`${plural(notices.agent.count, "modification")} de ${notices.agent.client ?? "l'agent"}`}
            detail={relativeDay(localDateOf(notices.agent.latestAt, deviceTimeZone()), today)}
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
  card: { marginTop: 24, borderRadius: radii.panel, overflow: "hidden" },
  cardAccent: { height: 3 },
  cardBody: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardHeadText: { flex: 1, minWidth: 0, gap: 3 },
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 3.5 },
  cardTitle: { marginTop: 10, fontFamily: fonts.text700, fontSize: 26, lineHeight: 29, letterSpacing: -0.4 },
  cardStats: { marginTop: 10 },
  variants: { marginTop: 12 },
  notices: { marginTop: 12, gap: 2, borderRadius: radii.control, overflow: "hidden" },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingVertical: 6, paddingLeft: 12, paddingRight: 4 },
  noticeText: { flex: 1, minWidth: 0 },
  noticeTitle: { fontFamily: fonts.text600, fontSize: 14, lineHeight: 18 },
  noticeDetail: { fontFamily: fonts.text500 },
  noticeMark: { width: 8, height: 8, borderWidth: 2, transform: [{ rotate: "45deg" }] },
  noticeLink: { fontFamily: fonts.text700, textDecorationLine: "underline", paddingHorizontal: 10, minHeight: 44, lineHeight: 44 },
  plan: { marginTop: 14, borderTopWidth: 1, paddingTop: 10 },
  planHead: { flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 6 },
  planHeadMain: { flex: 1, paddingLeft: 28, fontSize: 11, letterSpacing: 0.8 },
  planHeadValue: { width: 84, textAlign: "right", fontSize: 11, letterSpacing: 0.8 },
  planHeadLast: { width: 56, textAlign: "right", fontSize: 11, letterSpacing: 0.8 },
  planRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingVertical: 6, borderTopWidth: 1 },
  planIndex: { width: 18, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 16 },
  planMain: { flex: 1, minWidth: 0, gap: 2 },
  planName: { fontFamily: fonts.text600, fontSize: 15, lineHeight: 19 },
  planFlag: { flexDirection: "row", alignItems: "center", gap: 6 },
  planPrescription: { width: 84, textAlign: "right", fontFamily: fonts.figure700, fontSize: 17, lineHeight: 19 },
  planLast: { width: 56, textAlign: "right", fontFamily: fonts.figure600, fontSize: 15, lineHeight: 17 },
  then: { marginTop: 8, paddingTop: 12, borderTopWidth: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  thenText: { flex: 1 },
  fullControl: { marginTop: 14 },
  empty: { marginTop: 18, gap: 6 },
  emptyTitle: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 32, letterSpacing: -0.6 },
  emptyLead: { fontSize: 15, lineHeight: 21 },
  emptyActions: { marginTop: 14, gap: 8 },
  action: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 76, paddingVertical: 14, paddingLeft: 14, paddingRight: 12, borderRadius: radii.panel },
  actionIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  actionText: { flex: 1, minWidth: 0, gap: 2 },
  quick: { marginTop: 10, gap: 8 },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, minWidth: 0, minHeight: 132, padding: 12, borderRadius: radii.panel, justifyContent: "space-between", gap: 12 },
  tileText: { gap: 1 },
  tileFigure: { marginTop: 2, fontFamily: fonts.figure700, fontSize: 20, lineHeight: 22 },
  other: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 14, borderRadius: radii.panel, borderWidth: 1 },
  otherLabel: { flex: 1 },
  bottomPanel: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: layout.gutter, paddingVertical: 10 },
  menu: { marginTop: 8 },
});
