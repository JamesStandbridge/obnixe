import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { and, desc, eq, isNull, max } from "drizzle-orm";
import { ZodError } from "zod";
import {
  FutureSessionError,
  daysBetween,
  emphasisQuantity,
  enabledSports,
  epochAt,
  evaluateIndicators,
  gearUsage,
  isFreeSport,
  lastSessionSuggestion,
  localDateOf,
  localTimeOf,
  newGear,
  planFreeSession,
  primaryChoice,
  toStored,
  trackedZones,
  zoneStatuses,
} from "@obnixe/core";
import type { QuantityField } from "@obnixe/core";
import { gradeScales, programSlot, session, sportKeys, sportPreference, sports, zoneKeys } from "@obnixe/schema";
import type { Effort, EpochMs, FieldDefinition, FieldValue, FieldValues, Id, LocalDate, PainLevel, Sensation, SportDefinition, SportKey, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { write } from "@/data/write";
import { BottomPanel, Chips, Comparison, DetailRow, Figure, FigureRow, GradeGrid, OtherZoneButton, SportStrip, SwitchRow, bottomPanelHeight } from "@/features/activity/components";
import { useMassUnit } from "@/data/settings";
import type { SportChoice } from "@/features/activity/components";
import { formatDayMonth, formatRelativeDay, lastPainLabel, weekdayName } from "@/features/activity/format";
import { deviceTimeZone } from "@/format/dates";
import { formatLongClock } from "@/format/durations";
import { CatalogueSheet, ChoiceSheet, GearSheet, TextSheet, WhenSheet, ZonePickerSheet, whenLabel } from "@/features/activity/LogSheets";
import type { WhenValue } from "@/features/activity/LogSheets";
import { PadSheet } from "@/ui/PadSheet";
import type { PadResult } from "@/ui/PadSheet";
import { fieldUnit, formatKilometers, formatQuantity, formatRatio, gearLabel, sportArticle } from "@/features/activity/presentation";
import { zoneLabel } from "@/format/labels";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { IconButton, Question, Scale, TextField, ZoneRow } from "@/ui/Inputs";
import { Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

type PadTarget = { readonly kind: "duration" } | { readonly kind: "paused" } | { readonly kind: "field"; readonly key: string };

type LogSheet =
  | { readonly kind: "none" }
  | { readonly kind: "pad"; readonly target: PadTarget }
  | { readonly kind: "when" }
  | { readonly kind: "catalogue" }
  | { readonly kind: "gear" }
  | { readonly kind: "text"; readonly key: string }
  | { readonly kind: "choice"; readonly key: string }
  | { readonly kind: "grade"; readonly key: string }
  | { readonly kind: "zones" };

interface SlotRow {
  readonly id: Id;
  readonly variantId: Id | null;
  readonly sport: SportKey;
  readonly name: string;
}

const effortOptions: readonly { readonly value: Effort; readonly label: string }[] = [
  { value: "easy", label: "Facile" },
  { value: "moderate", label: "Modéré" },
  { value: "hard", label: "Dur" },
  { value: "very_hard", label: "Très dur" },
  { value: "max", label: "Max" },
];

const sensationOptions: readonly { readonly value: Sensation; readonly label: string }[] = [
  { value: "heavy", label: "Lourd" },
  { value: "normal", label: "Normal" },
  { value: "light", label: "Léger" },
];

const enjoymentOptions: readonly { readonly value: number; readonly label: string; readonly caption?: string }[] = [
  { value: 1, label: "1", caption: "corvée" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5", caption: "excellent" },
];

const placement = { aboveTabBar: false, extraOffset: bottomPanelHeight } as const;

function isSportKey(value: string | undefined): value is SportKey {
  return value !== undefined && (sportKeys as readonly string[]).includes(value);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function withValue(values: FieldValues, key: string, value: FieldValue | null): FieldValues {
  const next: FieldValues = { ...values };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

function catalogueLabel(sport: SportKey): string {
  return sport === "strength" ? `${sports.strength.label}, séance libre` : sports[sport].label;
}

function lastGearOf(sport: SportKey): Id | null {
  const row = db()
    .select({ gearId: session.gearId })
    .from(session)
    .where(and(eq(session.sport, sport), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .get();
  return row?.gearId ?? null;
}

function sourceLabel(localDate: LocalDate, today: LocalDate): string {
  const gap = daysBetween(localDate, today);
  if (gap <= 0) return "comme aujourd'hui";
  if (gap === 1) return "comme hier";
  if (gap < 7) return `comme ${weekdayName(localDate)}`;
  return `comme le ${formatDayMonth(localDate)}`;
}

export function LogScreen() {
  const params = useLocalSearchParams<{ sport?: string; slotId?: string; variantId?: string }>();
  const router = useRouter();
  const notify = useSnackbar();
  const massUnit = useMassUnit();
  const { colors } = useTheme();
  const requested = single(params.sport);
  const slotId = single(params.slotId);
  const timeZone = deviceTimeZone();
  const today = localDateOf(environment.now(), timeZone);

  const slot = useMemo<SlotRow | null>(() => {
    if (slotId === undefined) return null;
    const row = db().select({ id: programSlot.id, sport: programSlot.sport, name: programSlot.name }).from(programSlot).where(eq(programSlot.id, slotId as Id)).get();
    if (row === undefined) return null;
    const variant = single(params.variantId);
    return { ...row, variantId: variant === undefined ? null : (variant as Id) };
  }, [slotId, params.variantId]);

  const enabled = useMemo(() => enabledSports(db().select().from(sportPreference).all()), []);
  const freeEnabled = useMemo(() => enabled.filter(isFreeSport), [enabled]);
  const recentOrder = useMemo(() => {
    const rows = db()
      .select({ sport: session.sport, at: max(session.startedAt) })
      .from(session)
      .where(and(isNull(session.deletedAt), eq(session.status, "completed")))
      .groupBy(session.sport)
      .all();
    const lastAt = new Map(rows.map((row) => [row.sport, row.at ?? 0]));
    return [...freeEnabled].sort((left, right) => (lastAt.get(right) ?? 0) - (lastAt.get(left) ?? 0));
  }, [freeEnabled]);

  const initialSport: SportKey = isSportKey(requested) && isFreeSport(requested) ? requested : slot !== null && isFreeSport(slot.sport) ? slot.sport : (recentOrder[0] ?? "run");
  const [sport, setSport] = useState<SportKey>(initialSport);
  const [values, setValues] = useState<FieldValues>({});
  const [duration, setDuration] = useState<number | null>(null);
  const [paused, setPaused] = useState(0);
  const [gearId, setGearId] = useState<Id | null>(() => lastGearOf(initialSport));
  const [gearVersion, setGearVersion] = useState(0);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [sensation, setSensation] = useState<Sensation | null>(null);
  const [enjoyment, setEnjoyment] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [pains, setPains] = useState<Partial<Record<ZoneKey, PainLevel>>>({});
  const [extraZones, setExtraZones] = useState<readonly ZoneKey[]>([]);
  const [countsInRotation, setCountsInRotation] = useState(true);
  const [sheet, setSheet] = useState<LogSheet>({ kind: slot === null && (requested === undefined || requested === "catalogue") ? "catalogue" : "none" });
  const [when, setWhen] = useState<WhenValue>(() => {
    const suggested = lastSessionSuggestion(db(), initialSport);
    const local = localTimeOf((Date.now() - (suggested?.durationSeconds ?? 0) * 1000) as EpochMs, timeZone);
    const minutes = Math.floor(local.minutes / 15) * 15;
    return { day: local.date === today ? "today" : "yesterday", date: local.date, minutes };
  });

  useEffect(() => {
    if (requested === "climb") router.replace({ pathname: "/climb/[id]", params: { id: "new", ...(slotId === undefined ? {} : { slotId }) } });
    else if (requested === "strength") router.replace({ pathname: "/workout/[id]", params: { id: "new", free: "1" } });
  }, [requested, router, slotId]);

  const definition: SportDefinition = sports[sport];
  const emphasis = emphasisQuantity(definition);
  const emphasisUnit = emphasis === null ? null : fieldUnit(sport, emphasis, massUnit);
  const choice = primaryChoice(definition);
  const detailFields = definition.sessionFields.filter((field) => field !== emphasis && field !== choice && field.retired !== true);
  const suggestion = useMemo(() => lastSessionSuggestion(db(), sport), [sport]);
  const gear = useMemo(() => (definition.usesGear ? gearUsage(db(), sport) : []), [definition.usesGear, sport, gearVersion]);
  const tracked = useMemo(() => trackedZones(db()), []);
  const shownZones = useMemo(() => [...tracked, ...extraZones.filter((zone) => !tracked.includes(zone))], [tracked, extraZones]);
  const statuses = useMemo(() => zoneStatuses(db(), shownZones), [shownZones]);

  const emphasisValue = emphasis === null ? undefined : values[emphasis.key];
  const confirmed = (emphasis === null || typeof emphasisValue === "number") && duration !== null;
  const shownEmphasis = typeof emphasisValue === "number" ? emphasisValue : (suggestion?.emphasis ?? 0);
  const shownDuration = duration ?? suggestion?.durationSeconds ?? 0;
  const startedAt = epochAt({ date: when.date, minutes: when.minutes }, timeZone);
  const future = startedAt > Date.now();
  const slotApplies = slot !== null && slot.sport === sport;

  const stripKeys = useMemo(() => {
    const top = recentOrder.slice(0, 3);
    if (!top.includes(sport)) return [...top.slice(0, 2), sport];
    return top;
  }, [recentOrder, sport]);
  const strip: SportChoice[] = [...stripKeys.map((key) => ({ key, label: sports[key].label })), { key: "catalogue", label: "Autre…" }];
  const catalogue = enabled.filter((key) => !stripKeys.includes(key));

  const close = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const switchSport = (next: SportKey): void => {
    setSheet({ kind: "none" });
    if (next === sport) return;
    const nextEmphasis = emphasisQuantity(sports[next]);
    const nextUnit = nextEmphasis === null ? null : fieldUnit(next, nextEmphasis, massUnit);
    const keep = emphasis !== null && nextEmphasis !== null && emphasisUnit !== null && nextUnit !== null && emphasis.key === nextEmphasis.key && emphasisUnit.symbol === nextUnit.symbol;
    const previous = { sport, values, gearId };
    const kept = keep && typeof emphasisValue === "number" ? { [nextEmphasis.key]: emphasisValue } : {};
    setSport(next);
    setValues(kept);
    setGearId(lastGearOf(next));
    if (!keep && typeof emphasisValue === "number" && nextEmphasis !== null && nextUnit !== null && emphasis !== null) {
      notify({
        text: `${emphasis.label} effacée · ${sports[next].label.toLowerCase()} en ${nextUnit.symbol}`,
        ...placement,
        action: {
          label: "Annuler",
          run: () => {
            setSport(previous.sport);
            setValues(previous.values);
            setGearId(previous.gearId);
          },
        },
      });
    }
  };

  const chooseFromCatalogue = (next: SportKey): void => {
    if (isFreeSport(next)) {
      switchSport(next);
      return;
    }
    setSheet({ kind: "none" });
    if (next === "climb") router.replace({ pathname: "/climb/[id]", params: { id: "new", ...(slotId === undefined ? {} : { slotId }) } });
    else if (next === "strength") router.replace({ pathname: "/workout/[id]", params: { id: "new", free: "1" } });
  };

  const fieldOf = (key: string): FieldDefinition | undefined => definition.sessionFields.find((field) => field.key === key);

  const submitPad = (target: PadTarget, result: PadResult): void => {
    setSheet({ kind: "none" });
    switch (target.kind) {
      case "duration":
        setDuration(result.kind === "keep" ? (duration ?? suggestion?.durationSeconds ?? null) : result.value);
        return;
      case "paused":
        if (result.kind === "value") setPaused(result.value);
        return;
      case "field": {
        const field = fieldOf(target.key);
        if (field === undefined || field.type !== "quantity") return;
        if (result.kind === "keep") {
          if (field === emphasis && typeof values[field.key] !== "number" && suggestion?.emphasis !== null && suggestion !== null) {
            setValues(withValue(values, field.key, suggestion.emphasis));
          }
          return;
        }
        setValues(withValue(values, field.key, toStored(result.value, fieldUnit(sport, field, massUnit))));
        return;
      }
      default: {
        const unreachable: never = target;
        return unreachable;
      }
    }
  };

  const save = (): void => {
    if (!confirmed || duration === null || future) return;
    const zonePains = Object.entries(pains).map(([zone, level]) => ({ zone: zone as ZoneKey, level: level as PainLevel }));
    try {
      const plan = planFreeSession(db(), environment, {
        sport,
        startedAt,
        durationSeconds: duration,
        pausedSeconds: paused,
        timeZone,
        values,
        gearId,
        slot: slotApplies && slot !== null ? { slotId: slot.id, variantId: slot.variantId, countsInRotation } : null,
        effort,
        sensation,
        enjoyment,
        note,
        pains: zonePains,
      });
      write(`Nouvelle activité : ${definition.label}`, plan.mutations);
      router.replace({ pathname: "/session/[id]/review", params: { id: plan.sessionId } });
    } catch (error) {
      if (error instanceof FutureSessionError) {
        notify({ text: "Heure dans le futur", ...placement });
        return;
      }
      if (error instanceof ZodError) {
        notify({ text: "Valeurs refusées, vérifie les détails", ...placement });
        return;
      }
      throw error;
    }
  };

  const createGear = (name: string): void => {
    const plan = newGear(environment, sport, name);
    write(`${gearLabel(sport)} : ${name.trim()}`, [plan.mutation]);
    setGearId(plan.gearId);
    setGearVersion((version) => version + 1);
    setSheet({ kind: "none" });
  };

  const ratio = confirmed && duration !== null ? evaluateIndicators(definition, { durationSeconds: duration, values, items: [] })[0] : undefined;
  const ratioDefinition = definition.indicators.find((indicator) => indicator.type === "ratio");
  const previousRatio =
    suggestion === null || emphasis === null || suggestion.emphasis === null ? undefined : evaluateIndicators(definition, { durationSeconds: suggestion.durationSeconds, values: { [emphasis.key]: suggestion.emphasis }, items: [] })[0];

  const comparison = ((): { readonly strong: string; readonly rest: string } | null => {
    if (!confirmed) return suggestion === null ? null : { strong: "Proposé", rest: `· ${sourceLabel(suggestion.localDate, today)}` };
    if (ratio === undefined || ratioDefinition === undefined || ratioDefinition.type !== "ratio") return { strong: "Durée seule", rest: "" };
    const value = formatRatio(ratio) ?? "";
    if (ratioDefinition.numerator === "duration") {
      const suffix = ratioDefinition.per === 1000 ? "/km" : `/${ratioDefinition.per} m`;
      const previous = previousRatio === undefined || suggestion === null ? "" : `· ${formatRelativeDay(suggestion.localDate, today).toLowerCase()} ${formatRatio(previousRatio) ?? ""} ${suffix}`;
      return { strong: `${ratio.label} ${value} ${suffix}`, rest: previous };
    }
    return { strong: `${value} km/h`, rest: "en moyenne" };
  })();

  const longFigure = shownDuration >= 3600 || (emphasisUnit !== null && formatQuantity(shownEmphasis, emphasisUnit).length > 4);
  const primaryLabel = future
    ? "Choisis une heure passée"
    : confirmed
      ? `Enregistrer ${sportArticle(sport)}`
      : emphasis === null
        ? "Saisis la durée"
        : `Saisis ${emphasis.label.toLowerCase()} et durée`;

  const padSheet = ((): { readonly title: string; readonly unit: string; readonly decimals: number; readonly mode: "number" | "clock"; readonly current: string | null; readonly field: QuantityField | null } | null => {
    if (sheet.kind !== "pad") return null;
    switch (sheet.target.kind) {
      case "duration":
        return { title: "Durée", unit: "h:min:s", decimals: 0, mode: "clock", current: duration === null && suggestion === null ? null : formatLongClock(shownDuration), field: null };
      case "paused":
        return { title: "Pause", unit: "h:min:s", decimals: 0, mode: "clock", current: paused === 0 ? null : formatLongClock(paused), field: null };
      case "field": {
        const field = fieldOf(sheet.target.key);
        if (field === undefined || field.type !== "quantity") return null;
        const unit = fieldUnit(sport, field, massUnit);
        const stored = values[field.key];
        const current = typeof stored === "number" ? formatQuantity(stored, unit) : field === emphasis && suggestion?.emphasis !== null && suggestion !== null ? formatQuantity(suggestion.emphasis, unit) : null;
        return { title: field.label, unit: unit.symbol, decimals: unit.decimals, mode: "number", current, field };
      }
      default: {
        const unreachable: never = sheet.target;
        return unreachable;
      }
    }
  })();

  const renderDetail = (field: FieldDefinition, last: boolean) => {
    const value = values[field.key];
    switch (field.type) {
      case "quantity": {
        const unit = fieldUnit(sport, field, massUnit);
        return (
          <DetailRow
            key={field.key}
            title={field.label}
            value={typeof value === "number" ? formatQuantity(value, unit) : null}
            unit={unit.symbol}
            last={last}
            onPress={() => setSheet({ kind: "pad", target: { kind: "field", key: field.key } })}
          />
        );
      }
      case "text":
        return <DetailRow key={field.key} title={field.label} value={typeof value === "string" ? value : null} last={last} onPress={() => setSheet({ kind: "text", key: field.key })} />;
      case "choice": {
        if (field.multiple) {
          const selected = Array.isArray(value) ? value : [];
          return (
            <Question key={field.key} title={field.label}>
              <Chips
                label={field.label}
                multiple
                options={field.options.filter((option) => option.retired !== true).map((option) => ({ value: option.key, label: option.label }))}
                selected={selected}
                onToggle={(key) => setValues(withValue(values, field.key, selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]))}
              />
            </Question>
          );
        }
        const label = field.options.find((option) => option.key === value)?.label ?? null;
        return <DetailRow key={field.key} title={field.label} value={label} last={last} onPress={() => setSheet({ kind: "choice", key: field.key })} />;
      }
      case "toggle":
        return <SwitchRow key={field.key} title={field.label} value={value === true} onChange={(next) => setValues(withValue(values, field.key, next ? true : null))} />;
      case "grade": {
        const grade = typeof value === "string" ? value.slice(value.indexOf(":") + 1) : null;
        return <DetailRow key={field.key} title={field.label} value={grade} last={last} onPress={() => setSheet({ kind: "grade", key: field.key })} />;
      }
      default: {
        const unreachable: never = field;
        return unreachable;
      }
    }
  };

  const selectedGear = gear.find((item) => item.gear.id === gearId);
  const textField = sheet.kind === "text" ? fieldOf(sheet.key) : undefined;
  const choiceField = sheet.kind === "choice" ? fieldOf(sheet.key) : undefined;
  const gradeField = sheet.kind === "grade" ? fieldOf(sheet.key) : undefined;
  const otherZones = [...definition.painZones, ...zoneKeys].filter((zone, index, list) => list.indexOf(zone) === index && !shownZones.includes(zone));

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={120}>
        <View style={styles.appbar}>
          <IconButton icon="close" label="Fermer sans enregistrer" edge="start" onPress={close} />
          <Text variant="label" tone="secondary" style={styles.context} accessibilityRole="header">
            Nouvelle activité
          </Text>
          <LinkButton label={whenLabel(when)} onPress={() => setSheet({ kind: "when" })} style={styles.when} />
        </View>

        <View style={styles.sports}>
          <SportStrip items={strip} value={sport} onChange={(key) => (key === "catalogue" ? setSheet({ kind: "catalogue" }) : switchSport(key))} />
        </View>

        {choice === null ? null : (
          <View style={styles.kind}>
            <Text variant="sectionTitle" tone="secondary">
              {choice.label}
            </Text>
            <Chips
              label={choice.label}
              multiple={false}
              compact
              options={choice.options.filter((option) => option.retired !== true).map((option) => ({ value: option.key, label: option.label }))}
              selected={typeof values[choice.key] === "string" ? [values[choice.key] as string] : []}
              onToggle={(key) => setValues(withValue(values, choice.key, values[choice.key] === key ? null : key))}
            />
          </View>
        )}

        <View style={styles.readout}>
          <FigureRow
            rightWeight={emphasis === null ? 1 : 1.25}
            left={
              emphasis === null || emphasisUnit === null ? null : (
                <Figure
                  value={formatQuantity(shownEmphasis, emphasisUnit)}
                  label={`${emphasis.label} · ${emphasisUnit.symbol}`}
                  suggested={typeof emphasisValue !== "number"}
                  size={longFigure ? 60 : 84}
                  accessibilityLabel={`${emphasis.label}, ${formatQuantity(shownEmphasis, emphasisUnit)} ${emphasisUnit.symbol}${typeof emphasisValue === "number" ? "" : ", proposé"}`}
                  onPress={() => setSheet({ kind: "pad", target: { kind: "field", key: emphasis.key } })}
                />
              )
            }
            right={
              <Figure
                value={formatLongClock(shownDuration)}
                label="Durée"
                suggested={duration === null}
                size={longFigure ? 60 : 84}
                accessibilityLabel={`Durée, ${formatLongClock(shownDuration)}${duration === null ? ", proposée" : ""}`}
                onPress={() => setSheet({ kind: "pad", target: { kind: "duration" } })}
              />
            }
          />
          {comparison === null ? null : <Comparison strong={comparison.strong} rest={comparison.rest} />}
        </View>

        <Section title="Détails" action={<Text variant="caption" tone="secondary">facultatif</Text>}>
          {detailFields.map((field) => renderDetail(field, false))}
          {definition.usesGear ? (
            <DetailRow
              title={gearLabel(sport)}
              value={selectedGear === undefined ? null : `${selectedGear.gear.name} · ${formatKilometers(selectedGear.meters)}`}
              onPress={() => setSheet({ kind: "gear" })}
            />
          ) : null}
          <DetailRow title="Pause" value={paused === 0 ? null : formatLongClock(paused)} last onPress={() => setSheet({ kind: "pad", target: { kind: "paused" } })} />
        </Section>

        <Section title="Ressenti" action={<Text variant="caption" tone="secondary">facultatif</Text>}>
          <Question title="Effort">
            <Scale label="Effort" words optional options={effortOptions} value={effort} onChange={setEffort} />
          </Question>
          <Question title="Sensation">
            <Scale label="Sensation physique" words optional options={sensationOptions} value={sensation} onChange={setSensation} />
          </Question>
          <Question title="Plaisir">
            <Scale label="Plaisir, de 1 (corvée) à 5 (excellent)" optional options={enjoymentOptions} value={enjoyment} onChange={setEnjoyment} />
          </Question>
        </Section>

        <Section title="Douleurs">
          <View style={styles.zones}>
            {statuses.map((status) => (
              <ZoneRow
                key={status.zone}
                name={zoneLabel(status.zone)}
                {...(status.last === null ? (status.tracked ? { detail: "suivi en cours" } : {}) : { detail: lastPainLabel(status.last, today) })}
                value={pains[status.zone] ?? null}
                onChange={(level) => {
                  const next = { ...pains };
                  if (level === null) delete next[status.zone];
                  else next[status.zone] = level;
                  setPains(next);
                }}
              />
            ))}
          </View>
          <OtherZoneButton label="Autre zone…" onPress={() => setSheet({ kind: "zones" })} />
        </Section>

        <Section title="Note">
          <TextField multiline value={note} onChangeText={setNote} placeholder="Note libre" accessibilityLabel="Note" style={styles.note} />
          {slotApplies && slot !== null ? <SwitchRow title={`Compte comme ${slot.name.toLowerCase()}`} value={countsInRotation} onChange={setCountsInRotation} /> : null}
        </Section>
      </Screen>

      <BottomPanel>
        <PrimaryButton
          label={primaryLabel}
          disabled={!confirmed || future}
          icon={<Icon name="check" size={20} color={!confirmed || future ? colors.text2 : colors.actInk} />}
          onPress={save}
        />
      </BottomPanel>

      <CatalogueSheet open={sheet.kind === "catalogue"} sports={catalogue} labelOf={catalogueLabel} onChoose={chooseFromCatalogue} onClose={() => setSheet({ kind: "none" })} />
      <WhenSheet
        open={sheet.kind === "when"}
        value={when}
        onConfirm={(value) => {
          setWhen(value);
          setSheet({ kind: "none" });
        }}
        onClose={() => setSheet({ kind: "none" })}
      />
      <PadSheet
        open={padSheet !== null}
        title={padSheet?.title ?? ""}
        mode={padSheet?.mode ?? "number"}
        unit={padSheet?.unit ?? ""}
        decimals={padSheet?.decimals ?? 0}
        current={padSheet?.current ?? null}
        validate={(value) => {
          const field = padSheet?.field ?? null;
          if (field === null) return null;
          const stored = toStored(value, fieldUnit(sport, field, massUnit));
          const unit = fieldUnit(sport, field, massUnit);
          if (field.min !== null && stored < field.min) return `Minimum ${formatQuantity(field.min, unit)} ${unit.symbol}`.trim();
          if (field.max !== null && stored > field.max) return `Maximum ${formatQuantity(field.max, unit)} ${unit.symbol}`.trim();
          return null;
        }}
        {...(sheet.kind === "pad" && ((sheet.target.kind === "field" && padSheet?.field !== emphasis && typeof values[sheet.target.key] === "number") || (sheet.target.kind === "paused" && paused > 0))
          ? {
              action: {
                label: "Retirer",
                appearance: "link",
                onPress: () => {
                  if (sheet.target.kind === "paused") setPaused(0);
                  else if (sheet.target.kind === "field") setValues(withValue(values, sheet.target.key, null));
                  setSheet({ kind: "none" });
                },
              },
            }
          : {})}
        onSubmit={(result) => {
          if (sheet.kind === "pad") submitPad(sheet.target, result);
        }}
        onClose={() => setSheet({ kind: "none" })}
      />
      <GearSheet
        open={sheet.kind === "gear"}
        title={gearLabel(sport)}
        items={gear}
        selected={gearId}
        onSelect={(next) => {
          setGearId(next);
          setSheet({ kind: "none" });
        }}
        onCreate={createGear}
        onClose={() => setSheet({ kind: "none" })}
      />
      <TextSheet
        open={textField !== undefined}
        title={textField?.label ?? ""}
        value={textField === undefined ? null : typeof values[textField.key] === "string" ? (values[textField.key] as string) : null}
        onSubmit={(text) => {
          if (textField !== undefined) setValues(withValue(values, textField.key, text));
          setSheet({ kind: "none" });
        }}
        onClose={() => setSheet({ kind: "none" })}
      />
      <ChoiceSheet
        open={choiceField !== undefined && choiceField.type === "choice"}
        title={choiceField?.label ?? ""}
        options={choiceField?.type === "choice" ? choiceField.options.filter((option) => option.retired !== true) : []}
        selected={choiceField === undefined ? null : typeof values[choiceField.key] === "string" ? (values[choiceField.key] as string) : null}
        onChoose={(key) => {
          if (choiceField !== undefined) setValues(withValue(values, choiceField.key, key));
          setSheet({ kind: "none" });
        }}
        onClose={() => setSheet({ kind: "none" })}
      />
      <Sheet open={gradeField !== undefined && gradeField.type === "grade"} title={gradeField?.label ?? ""} onClose={() => setSheet({ kind: "none" })}>
        {gradeField?.type === "grade" ? (
          <GradeGrid
            grades={gradeScales[gradeField.scales[0]].grades}
            selected={typeof values[gradeField.key] === "string" ? (values[gradeField.key] as string).slice((values[gradeField.key] as string).indexOf(":") + 1) : null}
            onSelect={(grade) => {
              setValues(withValue(values, gradeField.key, `${gradeField.scales[0]}:${grade}`));
              setSheet({ kind: "none" });
            }}
          />
        ) : null}
      </Sheet>
      <ZonePickerSheet
        open={sheet.kind === "zones"}
        zones={otherZones}
        onPick={(zone) => {
          setExtraZones([...extraZones, zone]);
          setSheet({ kind: "none" });
        }}
        onClose={() => setSheet({ kind: "none" })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  context: { flex: 1 },
  when: { marginRight: -10 },
  sports: { marginTop: 12 },
  kind: { marginTop: 16, gap: 8 },
  readout: { marginTop: 20, gap: 14 },
  zones: { marginTop: 2 },
  note: { marginTop: 10 },
});
