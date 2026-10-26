import { Fragment, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { addDays, trend, zonePainHistory } from "@obnixe/core";
import type { GradePyramid } from "@obnixe/core";
import { db } from "@/data/database";
import { PainMark, Segmented } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Row, Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { painWords } from "@/features/stats/format";
import { capitalize, lowerFirst, zoneLabel } from "@/format/labels";
import { useLiveValue, useLocalNow } from "@/features/stats/live";
import { JournalHeader } from "@/features/stats/parts";
import { loadProgress } from "@/features/stats/progress";
import type { ChartPoint, PointLink, ProgressCatalog, Series, Subject } from "@/features/stats/progress";
import { ProgressChart, Sparkline } from "@/features/stats/ProgressChart";
import type { PainStrip } from "@/features/stats/ProgressChart";

type RangeKey = "28" | "84" | "182" | "365";

const ranges: readonly { readonly value: RangeKey; readonly label: string }[] = [
  { value: "28", label: "4 sem." },
  { value: "84", label: "12 sem." },
  { value: "182", label: "6 mois" },
  { value: "365", label: "1 an" },
];

function rangeWords(range: RangeKey): string {
  switch (range) {
    case "28":
      return "4 semaines";
    case "84":
      return "12 semaines";
    case "182":
      return "6 mois";
    case "365":
      return "1 an";
    default: {
      const unreachable: never = range;
      return unreachable;
    }
  }
}

function openLink(link: PointLink): void {
  if (link === null) return;
  switch (link.kind) {
    case "session":
      router.push({ pathname: "/session/[id]", params: { id: link.sessionId } });
      return;
    case "body":
      router.navigate("/body");
      return;
    default: {
      const unreachable: never = link;
      return unreachable;
    }
  }
}

function linkLabel(link: PointLink): string | null {
  if (link === null) return null;
  return link.kind === "body" ? "Voir Corps" : "Voir la séance";
}

function initialSubject(catalog: ProgressCatalog, exercise: string | undefined, sport: string | undefined): string | null {
  if (exercise !== undefined && catalog.subjects.some((subject) => subject.id === `exercise:${exercise}`)) return `exercise:${exercise}`;
  if (sport !== undefined) {
    if (sport === "strength") return catalog.subjects.find((subject) => subject.group === "strength")?.id ?? null;
    if (catalog.subjects.some((subject) => subject.id === `sport:${sport}`)) return `sport:${sport}`;
  }
  return null;
}

function tags(point: ChartPoint): string[] {
  const result: string[] = [];
  if (point.isRecord) result.push("record");
  if (point.unreliable) result.push("peu fiable");
  return result;
}

export function ProgressScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ exercise?: string; sport?: string; indicator?: string }>();
  const { today } = useLocalNow();
  const catalog = useLiveValue(
    () => loadProgress(db(), today),
    ["session", "session_item", "strength_set", "strength_entry", "exercise", "exercise_zone", "pain_report", "check_in", "weigh_in", "program", "program_version", "program_slot", "program_variant", "program_item"],
    [today],
  );
  const [chosen, setChosen] = useState<string | null>(() => initialSubject(catalog, params.exercise, params.sport));
  const [metrics, setMetrics] = useState<Readonly<Record<string, string>>>(() =>
    params.sport !== undefined && params.indicator !== undefined ? { [`sport:${params.sport}`]: params.indicator } : {},
  );
  const [range, setRange] = useState<RangeKey>("84");
  const [selected, setSelected] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    const requested = initialSubject(catalog, params.exercise, params.sport);
    if (requested === null) return;
    setChosen(requested);
    setSelected(null);
    if (params.sport !== undefined && params.indicator !== undefined) {
      const key = `sport:${params.sport}`;
      const indicator = params.indicator;
      setMetrics((previous) => ({ ...previous, [key]: indicator }));
    }
  }, [params.exercise, params.sport, params.indicator]);

  const subject = catalog.subjects.find((item) => item.id === chosen) ?? catalog.subjects[0] ?? null;
  const metricKey = subject === null ? null : (metrics[subject.id] ?? subject.defaultMetric);
  const metric = subject === null || metricKey === null ? null : (subject.metrics.find((item) => item.key === metricKey)?.key ?? subject.defaultMetric);
  const rangeDays = Number(range);
  const from = addDays(today, -rangeDays);
  const isPyramid = subject !== null && metric !== null && subject.isPyramid(metric);
  const series = useMemo(() => (subject === null || metric === null || isPyramid ? null : subject.series(metric)), [subject, metric, isPyramid]);
  const points = useMemo(() => (series === null ? [] : series.points.filter((point) => point.date >= from && point.date <= today)), [series, from, today]);
  const index = selected === null || selected >= points.length ? points.length - 1 : selected;
  const point = points[index];
  const strip = useMemo<PainStrip | null>(() => {
    if (subject === null || subject.zones.length === 0) return null;
    const zones = subject.zones;
    return { label: `${zones.map((zone) => zoneLabel(zone).toLowerCase()).join(", ")} · séance, check-in`, events: zonePainHistory(db(), zones) };
  }, [subject]);
  const pyramid = useMemo(() => (subject !== null && isPyramid ? subject.pyramid(from) : null), [subject, isPyramid, from]);

  const pickSubject = (id: string): void => {
    setChosen(id);
    setSelected(null);
    setSheetOpen(false);
  };

  if (subject === null || metric === null) {
    return (
      <Screen>
        <JournalHeader view="progress" />
        <View style={[styles.empty, { borderColor: colors.line }]}>
          <Text variant="bodyStrong">Rien à suivre pour l'instant</Text>
          <Text variant="small" tone="secondary">
            Note une séance ou un check-in, la progression apparaîtra ici.
          </Text>
        </View>
      </Screen>
    );
  }

  const group = catalog.groups.find((item) => item.key === subject.group);
  const subjectMeta = `${group?.label ?? ""}${subject.subgroup === null ? "" : ` · ${lowerFirst(subject.subgroup)}`}`;
  const pains = strip === null ? [] : strip.events.filter((event) => event.localDate >= from);

  return (
    <>
      <Screen>
        <JournalHeader view="progress" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${subject.name}, ${group?.label ?? ""}. Changer ce qui est suivi`}
          onPress={() => setSheetOpen(true)}
          style={({ pressed }) => [styles.subject, { backgroundColor: pressed ? colors.surfacePress : colors.surface }, subject.icon === null && styles.subjectPlain]}
        >
          {subject.icon === null ? null : <SportIcon sport={subject.icon} variant="filled" />}
          <View style={styles.subjectText}>
            <Text style={styles.subjectName} numberOfLines={1}>
              {subject.name}
            </Text>
            <Text variant="caption" tone="secondary" style={styles.subjectMeta}>
              {subjectMeta}
            </Text>
          </View>
          <Icon name="expand" color={colors.text} />
        </Pressable>
        {subject.metrics.length < 2 ? null : (
          <View style={styles.metrics}>
            <Segmented<string>
              options={subject.metrics.map((item) => ({ value: item.key, label: item.label }))}
              value={metric}
              onChange={(value) => {
                setMetrics({ ...metrics, [subject.id]: value });
                setSelected(null);
              }}
            />
          </View>
        )}
        {series === null || series.note === "" ? null : (
          <Text variant="caption" tone="secondary" style={styles.note}>
            {series.note}
          </Text>
        )}

        {isPyramid ? (
          <PyramidView pyramid={pyramid} />
        ) : series === null || point === undefined ? (
          <View style={[styles.empty, { borderColor: colors.line }]}>
            <Text variant="bodyStrong">{series !== null && series.points.length === 0 ? "Pas encore de séance" : "Rien sur cette période"}</Text>
            <Text variant="small" tone="secondary">
              {series !== null && series.points.length === 0 ? "Les prochaines séances rempliront ce graphique." : "Élargis la période."}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.readout} accessibilityLiveRegion="polite">
              <View style={styles.readoutValue}>
                <Text style={styles.readoutFigure}>{series.format(point.value)}</Text>
                <Text tone="secondary" style={styles.readoutUnit}>
                  {series.unit}
                </Text>
              </View>
              <View style={styles.readoutContext}>
                <Text variant="small" tone="secondary" style={styles.readoutWhen}>
                  {`${capitalize(point.when)}${point.detail === "" ? "" : ` · ${point.detail}`}`}
                  {tags(point).length === 0 ? null : <Text variant="small" style={styles.readoutTag}>{` · ${tags(point).join(" · ")}`}</Text>}
                </Text>
                {linkLabel(point.link) === null ? null : (
                  <Pressable accessibilityRole="link" onPress={() => openLink(point.link)} style={styles.readoutLink}>
                    <Text variant="small" style={styles.readoutLinkText}>
                      {linkLabel(point.link)}
                    </Text>
                  </Pressable>
                )}
              </View>
              <Delta subject={subject} metric={metric} series={series} points={points} range={range} />
            </View>
            <ProgressChart
              series={series}
              points={points}
              from={from}
              to={today}
              rangeDays={rangeDays}
              selected={index}
              onSelect={setSelected}
              strip={strip}
              valueText={`${point.when} : ${series.format(point.value)} ${series.unit}`}
            />
          </>
        )}

        <View style={styles.ranges}>
          <Segmented<RangeKey>
            options={ranges}
            value={range}
            onChange={(value) => {
              setRange(value);
              setSelected(null);
            }}
          />
        </View>
        <Legend series={series} points={points} isPyramid={isPyramid} pyramid={pyramid} rangeDays={rangeDays} subject={subject} pains={pains.map((event) => event.level)} />

        {series === null || points.length === 0 ? null : (
          <>
            <View style={[styles.table, { borderTopColor: colors.line }]}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: tableOpen }} onPress={() => setTableOpen(!tableOpen)} style={styles.tableToggle}>
                <Text variant="bodyStrong">Voir les données</Text>
                <Icon name={tableOpen ? "collapse" : "expand"} color={colors.text} />
              </Pressable>
              {tableOpen ? <DataTable series={series} points={points} metricLabel={subject.metrics.find((item) => item.key === metric)?.label ?? "Valeur"} /> : null}
            </View>
            <Section title={series.kind === "bars" ? "Dernières semaines" : subject.historyTitle}>
              {[...points]
                .slice(-4)
                .reverse()
                .map((item, position, list) => (
                  <Row
                    key={`${item.date}${position}`}
                    title={capitalize(item.when)}
                    detail={`${item.detail}${item.isRecord ? " · record" : ""}`}
                    value={series.format(item.value)}
                    valueDetail={series.unit === "" ? " " : series.unit}
                    {...(item.link === null ? {} : { onPress: () => openLink(item.link) })}
                    last={position === list.length - 1}
                  />
                ))}
            </Section>
          </>
        )}
      </Screen>
      <SubjectsSheet open={sheetOpen} catalog={catalog} current={subject.id} onPick={pickSubject} onClose={() => setSheetOpen(false)} />
    </>
  );
}

interface DeltaProps {
  readonly subject: Subject;
  readonly metric: string;
  readonly series: Series;
  readonly points: readonly ChartPoint[];
  readonly range: RangeKey;
}

function Delta({ subject, metric, series, points, range }: DeltaProps) {
  const words = rangeWords(range);
  let lead: string;
  let tail: string;
  if (series.kind === "bars") {
    const average = points.reduce((sum, item) => sum + item.value, 0) / Math.max(points.length, 1);
    lead = `${series.format(Math.round(average * 10) / 10)} ${series.unit}`;
    tail = "par semaine en moyenne";
  } else if (series.domain.kind === "grades") {
    const best = Math.max(...points.map((item) => item.value));
    lead = series.format(best);
    tail = `au mieux sur ${words}`;
  } else {
    const change = trend(points);
    if (change === null) {
      lead = "";
      tail = "Pas assez de points pour une tendance";
    } else {
      const rounded = Math.round(change * 10) / 10;
      lead = subject.trendWords === undefined ? `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${series.format(Math.abs(rounded))} ${series.unit}` : subject.trendWords(metric, rounded);
      tail = `sur ${words}`;
    }
  }
  return (
    <Text style={styles.delta}>
      {lead}
      <Text tone="secondary" style={styles.deltaTail}>
        {lead === "" ? tail : ` ${tail}`}
      </Text>
    </Text>
  );
}

interface LegendProps {
  readonly series: Series | null;
  readonly points: readonly ChartPoint[];
  readonly isPyramid: boolean;
  readonly pyramid: GradePyramid | null;
  readonly rangeDays: number;
  readonly subject: Subject;
  readonly pains: readonly ("discomfort" | "stop")[];
}

function Legend({ series, points, isPyramid, pyramid, rangeDays, subject, pains }: LegendProps) {
  const { colors } = useTheme();
  const items: { readonly key: string; readonly mark: React.ReactNode; readonly label: string }[] = [];
  if (isPyramid) {
    (pyramid?.options ?? []).forEach((option, position) => items.push({ key: option.key, mark: <View style={[styles.keySquare, pyramidStyle(position, colors)]} />, label: lowerFirst(option.label) }));
  } else if (series !== null && points.length > 0) {
    if (series.kind === "bars") items.push({ key: "bar", mark: <View style={[styles.keyBar, { backgroundColor: colors.stepDone }]} />, label: "par semaine" });
    if (series.kind !== "bars" && rangeDays < 84) items.push({ key: "dot", mark: <View style={[styles.keyDot, { backgroundColor: colors.text }]} />, label: subject.group === "body" || subject.group === "check_in" ? "relevé" : "séance" });
    if (points.some((item) => item.isRecord)) items.push({ key: "record", mark: <View style={[styles.keyRecord, { borderColor: colors.text }]} />, label: "record" });
    if (points.some((item) => item.unreliable)) items.push({ key: "unreliable", mark: <View style={[styles.keyUnreliable, { borderColor: colors.text2 }]} />, label: "1RM peu fiable" });
    if (subject.zones.length > 0) {
      if (pains.includes("discomfort")) items.push({ key: "discomfort", mark: <PainMark level="discomfort" />, label: painWords.discomfort });
      if (pains.includes("stop")) items.push({ key: "stop", mark: <PainMark level="stop" />, label: painWords.stop });
      if (pains.length === 0) items.push({ key: "calm", mark: null, label: "aucune douleur sur la période" });
    }
  }
  if (items.length === 0) return null;
  return (
    <View style={styles.legend}>
      {items.map((item) => (
        <View key={item.key} style={styles.legendItem}>
          {item.mark}
          <Text variant="caption" tone="secondary" style={styles.legendText}>
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function pyramidStyle(position: number, colors: ReturnType<typeof useTheme>["colors"]): { backgroundColor?: string; borderWidth?: number; borderColor?: string } {
  if (position === 0) return { backgroundColor: colors.text };
  if (position === 1) return { backgroundColor: colors.stepDone };
  return { borderWidth: layout.borderControl, borderColor: colors.controlBorder };
}

function PyramidView({ pyramid }: { readonly pyramid: GradePyramid | null }) {
  const { colors } = useTheme();
  if (pyramid === null || pyramid.levels.length === 0) {
    return (
      <View style={[styles.empty, { borderColor: colors.line }]}>
        <Text variant="bodyStrong">Rien sur cette période</Text>
        <Text variant="small" tone="secondary">
          Élargis la période.
        </Text>
      </View>
    );
  }
  const max = Math.max(...pyramid.levels.map((level) => level.total));
  return (
    <View style={styles.pyramid}>
      {pyramid.levels.map((level) => (
        <View
          key={level.grade.label}
          style={styles.pyramidLevel}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`${level.grade.label} : ${pyramid.options.map((option) => `${level.counts[option.key] ?? 0} ${lowerFirst(option.label)}`).join(", ")}`}
        >
          <Text style={styles.pyramidGrade}>{level.grade.label}</Text>
          <View style={styles.pyramidBars}>
            {pyramid.options.map((option, position) => {
              const count = level.counts[option.key] ?? 0;
              return count === 0 ? null : <View key={option.key} style={[styles.pyramidBar, { width: `${(count / max) * 100}%` }, pyramidStyle(position, colors)]} />;
            })}
          </View>
          <Text tone="secondary" style={styles.pyramidTotal}>
            {level.total}
          </Text>
        </View>
      ))}
    </View>
  );
}

function DataTable({ series, points, metricLabel }: { readonly series: Series; readonly points: readonly ChartPoint[]; readonly metricLabel: string }) {
  const { colors } = useTheme();
  const rows = [...points].reverse();
  return (
    <ScrollView style={styles.tableScroll} nestedScrollEnabled>
      <View style={styles.tableRow}>
        <Text tone="tertiary" style={[styles.tableHead, styles.tableWhen]}>
          {series.kind === "bars" ? "Semaine" : "Date"}
        </Text>
        <Text tone="tertiary" style={[styles.tableHead, styles.tableValue]}>
          {metricLabel}
        </Text>
        <Text tone="tertiary" style={[styles.tableHead, styles.tableDetail]}>
          Détail
        </Text>
      </View>
      {rows.map((item, position) => (
        <View key={`${item.date}${position}`} style={[styles.tableRow, { borderTopColor: colors.line, borderTopWidth: 1 }]}>
          <Text variant="small" style={styles.tableWhen}>
            {item.week === null ? item.when : item.when.replace("semaine ", "")}
          </Text>
          <Text style={[styles.tableValue, styles.tableFigure]}>{`${series.format(item.value)} ${series.unit}`.trim()}</Text>
          <Text variant="small" tone="secondary" style={styles.tableDetail}>
            {[item.detail, ...tags(item)].filter((part) => part !== "").join(" · ")}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

interface SubjectsSheetProps {
  readonly open: boolean;
  readonly catalog: ProgressCatalog;
  readonly current: string;
  readonly onPick: (id: string) => void;
  readonly onClose: () => void;
}

function SubjectsSheet({ open, catalog, current, onPick, onClose }: SubjectsSheetProps) {
  const { colors } = useTheme();
  const sparks = useMemo(() => (open ? new Map(catalog.subjects.map((subject) => [subject.id, subject.isPyramid(subject.defaultMetric) ? null : subject.series(subject.defaultMetric)])) : new Map<string, Series | null>()), [open, catalog]);
  return (
    <Sheet open={open} title="Que suivre ?" onClose={onClose}>
      {catalog.groups.map((group) => {
        const items = catalog.subjects.filter((subject) => subject.group === group.key);
        return (
          <View key={group.key}>
            <View style={styles.group}>
              {group.icon === null ? null : <SportIcon sport={group.icon} variant="inline" />}
              <Text style={styles.groupLabel}>{group.label}</Text>
            </View>
            {items.map((subject, position) => {
              const previous = items[position - 1];
              const heading = subject.subgroup !== null && subject.subgroup !== previous?.subgroup ? subject.subgroup : null;
              const spark = sparks.get(subject.id) ?? null;
              return (
                <Fragment key={subject.id}>
                  {heading === null ? null : (
                    <Text tone="tertiary" style={styles.subgroup}>
                      {heading}
                    </Text>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: subject.id === current }}
                    onPress={() => onPick(subject.id)}
                    style={({ pressed }) => [styles.subjectRow, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
                  >
                    <View style={styles.subjectText}>
                      <Text variant="bodyStrong" style={subject.id === current ? styles.subjectCurrent : undefined}>
                        {subject.name}
                      </Text>
                      <View style={styles.subjectRowMeta}>
                        {subject.metaPain === null ? null : <PainMark level={subject.metaPain} />}
                        <Text variant="caption" tone="secondary" style={styles.subjectMeta}>
                          {subject.meta}
                        </Text>
                      </View>
                    </View>
                    {spark === null ? <View style={styles.sparkSpace} /> : <Sparkline series={spark} />}
                  </Pressable>
                </Fragment>
              );
            })}
          </View>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  subject: { marginTop: 14, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingLeft: 10, paddingRight: 14, borderRadius: radii.panel },
  subjectPlain: { paddingLeft: 14 },
  subjectText: { flex: 1, minWidth: 0 },
  subjectName: { fontFamily: fonts.text700, fontSize: 18, lineHeight: 22 },
  subjectMeta: { fontFamily: fonts.text500 },
  metrics: { marginTop: 10 },
  note: { marginTop: 8, fontFamily: fonts.text500 },
  readout: { marginTop: 18, gap: 6 },
  readoutValue: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  readoutFigure: { fontFamily: fonts.figure800, fontSize: 64, lineHeight: 64, letterSpacing: -1.3 },
  readoutUnit: { fontFamily: fonts.text600, fontSize: 15 },
  readoutContext: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 20 },
  readoutWhen: { flex: 1 },
  readoutTag: { fontFamily: fonts.text700 },
  readoutLink: { minHeight: 44, justifyContent: "center", marginVertical: -12 },
  readoutLinkText: { fontFamily: fonts.text600 },
  delta: { fontFamily: fonts.figure700, fontSize: 17, lineHeight: 20 },
  deltaTail: { fontFamily: fonts.figure600 },
  ranges: { marginTop: 14 },
  legend: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendText: { fontFamily: fonts.text500 },
  keyDot: { width: 6, height: 6, borderRadius: 3 },
  keyUnreliable: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.5 },
  keyRecord: { width: 9, height: 9, borderWidth: 2 },
  keyBar: { width: 10, height: 12, borderRadius: 2 },
  keySquare: { width: 12, height: 12, borderRadius: 3 },
  table: { marginTop: 14, borderTopWidth: 1 },
  tableToggle: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tableScroll: { maxHeight: 320 },
  tableRow: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 8, gap: 8 },
  tableHead: { fontFamily: fonts.text600, fontSize: 12, lineHeight: 14 },
  tableWhen: { width: 96 },
  tableValue: { width: 90, textAlign: "right", paddingRight: 6 },
  tableFigure: { fontFamily: fonts.figure700, fontSize: 15, lineHeight: 18 },
  tableDetail: { flex: 1 },
  pyramid: { marginTop: 18, gap: 6 },
  pyramidLevel: { flexDirection: "row", alignItems: "center", gap: 10 },
  pyramidGrade: { width: 40, textAlign: "right", fontFamily: fonts.figure700, fontSize: 17, lineHeight: 18 },
  pyramidBars: { flex: 1, flexDirection: "row", height: 22, gap: 2 },
  pyramidBar: { height: "100%", borderRadius: 3 },
  pyramidTotal: { width: 28, textAlign: "right", fontFamily: fonts.figure700, fontSize: 15, lineHeight: 16 },
  empty: { marginTop: 24, paddingVertical: 20, paddingHorizontal: 16, borderRadius: radii.panel, borderWidth: 1, gap: 6 },
  group: { marginTop: 18, flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 8 },
  groupLabel: { fontFamily: fonts.text700, fontSize: 14, lineHeight: 16 },
  subgroup: { marginTop: 10, paddingBottom: 6, fontFamily: fonts.text600, fontSize: 12, lineHeight: 12 },
  subjectRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, borderTopWidth: 1 },
  subjectRowMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  subjectCurrent: { textDecorationLine: "underline" },
  sparkSpace: { width: 72 },
});
