import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { stepSpeedMmS, workoutEstimate } from "@obnixe/core";
import { workoutIntents, workoutLimits } from "@obnixe/schema";
import type { HeartRateZoneTarget, WorkoutIntent, WorkoutPlan, WorkoutRepeat, WorkoutStep, WorkoutTarget } from "@obnixe/schema";
import { compactStep, estimateText, intentLabels, intentShortLabels, workoutDurationText, workoutTargetText } from "@/features/workouts/format";
import {
  absorbNext,
  appendRepeat,
  appendStep,
  canAbsorbNext,
  canMove,
  duplicateAt,
  durationOfKind,
  kmhToMmS,
  moveAt,
  removeAt,
  repeatStep,
  replaceStep,
  setCount,
  stepDuration,
  targetOfKind,
  ungroup,
  workoutIssue,
} from "@/features/workouts/plan";
import type { DurationKind, Measure, StepPath, TargetKind } from "@/features/workouts/plan";
import { formatClock } from "@/format/durations";
import { formatNumber } from "@/format/numbers";
import { ControlButton } from "@/ui/Button";
import { Segmented, StepButton, Stepper } from "@/ui/Controls";
import type { SegmentOption } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { TextField } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import type { Palette } from "@/ui/tokens";
import { fonts, radii } from "@/ui/tokens";

const durationOptions: readonly SegmentOption<DurationKind>[] = [
  { value: "time", label: "Temps" },
  { value: "distance", label: "Distance" },
  { value: "open", label: "Manuelle" },
];

const zones: readonly HeartRateZoneTarget[] = [1, 2, 3, 4, 5];

function targetOptions(measure: Measure): readonly SegmentOption<TargetKind>[] {
  return [
    { value: "none", label: "Aucune" },
    measure === "pace" ? { value: "pace", label: "Allure" } : { value: "speed", label: "Vitesse" },
    { value: "heart_rate_zone", label: "Zone FC" },
    { value: "heart_rate", label: "FC" },
  ];
}

function intentColor(intent: WorkoutIntent, colors: Palette): string {
  switch (intent) {
    case "work":
      return colors.mark;
    case "warmup":
    case "cooldown":
      return colors.text2;
    case "recovery":
    case "rest":
      return colors.controlBorder;
    default: {
      const unreachable: never = intent;
      return unreachable;
    }
  }
}

function stepDetail(step: WorkoutStep): string {
  const duration = workoutDurationText(step.duration);
  return step.target.kind === "none" ? duration : `${duration} · ${workoutTargetText(step.target)}`;
}

function samePath(left: StepPath | null, right: StepPath): boolean {
  return left !== null && left.node === right.node && left.step === right.step;
}

interface WorkoutEditorProps {
  readonly plan: WorkoutPlan;
  readonly measure: Measure;
  /** The user's recent speed for the sport in mm/s, for the estimate of untargeted steps. */
  readonly referenceSpeedMmS: number | null;
  readonly onChange: (plan: WorkoutPlan) => void;
}

/** `WKT-001`: composes the steps and repeats of a guided workout, with its estimate and compact summary. */
export function WorkoutEditor({ plan, measure, referenceSpeedMmS, onChange }: WorkoutEditorProps) {
  const [open, setOpen] = useState<StepPath | null>(null);
  const estimate = estimateText(workoutEstimate(plan, referenceSpeedMmS));
  const issue = workoutIssue(plan, measure);
  const edit = (next: WorkoutPlan, path: StepPath | null): void => {
    onChange(next);
    setOpen(path);
  };
  const toggle = (path: StepPath): void => setOpen(samePath(open, path) ? null : path);
  const shared = { plan, measure, referenceSpeedMmS, open, onToggle: toggle, onEdit: edit };
  return (
    <View>
      {estimate === null ? null : (
        <Text variant="value" style={styles.estimate}>
          {estimate}
        </Text>
      )}
      {plan.nodes.map((node, index) =>
        node.type === "step" ? <StepRow key={index} {...shared} path={{ node: index, step: null }} step={node} /> : <RepeatBlock key={index} {...shared} index={index} repeat={node} />,
      )}
      <View style={styles.adds}>
        <ControlButton label="Ajouter une étape" onPress={() => edit(appendStep(plan), { node: plan.nodes.length, step: null })} style={styles.add} />
        <ControlButton label="Ajouter une répétition" onPress={() => edit(appendRepeat(plan, measure), null)} style={styles.add} />
      </View>
      {issue === null ? null : (
        <Text variant="small" tone="secondary" style={styles.issue}>
          {issue}
        </Text>
      )}
    </View>
  );
}

interface SharedProps {
  readonly plan: WorkoutPlan;
  readonly measure: Measure;
  readonly referenceSpeedMmS: number | null;
  readonly open: StepPath | null;
  readonly onToggle: (path: StepPath) => void;
  readonly onEdit: (plan: WorkoutPlan, open: StepPath | null) => void;
}

interface RepeatBlockProps extends SharedProps {
  readonly index: number;
  readonly repeat: WorkoutRepeat;
}

function RepeatBlock(props: RepeatBlockProps) {
  const { colors } = useTheme();
  const { plan, index, repeat, open, onToggle, onEdit } = props;
  const path: StepPath = { node: index, step: null };
  const expanded = samePath(open, path);
  const summary = repeat.steps.map(compactStep).join(" · ");
  const move = (offset: number): void => onEdit(moveAt(plan, path, offset), { node: index + offset, step: null });
  return (
    <View style={[styles.repeat, { borderColor: colors.controlBorder }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Répétition ${repeat.count} fois : ${summary}`}
        accessibilityState={{ expanded }}
        onPress={() => onToggle(path)}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfacePress }]}
      >
        <Text style={styles.count}>× {repeat.count}</Text>
        <Text variant="small" tone="secondary" numberOfLines={1} style={styles.main}>
          {summary}
        </Text>
        <Icon name={expanded ? "collapse" : "expand"} color={colors.text3} />
      </Pressable>
      {expanded ? (
        <View style={styles.fields}>
          <Stepper label="Répétitions" value={repeat.count} step={1} min={1} max={workoutLimits.maxRepeat} unit="fois" format={String} onChange={(count) => onEdit(setCount(plan, index, count), path)} />
          <View style={styles.actions}>
            {canAbsorbNext(plan, index) ? <ControlButton label="Inclure l'étape suivante" onPress={() => onEdit(absorbNext(plan, index), path)} style={styles.action} /> : null}
            <ControlButton label="Dégrouper" onPress={() => onEdit(ungroup(plan, index), null)} style={styles.action} />
            <ControlButton label="Dupliquer" onPress={() => onEdit(duplicateAt(plan, path), { node: index + 1, step: null })} style={styles.action} />
            <ControlButton label="Monter" disabled={!canMove(plan, path, -1)} onPress={() => move(-1)} style={styles.action} />
            <ControlButton label="Descendre" disabled={!canMove(plan, path, 1)} onPress={() => move(1)} style={styles.action} />
            <ControlButton label="Supprimer" disabled={plan.nodes.length === 1} onPress={() => onEdit(removeAt(plan, path), null)} style={styles.action} />
          </View>
        </View>
      ) : null}
      {repeat.steps.map((step, position) => (
        <StepRow key={position} {...props} path={{ node: index, step: position }} step={step} />
      ))}
    </View>
  );
}

interface StepRowProps extends SharedProps {
  readonly path: StepPath;
  readonly step: WorkoutStep;
}

function StepRow(props: StepRowProps) {
  const { colors } = useTheme();
  const { plan, path, step, open, onToggle } = props;
  const expanded = samePath(open, path);
  const title = step.label === null ? intentLabels[step.intent] : step.label.trim();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${stepDetail(step)}`}
        accessibilityState={{ expanded }}
        onPress={() => onToggle(path)}
        style={({ pressed }) => [styles.row, { borderBottomColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
      >
        <View style={[styles.intent, { backgroundColor: intentColor(step.intent, colors) }]} />
        <View style={styles.main}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="small" tone="secondary" numberOfLines={1}>
            {stepDetail(step)}
          </Text>
        </View>
        <Icon name={expanded ? "collapse" : "expand"} color={colors.text3} />
      </Pressable>
      {expanded ? <StepFields {...props} /> : null}
    </View>
  );
}

function StepFields({ plan, measure, referenceSpeedMmS, path, step, onEdit }: StepRowProps) {
  const speed = stepSpeedMmS(step.target, referenceSpeedMmS);
  const update = (next: WorkoutStep): void => onEdit(replaceStep(plan, path, next), path);
  const setTarget = (target: WorkoutTarget): void => update({ ...step, target });
  const move = (offset: number): void => onEdit(moveAt(plan, path, offset), path.step === null ? { node: path.node + offset, step: null } : { node: path.node, step: path.step + offset });
  const removed = removeAt(plan, path);
  return (
    <View style={styles.fields}>
      <Segmented<WorkoutIntent> options={workoutIntents.map((intent) => ({ value: intent, label: intentShortLabels[intent] }))} value={step.intent} onChange={(intent) => update({ ...step, intent })} />
      <Segmented<DurationKind> options={durationOptions} value={step.duration.kind} onChange={(kind) => update({ ...step, duration: durationOfKind(step.duration, kind, speed) })} />
      {step.duration.kind === "open" ? (
        <Text variant="small" tone="secondary">
          L'étape se termine avec le bouton Étape suivante.
        </Text>
      ) : (
        <View style={styles.duration}>
          <StepButton label="−" accessibilityLabel="Durée plus courte" onPress={() => update({ ...step, duration: stepDuration(step.duration, -1) })} />
          <Text variant="figure" style={styles.durationValue} accessibilityLabel={`Durée ${workoutDurationText(step.duration)}`}>
            {workoutDurationText(step.duration)}
          </Text>
          <StepButton label="+" accessibilityLabel="Durée plus longue" onPress={() => update({ ...step, duration: stepDuration(step.duration, 1) })} />
        </View>
      )}
      <Segmented<TargetKind> options={targetOptions(measure)} value={step.target.kind} onChange={(kind) => setTarget(step.target.kind === kind ? step.target : targetOfKind(kind, speed))} />
      <TargetFields target={step.target} onChange={setTarget} />
      <TextField
        value={step.label ?? ""}
        onChangeText={(label) => update({ ...step, label: label.trim() === "" ? null : label })}
        placeholder="Libellé (facultatif)"
        accessibilityLabel="Libellé de l'étape"
        maxLength={60}
      />
      <View style={styles.actions}>
        <ControlButton label="Dupliquer" onPress={() => onEdit(duplicateAt(plan, path), path.step === null ? { node: path.node + 1, step: null } : { node: path.node, step: path.step + 1 })} style={styles.action} />
        <ControlButton label="Monter" disabled={!canMove(plan, path, -1)} onPress={() => move(-1)} style={styles.action} />
        <ControlButton label="Descendre" disabled={!canMove(plan, path, 1)} onPress={() => move(1)} style={styles.action} />
        {path.step === null ? <ControlButton label="Répéter" onPress={() => onEdit(repeatStep(plan, path.node), { node: path.node, step: null })} style={styles.action} /> : null}
        <ControlButton label="Supprimer" disabled={removed.nodes.length === 0} onPress={() => onEdit(removed, null)} style={styles.action} />
      </View>
    </View>
  );
}

interface TargetFieldsProps {
  readonly target: WorkoutTarget;
  readonly onChange: (target: WorkoutTarget) => void;
}

function TargetFields({ target, onChange }: TargetFieldsProps) {
  switch (target.kind) {
    case "none":
      return null;
    case "pace":
      return (
        <View style={styles.range}>
          <RangeStepper label="Allure rapide" value={target.fastestSecondsPerKm} step={5} min={120} max={target.slowestSecondsPerKm - 5} unit="/km" format={formatClock} onChange={(value) => onChange({ ...target, fastestSecondsPerKm: value })} />
          <RangeStepper label="Allure lente" value={target.slowestSecondsPerKm} step={5} min={target.fastestSecondsPerKm + 5} max={1800} unit="/km" format={formatClock} onChange={(value) => onChange({ ...target, slowestSecondsPerKm: value })} />
        </View>
      );
    case "speed": {
      const low = Math.round(target.minMmS * 0.0072);
      const high = Math.round(target.maxMmS * 0.0072);
      const halfKmh = (value: number): string => formatNumber(value / 2);
      return (
        <View style={styles.range}>
          <RangeStepper label="Vitesse min" value={low} step={1} min={4} max={high - 1} unit="km/h" format={halfKmh} onChange={(value) => onChange({ ...target, minMmS: kmhToMmS(value / 2) })} />
          <RangeStepper label="Vitesse max" value={high} step={1} min={low + 1} max={216} unit="km/h" format={halfKmh} onChange={(value) => onChange({ ...target, maxMmS: kmhToMmS(value / 2) })} />
        </View>
      );
    }
    case "heart_rate_zone":
      return <Segmented<string> options={zones.map((zone) => ({ value: String(zone), label: `Z${zone}` }))} value={String(target.zone)} onChange={(value) => onChange({ kind: "heart_rate_zone", zone: Number(value) as HeartRateZoneTarget })} />;
    case "heart_rate":
      return (
        <View style={styles.range}>
          <RangeStepper label="FC min" value={target.minBpm} step={5} min={30} max={target.maxBpm - 5} unit="bpm" format={String} onChange={(value) => onChange({ ...target, minBpm: value })} />
          <RangeStepper label="FC max" value={target.maxBpm} step={5} min={target.minBpm + 5} max={240} unit="bpm" format={String} onChange={(value) => onChange({ ...target, maxBpm: value })} />
        </View>
      );
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

interface RangeStepperProps {
  readonly label: string;
  readonly value: number;
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
}

function RangeStepper({ label, ...stepper }: RangeStepperProps) {
  return (
    <View style={styles.rangeField}>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
      <Stepper label={label} {...stepper} />
    </View>
  );
}

const styles = StyleSheet.create({
  estimate: { marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, minWidth: 0, gap: 2 },
  intent: { width: 4, alignSelf: "stretch", borderRadius: 2 },
  repeat: { marginVertical: 6, paddingHorizontal: 8, borderWidth: 1, borderRadius: radii.panel },
  count: { fontFamily: fonts.figure700, fontSize: 18, lineHeight: 22, minWidth: 44 },
  fields: { gap: 10, paddingVertical: 12 },
  duration: { flexDirection: "row", alignItems: "center", gap: 6 },
  durationValue: { flex: 1, textAlign: "center" },
  range: { gap: 8 },
  rangeField: { gap: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  action: { flexGrow: 1 },
  adds: { flexDirection: "row", gap: 8, marginTop: 12 },
  add: { flex: 1 },
  issue: { marginTop: 8 },
});
