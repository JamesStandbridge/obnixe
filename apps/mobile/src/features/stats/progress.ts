import {
  addDays,
  checkInDays,
  completedSessions,
  currentProgram,
  exerciseMetrics,
  exerciseSeries,
  exerciseSessions,
  gradeAt,
  gradePyramid,
  hasGradePyramid,
  indicatorBetter,
  indicatorSeries,
  movingAverage,
  painCarries,
  preferredExerciseMetric,
  trainedExercises,
  weeklyTotals,
  weighInDays,
} from "@obnixe/core";
import type { Better, ExerciseMetric, ExercisePoint, GradePyramid, ReportedPainLevel, SessionSummary } from "@obnixe/core";
import { eq, inArray } from "drizzle-orm";
import { exerciseZone, programItem, programVariant, sportKeys, sports } from "@obnixe/schema";
import type { ExerciseMeasure, FieldDefinition, GradeScaleKey, Id, IndicatorDefinition, LocalDate, SportDefinition, SportKey, ZoneKey } from "@obnixe/schema";
import type { AppDatabase } from "@/data/database";
import { formatInteger, formatKilometers, formatNumber, plural, rowDate, shortDate, sleepHours } from "@/features/stats/format";
import { distanceFigure, formatRatio, sessionFigure, sportLabel } from "@/features/stats/presentation";

export type ChartKind = "line" | "step" | "bars";

export type PointLink = { readonly kind: "session"; readonly sessionId: Id } | { readonly kind: "body" } | null;

export interface ChartPoint {
  readonly date: LocalDate;
  readonly value: number;
  readonly unreliable: boolean;
  readonly isRecord: boolean;
  readonly when: string;
  readonly detail: string;
  readonly link: PointLink;
  readonly week: LocalDate | null;
}

export type Domain = { readonly kind: "auto" } | { readonly kind: "fixed"; readonly min: number; readonly max: number } | { readonly kind: "grades"; readonly scale: GradeScaleKey };

export interface Series {
  readonly kind: ChartKind;
  readonly unit: string;
  readonly format: (value: number) => string;
  readonly tickFormat: (value: number) => string;
  readonly better: Better;
  readonly points: readonly ChartPoint[];
  readonly note: string;
  readonly domain: Domain;
}

export interface MetricOption {
  readonly key: string;
  readonly label: string;
}

export type GroupKey = "strength" | SportKey | "body" | "check_in";

export interface Subject {
  readonly id: string;
  readonly group: GroupKey;
  readonly subgroup: string | null;
  readonly icon: SportKey | null;
  readonly name: string;
  readonly meta: string;
  readonly metaPain: ReportedPainLevel | null;
  readonly metrics: readonly MetricOption[];
  readonly defaultMetric: string;
  readonly zones: readonly ZoneKey[];
  readonly historyTitle: string;
  readonly isPyramid: (metric: string) => boolean;
  readonly series: (metric: string) => Series;
  readonly pyramid: (from: LocalDate) => GradePyramid | null;
  readonly trendWords?: (metric: string, delta: number) => string;
}

export interface SubjectGroup {
  readonly key: GroupKey;
  readonly label: string;
  readonly icon: SportKey | null;
}

const exerciseMetricLabels: Readonly<Record<ExerciseMetric, string>> = {
  e1rm: "1RM estimé",
  load: "Charge",
  volume: "Volume",
  best_reps: "Meilleure série",
  total_reps: "Volume",
  best_duration: "Meilleure série",
  total_duration: "Volume",
};

const exerciseMetricNotes: Readonly<Record<ExerciseMetric, string>> = {
  e1rm: "RIR compris",
  load: "Meilleure série",
  volume: "Toutes les séries",
  best_reps: "Poids du corps",
  total_reps: "Toutes les séries",
  best_duration: "Plus longue série",
  total_duration: "Toutes les séries",
};

function exerciseUnit(metric: ExerciseMetric): string {
  switch (metric) {
    case "e1rm":
    case "load":
    case "volume":
      return "kg";
    case "best_reps":
    case "total_reps":
      return "rép.";
    case "best_duration":
    case "total_duration":
      return "s";
    default: {
      const unreachable: never = metric;
      return unreachable;
    }
  }
}

function isExerciseMetric(measure: ExerciseMeasure, value: string): value is ExerciseMetric {
  return (exerciseMetrics(measure) as readonly string[]).includes(value);
}

function exercisePointDetail(point: ExercisePoint, metric: ExerciseMetric): string {
  const top = point.top;
  const parts: string[] = [];
  if (top === null) parts.push(plural(point.setCount, "série"));
  else if (top.loadGrams !== null && top.reps !== null) parts.push(`${formatNumber(top.loadGrams / 1000)} × ${top.reps}`);
  else if (top.reps !== null) parts.push(`${top.reps} rép.`);
  else if (top.durationSeconds !== null) parts.push(`${top.durationSeconds} s`);
  if (top?.rir != null && metric !== "volume") parts.push(`RIR ${top.rir}`);
  if (point.interrupted) parts.push("interrompu");
  return parts.join(" · ");
}

function exerciseSubjects(db: AppDatabase, today: LocalDate): Subject[] {
  const trained = trainedExercises(db);
  if (trained.length === 0) return [];
  const ids = trained.map((item) => item.exercise.id);
  const zones = db.select().from(exerciseZone).where(inArray(exerciseZone.exerciseId, ids)).all();
  const carries = painCarries(db, today, 7);
  const program = currentProgram(db);
  const placement = new Map<Id, { readonly slot: string; readonly order: number }>();
  if (program !== null) {
    program.slots.forEach((slot, slotIndex) => {
      const items = db
        .select({ exerciseId: programItem.exerciseId, position: programItem.position, variant: programVariant.position })
        .from(programItem)
        .innerJoin(programVariant, eq(programItem.variantId, programVariant.id))
        .where(eq(programVariant.slotId, slot.id))
        .all()
        .sort((left, right) => left.variant - right.variant || left.position - right.position);
      items.forEach((item, index) => {
        if (!placement.has(item.exerciseId)) placement.set(item.exerciseId, { slot: slot.name, order: slotIndex * 1000 + index });
      });
    });
  }
  return trained
    .map((item) => ({ item, place: placement.get(item.exercise.id) ?? null }))
    .sort((left, right) => (left.place?.order ?? Number.MAX_SAFE_INTEGER) - (right.place?.order ?? Number.MAX_SAFE_INTEGER) || right.item.lastDate.localeCompare(left.item.lastDate))
    .map(({ item, place }): Subject => {
      const exercise = item.exercise;
      const exerciseZones = zones.filter((zone) => zone.exerciseId === exercise.id).map((zone) => zone.zone);
      const pain = carries.find((carry) => exerciseZones.includes(carry.zone))?.level ?? null;
      const metrics = exerciseMetrics(exercise.measure);
      let cached: ReturnType<typeof exerciseSessions> | null = null;
      const sessionsOf = (): ReturnType<typeof exerciseSessions> => (cached ??= exerciseSessions(db, exercise.id));
      return {
        id: `exercise:${exercise.id}`,
        group: "strength",
        subgroup: place?.slot ?? "Hors programme",
        icon: "strength",
        name: exercise.name,
        meta: `dernière : ${rowDate(item.lastDate).toLowerCase()}`,
        metaPain: pain,
        metrics: metrics.map((metric) => ({ key: metric, label: exerciseMetricLabels[metric] })),
        get defaultMetric() {
          return preferredExerciseMetric(exercise.measure, sessionsOf());
        },
        zones: exerciseZones,
        historyTitle: "Dernières séances",
        isPyramid: () => false,
        pyramid: () => null,
        series: (key) => {
          const metric: ExerciseMetric = isExerciseMetric(exercise.measure, key) ? key : metrics[0];
          const points = exerciseSeries(sessionsOf(), metric);
          const format = metric === "volume" || metric === "total_reps" ? formatInteger : (value: number) => formatNumber(value);
          return {
            kind: "line",
            unit: exerciseUnit(metric),
            format,
            tickFormat: format,
            better: "higher",
            note: exerciseMetricNotes[metric],
            domain: { kind: "auto" },
            points: points.map((point) => ({
              date: point.date,
              value: point.value,
              unreliable: point.unreliable,
              isRecord: point.isRecord,
              when: rowDate(point.date),
              detail: exercisePointDetail(point, metric),
              link: { kind: "session", sessionId: point.sessionId },
              week: null,
            })),
          };
        },
      };
    });
}

function hasDistance(sport: SportDefinition): boolean {
  return sport.sessionFields.some((field) => field.key === "distance" && field.type === "quantity");
}

function fieldOf(sport: SportDefinition, key: string): FieldDefinition | undefined {
  return [...sport.sessionFields, ...sport.itemFields].find((field) => field.key === key);
}

function indicatorFormat(sport: SportDefinition, indicator: IndicatorDefinition): (value: number) => string {
  switch (indicator.type) {
    case "ratio":
      return (value) => formatRatio(indicator, value).value;
    case "share":
      return (value) => `${formatInteger(value * 100)} %`;
    case "count":
      return formatInteger;
    case "aggregate": {
      const field = fieldOf(sport, indicator.field);
      if (field?.type === "quantity" && field.dimension === "distance") return (value) => distanceFigure(sport, value).value;
      return (value) => formatNumber(value);
    }
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
}

function indicatorUnit(sport: SportDefinition, indicator: IndicatorDefinition): string {
  switch (indicator.type) {
    case "ratio":
      return formatRatio(indicator, 1000).unit;
    case "share":
    case "count":
      return "";
    case "aggregate": {
      const field = fieldOf(sport, indicator.field);
      if (field?.type === "quantity" && field.dimension === "distance") return distanceFigure(sport, 1000).unit;
      return "";
    }
    default: {
      const unreachable: never = indicator;
      return unreachable;
    }
  }
}

function weeklySeries(sessions: readonly SessionSummary[], today: LocalDate, valueOf: (session: SessionSummary) => number, unit: string, format: (value: number) => string, countWord: string): Series {
  const first = sessions[0]?.localDate ?? today;
  const from = addDays(today, -371) > first ? addDays(today, -371) : first;
  const weeks = weeklyTotals(from, today, sessions.map((item) => ({ date: item.localDate, value: valueOf(item) })));
  return {
    kind: "bars",
    unit,
    format,
    tickFormat: format,
    better: null,
    note: "",
    domain: { kind: "auto" },
    points: weeks.map((week) => ({
      date: addDays(week.monday, 3),
      value: week.value,
      unreliable: false,
      isRecord: false,
      when: `semaine du ${shortDate(week.monday)}`,
      detail: plural(week.count, countWord),
      link: null,
      week: week.monday,
    })),
  };
}

function sportSubjects(db: AppDatabase, today: LocalDate): Subject[] {
  const all = completedSessions(db);
  const yearAgo = addDays(today, -365);
  return sportKeys.flatMap((key): Subject[] => {
    const sport: SportDefinition = sports[key];
    if (sport.archetype === "strength") return [];
    const sessions = all.filter((item) => item.sport === key);
    if (sessions.length === 0) return [];
    const metrics: MetricOption[] = [];
    if (hasDistance(sport)) metrics.push({ key: "weekly_distance", label: "Distance / sem." });
    for (const indicator of sport.indicators) metrics.push({ key: indicator.key, label: indicator.label });
    if (hasGradePyramid(sport)) metrics.push({ key: "pyramid", label: "Pyramide" });
    if (metrics.length === 0) metrics.push({ key: "weekly_duration", label: "Durée / sem." });
    const count = sessions.filter((item) => item.localDate >= yearAgo).length;
    const noun = sport.archetype === "continuous" && hasDistance(sport) ? "sortie" : "séance";
    const defaultMetric = metrics.find((metric) => metric.key !== "weekly_distance" && metric.key !== "pyramid" && sport.indicators.find((indicator) => indicator.key === metric.key)?.type === "aggregate")?.key ?? metrics[0]?.key ?? "weekly_duration";
    return [
      {
        id: `sport:${key}`,
        group: key,
        subgroup: null,
        icon: key,
        name: sport.label,
        meta: `${plural(count, noun)} sur un an`,
        metaPain: null,
        metrics,
        defaultMetric,
        zones: [],
        historyTitle: "Dernières séances",
        isPyramid: (metric) => metric === "pyramid",
        pyramid: (from) => gradePyramid(sport, sessions.filter((item) => item.localDate >= from)),
        series: (metric) => {
          if (metric === "weekly_distance") {
            const unit = distanceFigure(sport, 1000).unit;
            return {
              ...weeklySeries(sessions, today, (item) => (typeof item.values.distance === "number" ? item.values.distance : 0), unit, (value) => (unit === "m" ? formatInteger(value) : formatKilometers(value)), noun),
              note: "",
            };
          }
          const indicator = sport.indicators.find((item) => item.key === metric);
          if (indicator === undefined) {
            return weeklySeries(sessions, today, (item) => (item.durationSeconds ?? 0) / 60, "min", formatInteger, noun);
          }
          const points = indicatorSeries(indicator, sport, sessions);
          const scale = points.find((point) => point.grade !== null)?.grade?.scale ?? null;
          const format = scale === null ? indicatorFormat(sport, indicator) : (value: number) => gradeAt(scale, Math.round(value))?.label ?? "";
          const byId = new Map(sessions.map((item) => [item.id, item]));
          return {
            kind: scale === null ? "line" : "step",
            unit: scale === null ? indicatorUnit(sport, indicator) : "",
            format,
            tickFormat: format,
            better: indicatorBetter(indicator),
            note: "",
            domain: scale === null ? { kind: "auto" } : { kind: "grades", scale },
            points: points.map((point) => {
              const session = byId.get(point.sessionId);
              const distance = session?.values.distance;
              return {
                date: point.date,
                value: point.value,
                unreliable: false,
                isRecord: point.isRecord,
                when: rowDate(point.date),
                detail: typeof distance === "number" ? `${distanceFigure(sport, distance).value} ${distanceFigure(sport, distance).unit}` : session === undefined ? "" : sessionFigure(session).details.join(" · "),
                link: { kind: "session", sessionId: point.sessionId },
                week: null,
              };
            }),
          };
        },
      },
    ];
  });
}

function trendSigned(delta: number, unit: string): string {
  if (delta === 0) return "Stable";
  return `${delta > 0 ? "+" : "−"}${formatNumber(Math.abs(delta))} ${unit}`;
}

function bodySubjects(db: AppDatabase, today: LocalDate): Subject[] {
  const weighIns = weighInDays(db, { from: addDays(today, -730), to: today });
  if (weighIns.length === 0) return [];
  const last = weighIns[weighIns.length - 1];
  const raw = weighIns.map((item) => ({ date: item.localDate, value: item.grams / 1000 }));
  return [
    {
      id: "body:weight",
      group: "body",
      subgroup: null,
      icon: null,
      name: "Poids",
      meta: last === undefined ? "" : `dernière pesée : ${formatNumber(last.grams / 1000)} kg`,
      metaPain: null,
      metrics: [
        { key: "average", label: "Moyenne 7 jours" },
        { key: "raw", label: "Pesées" },
      ],
      defaultMetric: "average",
      zones: [],
      historyTitle: "Dernières pesées",
      isPyramid: () => false,
      pyramid: () => null,
      trendWords: (_, delta) => trendSigned(delta, "kg"),
      series: (metric) => {
        const values = metric === "raw" ? raw : movingAverage(raw, 7);
        return {
          kind: "line",
          unit: "kg",
          format: (value) => formatNumber(value),
          tickFormat: (value) => formatNumber(value),
          better: null,
          note: "",
          domain: { kind: "auto" },
          points: values.map((item) => ({
            date: item.date,
            value: Math.round(item.value * 10) / 10,
            unreliable: false,
            isRecord: false,
            when: rowDate(item.date),
            detail: metric === "raw" ? "pesée" : plural(raw.filter((other) => other.date <= item.date && other.date > addDays(item.date, -7)).length, "pesée"),
            link: { kind: "body" },
            week: null,
          })),
        };
      },
    },
  ];
}

function checkInSubjects(db: AppDatabase, today: LocalDate): Subject[] {
  const days = checkInDays(db, { from: addDays(today, -730), to: today }).filter((day) => day.energy !== null || day.sleep !== null);
  const first = days[0];
  if (first === undefined) return [];
  return [
    {
      id: "check_in",
      group: "check_in",
      subgroup: null,
      icon: null,
      name: "Énergie et sommeil",
      meta: `check-ins depuis le ${shortDate(first.localDate)}`,
      metaPain: null,
      metrics: [
        { key: "energy", label: "Énergie" },
        { key: "sleep", label: "Sommeil" },
      ],
      defaultMetric: "energy",
      zones: [],
      historyTitle: "Derniers check-ins",
      isPyramid: () => false,
      pyramid: () => null,
      trendWords: (metric, delta) => {
        const label = metric === "sleep" ? "Sommeil" : "Énergie";
        if (delta === 0) return `${label} stable`;
        const amount = metric === "sleep" ? `${formatNumber(Math.abs(delta))} h` : `${formatNumber(Math.abs(delta))} point${Math.abs(delta) >= 2 ? "s" : ""}`;
        return `${label} en ${delta > 0 ? "hausse" : "baisse"} de ${amount}`;
      },
      series: (metric) => {
        const isSleep = metric === "sleep";
        const format = (value: number): string => (isSleep && value < 6 ? "< 6" : formatNumber(value));
        return {
          kind: "line",
          unit: isSleep ? "h" : "/ 5",
          format,
          tickFormat: (value) => formatNumber(value),
          better: null,
          note: "",
          domain: isSleep ? { kind: "fixed", min: 5, max: 9 } : { kind: "fixed", min: 1, max: 5 },
          points: days.flatMap((day) => {
            const value = isSleep ? (day.sleep === null ? null : sleepHours(day.sleep)) : day.energy;
            return value === null ? [] : [{ date: day.localDate, value, unreliable: false, isRecord: false, when: rowDate(day.localDate), detail: "check-in", link: { kind: "body" } as const, week: null }];
          }),
        };
      },
    },
  ];
}

export interface ProgressCatalog {
  readonly subjects: readonly Subject[];
  readonly groups: readonly SubjectGroup[];
}

export function loadProgress(db: AppDatabase, today: LocalDate): ProgressCatalog {
  const subjects = [...exerciseSubjects(db, today), ...sportSubjects(db, today), ...bodySubjects(db, today), ...checkInSubjects(db, today)];
  const groups: SubjectGroup[] = [];
  for (const subject of subjects) {
    if (groups.some((group) => group.key === subject.group)) continue;
    groups.push({ key: subject.group, label: groupLabel(subject.group), icon: subject.icon });
  }
  return { subjects, groups };
}

function groupLabel(group: GroupKey): string {
  if (group === "body") return "Corps";
  if (group === "check_in") return "Check-in";
  return sportLabel(group);
}

