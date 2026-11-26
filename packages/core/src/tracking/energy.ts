import type { BiologicalSex, EnergyMethod, EpochMs, FieldValues, SportKey } from "@obnixe/schema";
import { forEachSensorSpan, powerReadings } from "./sensors.ts";
import type { HeartRateColumns, PowerColumns } from "./types.ts";
import { ageAt, forEachHeartRateSpan, SpanOverlap } from "./zones.ts";
import type { TimeSpan } from "./zones.ts";

/** Grade bound of the Minetti et al. (2002) polynomials, outside of which they were not measured. */
export const minettiGradeBound = 0.45;
/** Share of the moving time a heart rate must cover for the `heart_rate` method (`CAL-002`). */
export const heartRateEnergyCoverage = 0.8;
/** Share of the moving time a power meter must cover for the `power` method (`CAL-002`). */
export const powerEnergyCoverage = 0.8;
/** Gross cycling efficiency of the `power` method: mechanical work over metabolic energy, resting metabolism included. */
export const grossCyclingEfficiency = 0.24;
/** Under this rate the Keytel equations do not hold and the resting rate is used instead. */
export const keytelMinimumBpm = 90;

const joulesPerKcal = 4184;
const msPerHour = 3_600_000;
const msPerMinute = 60_000;
const metersPerSecondPerMph = 0.44704;

function clampGrade(grade: number): number {
  return Math.min(Math.max(grade, -minettiGradeBound), minettiGradeBound);
}

/** Energy cost of running on a grade (fraction), in J/kg/m (Minetti et al. 2002; `GPS-050`, `CAL-002`). */
export function minettiRunningCost(grade: number): number {
  const i = clampGrade(grade);
  return ((((155.4 * i - 30.4) * i - 43.3) * i + 46.3) * i + 19.5) * i + 3.6;
}

/** Energy cost of walking on a grade (fraction), in J/kg/m (Minetti et al. 2002). */
export function minettiWalkingCost(grade: number): number {
  const i = clampGrade(grade);
  return ((((280.5 * i - 58.7) * i - 76.8) * i + 51.9) * i + 19.6) * i + 2.5;
}

/** Gross energy rate from heart rate, in kcal/min (Keytel et al. 2005). */
export function keytelKcalPerMinute(sex: BiologicalSex, bpm: number, massKg: number, age: number): number {
  switch (sex) {
    case "male":
      return (-55.0969 + 0.6309 * bpm + 0.1988 * massKg + 0.2017 * age) / 4.184;
    case "female":
      return (-20.4022 + 0.4472 * bpm - 0.1263 * massKg + 0.074 * age) / 4.184;
    default: {
      const unreachable: never = sex;
      throw new Error(`Unhandled sex ${String(unreachable)}`);
    }
  }
}

/** One value of the 2024 Adult Compendium of Physical Activities. */
export interface MetEntry {
  readonly code: string;
  readonly met: number;
  readonly activity: string;
}

/**
 * Compendium 2024 values used by the `met` method (`CAL-002`). Changing a value changes stored estimates: it must come with a
 * `trackingAlgorithmVersion` bump.
 */
export const metTable = {
  runSelfPaced: { code: "12145", met: 10.5, activity: "Running, self-selected pace" },
  runEasy: { code: "12020", met: 7.5, activity: "Jogging, general, self-selected pace" },
  runTempo: { code: "12090", met: 12.0, activity: "Running, 8 mph (7.5 min/mile)" },
  runIntervals: { code: "12180", met: 10.0, activity: "Running, on a track, team practice" },
  runLong: { code: "12150", met: 8.0, activity: "Running (Taylor Code 200)" },
  runRace: { code: "12200", met: 13.3, activity: "Running, marathon" },
  trail: { code: "12140", met: 9.3, activity: "Running, cross country" },
  trailVertical: { code: "12345", met: 16.3, activity: "Running uphill, >1.6mph, 10-30% incline" },
  walkPleasure: { code: "17160", met: 3.5, activity: "Walking for pleasure (Taylor Code 010)" },
  walkStroll: { code: "17151", met: 2.3, activity: "Walking, less than 2.0 mph, level, strolling, very slow" },
  walkBrisk: { code: "17200", met: 4.8, activity: "Walking, 3.5 to 3.9 mph, level, brisk, firm surface, walking for exercise" },
  walkNordic: { code: "17304", met: 5.3, activity: "Walking, for exercise, 3.6 to 4.4 mph, with ski poles, Nordic walking, level, moderate pace" },
  walkCommute: { code: "17270", met: 4.0, activity: "Walking, to work or class (Taylor Code 015)" },
  hikeCrossCountry: { code: "17080", met: 6.0, activity: "Hiking, cross country (Taylor Code 040)" },
  hikeTrail: { code: "17082", met: 5.3, activity: "Hiking or walking at a normal pace through fields and hillsides, no load" },
  hikeMountain: { code: "17012", met: 7.8, activity: "Backpacking, hiking with a daypack, organized walking with daypack" },
  hikeSnow: { code: "19190", met: 5.3, activity: "Snow shoeing, moderate effort" },
  bikeGeneral: { code: "01014", met: 7.0, activity: "Bicycling, general" },
  bikeDirtRoad: { code: "01013", met: 5.8, activity: "Bicycling, on dirt or farm road, moderate pace" },
  bikeCommute: { code: "01011", met: 6.8, activity: "Bicycling, to/from work, self selected pace" },
  bikeMountain: { code: "01009", met: 8.5, activity: "Bicycling, mountain, general" },
  bikeStationary: { code: "01200", met: 6.8, activity: "Bicycling, stationary, general" },
  bikeElectric: { code: "01084", met: 6.0, activity: "E-bike (electrically assisted) with light electronic support" },
  bikeUnder10Mph: { code: "01010", met: 4.0, activity: "Bicycling, <10 mph, leisure, to work or for pleasure (Taylor Code 115)" },
  bike10To12Mph: { code: "01020", met: 6.8, activity: "Bicycling, 10-11.9 mph, leisure, slow, light effort" },
  bike12To14Mph: { code: "01030", met: 8.0, activity: "Bicycling, 12-13.9 mph, leisure, moderate effort" },
  bike14To16Mph: { code: "01040", met: 10.0, activity: "Bicycling, 14-15.9 mph, racing or leisure, fast, vigorous effort" },
  bike16To20Mph: { code: "01050", met: 12.0, activity: "Bicycling, 16-19 mph, racing/not drafting or >19 mph drafting, very fast, racing general" },
  bikeOver20Mph: { code: "01060", met: 16.8, activity: "Bicycling, >20 mph, racing, not drafting" },
  swimLaps: { code: "18240", met: 5.8, activity: "Swimming laps, freestyle, slow, recreational" },
  swimCrawl: { code: "18290", met: 8.0, activity: "Swimming, crawl, medium speed, ~50 yards/minute, vigorous effort" },
  swimBreaststroke: { code: "18265", met: 5.3, activity: "Swimming breaststroke, recreational" },
  swimDrills: { code: "18292", met: 5.8, activity: "Swimming, crawl, slow speed, 30-45 yards/minute, moderate effort" },
  swimOpenWater: { code: "18300", met: 6.0, activity: "Swimming, lake, ocean, river (Taylor Codes 280, 295)" },
  skiTouring: { code: "19090", met: 9.0, activity: "Skiing, cross country, 4.0-4.9 mph, moderate speed and effort, general" },
  skiMountaineering: { code: "19130", met: 15.5, activity: "Skiing, cross country, hard snow, uphill, maximum, snow mountaineering" },
  nordicSkiSlow: { code: "19080", met: 6.8, activity: "Skiing, cross country, 2.5 mph, slow or light effort, ski walking" },
  nordicSkiModerate: { code: "19090", met: 9.0, activity: "Skiing, cross country, 4.0-4.9 mph, moderate speed and effort, general" },
  nordicSkiBrisk: { code: "19100", met: 12.5, activity: "Skiing, cross country, 5.0-7.9 mph, brisk speed, vigorous effort" },
  nordicSkiRacing: { code: "19110", met: 15.0, activity: "Skiing, cross country, >8.0 mph, elite skier, racing" },
  nordicSkiSkating: { code: "19135", met: 13.3, activity: "Skiing, cross-country, skating" },
  alpineSki: { code: "19160", met: 5.3, activity: "Skiing, downhill, alpine or snowboarding, moderate effort, general, active time only" },
  kayak: { code: "18100", met: 5.0, activity: "Kayaking, moderate effort" },
  canoe: { code: "18070", met: 3.5, activity: "Canoeing, rowing, for pleasure, general" },
  standUpPaddle: { code: "18365", met: 6.0, activity: "Paddle boarding, standing" },
  rowing: { code: "18050", met: 5.8, activity: "Canoeing, rowing, 4.0-5.9 mph, moderate effort" },
  inlineRecreational: { code: "15591", met: 7.5, activity: "Rollerblading, in-line skating, 14.4 km/h (9.0 mph), recreational pace" },
  inlineModerate: { code: "15592", met: 9.8, activity: "Rollerblading, in-line skating, 17.7 km/h (11.0 mph), moderate pace, exercise training" },
  inlineFast: { code: "15593", met: 12.3, activity: "Rollerblading, in-line skating, 21.0 to 21.7 km/h (13.0 to 13.6 mph), fast pace, exercise training" },
  inlineMaximal: { code: "15594", met: 14.0, activity: "Rollerblading, in-line skating, 24.0 km/h (15.0 mph), maximal effort" },
} as const satisfies Record<string, MetEntry>;

interface SpeedBand {
  readonly minSpeed: number;
  readonly entry: MetEntry;
}

/** Outdoor cycling by mean moving speed, lower bounds in m/s, fastest first. */
const bikeSpeedBands: readonly SpeedBand[] = [
  { minSpeed: 20 * metersPerSecondPerMph, entry: metTable.bikeOver20Mph },
  { minSpeed: 16 * metersPerSecondPerMph, entry: metTable.bike16To20Mph },
  { minSpeed: 14 * metersPerSecondPerMph, entry: metTable.bike14To16Mph },
  { minSpeed: 12 * metersPerSecondPerMph, entry: metTable.bike12To14Mph },
  { minSpeed: 10 * metersPerSecondPerMph, entry: metTable.bike10To12Mph },
  { minSpeed: 0, entry: metTable.bikeUnder10Mph },
];

/** Classic cross-country skiing by mean moving speed, lower bounds in m/s, fastest first. */
const nordicSpeedBands: readonly SpeedBand[] = [
  { minSpeed: 8 * metersPerSecondPerMph, entry: metTable.nordicSkiRacing },
  { minSpeed: 5 * metersPerSecondPerMph, entry: metTable.nordicSkiBrisk },
  { minSpeed: 4 * metersPerSecondPerMph, entry: metTable.nordicSkiModerate },
  { minSpeed: 0, entry: metTable.nordicSkiSlow },
];

/** In-line skating by mean moving speed, at the speeds the Compendium names, fastest first. */
const inlineSpeedBands: readonly SpeedBand[] = [
  { minSpeed: 24 / 3.6, entry: metTable.inlineMaximal },
  { minSpeed: 21 / 3.6, entry: metTable.inlineFast },
  { minSpeed: 17.7 / 3.6, entry: metTable.inlineModerate },
  { minSpeed: 0, entry: metTable.inlineRecreational },
];

function choice(values: FieldValues, key: string): string | null {
  const value = values[key];
  return typeof value === "string" ? value : null;
}

function bikeEntry(values: FieldValues, movingSpeed: number | null): MetEntry {
  if (values.e_bike === true) return metTable.bikeElectric;
  const kind = choice(values, "kind");
  if (kind === "indoor") return metTable.bikeStationary;
  if (kind === "mtb") return metTable.bikeMountain;
  if (movingSpeed !== null) return bikeSpeedBands.find((band) => movingSpeed >= band.minSpeed)?.entry ?? metTable.bikeUnder10Mph;
  if (kind === "gravel") return metTable.bikeDirtRoad;
  if (kind === "commute") return metTable.bikeCommute;
  return metTable.bikeGeneral;
}

function nordicSkiEntry(values: FieldValues, movingSpeed: number | null): MetEntry {
  if (choice(values, "kind") === "skate") return metTable.nordicSkiSkating;
  if (movingSpeed === null) return metTable.nordicSkiModerate;
  return nordicSpeedBands.find((band) => movingSpeed >= band.minSpeed)?.entry ?? metTable.nordicSkiSlow;
}

function inlineSkateEntry(values: FieldValues, movingSpeed: number | null): MetEntry {
  if (movingSpeed !== null) return inlineSpeedBands.find((band) => movingSpeed >= band.minSpeed)?.entry ?? metTable.inlineRecreational;
  return choice(values, "kind") === "speed" ? metTable.inlineFast : metTable.inlineRecreational;
}

function paddleEntry(values: FieldValues): MetEntry {
  switch (choice(values, "kind")) {
    case "canoe":
      return metTable.canoe;
    case "sup":
      return metTable.standUpPaddle;
    case "rowing":
      return metTable.rowing;
    default:
      return metTable.kayak;
  }
}

/** Compendium value for a sport, its variant and, for cycling, the mean moving speed in m/s; `null` for sports never recorded. */
export function metEntryFor(sport: SportKey, values: FieldValues, movingSpeed: number | null): MetEntry | null {
  const kind = choice(values, "kind");
  switch (sport) {
    case "run":
      if (kind === "easy") return metTable.runEasy;
      if (kind === "tempo") return metTable.runTempo;
      if (kind === "intervals") return metTable.runIntervals;
      if (kind === "long") return metTable.runLong;
      if (kind === "race") return metTable.runRace;
      return metTable.runSelfPaced;
    case "trail":
      return kind === "vertical" ? metTable.trailVertical : metTable.trail;
    case "walk":
      if (kind === "stroll") return metTable.walkStroll;
      if (kind === "brisk") return metTable.walkBrisk;
      if (kind === "nordic") return metTable.walkNordic;
      if (kind === "commute") return metTable.walkCommute;
      return metTable.walkPleasure;
    case "hike":
      if (kind === "trail") return metTable.hikeTrail;
      if (kind === "mountain") return metTable.hikeMountain;
      if (kind === "snow") return metTable.hikeSnow;
      return metTable.hikeCrossCountry;
    case "bike":
      return bikeEntry(values, movingSpeed);
    case "swim":
      if (choice(values, "water") === "open_water") return metTable.swimOpenWater;
      if (kind === "crawl") return metTable.swimCrawl;
      if (kind === "breaststroke") return metTable.swimBreaststroke;
      if (kind === "drills") return metTable.swimDrills;
      return metTable.swimLaps;
    case "ski_touring":
      return kind === "race" ? metTable.skiMountaineering : metTable.skiTouring;
    case "nordic_ski":
      return nordicSkiEntry(values, movingSpeed);
    case "alpine_ski":
      return metTable.alpineSki;
    case "paddle":
      return paddleEntry(values);
    case "inline_skate":
      return inlineSkateEntry(values, movingSpeed);
    case "strength":
    case "climb":
    case "yoga":
      return null;
    default: {
      const unreachable: never = sport;
      throw new Error(`Unhandled sport ${String(unreachable)}`);
    }
  }
}

/** Track columns the `mechanical` method integrates over, one entry per point. */
export interface EnergyPath {
  /** Cumulative counted horizontal distance in meters (`GPS-037`): flat over stops and unfilled gaps. */
  readonly distance: Float64Array;
  /** Smoothed grade (`gradeSeries`), `NaN` where none was computed. */
  readonly grade: Float64Array;
}

export interface EnergyActivity {
  readonly sport: SportKey;
  /** Session values: variant, `e_bike`, `water`, `pack_mass` in grams. */
  readonly values: FieldValues;
  readonly startedAt: EpochMs;
  /** Elapsed window after trimming, on the time base of the samples. */
  readonly elapsed: TimeSpan;
  /** Moving intervals, sorted, disjoint and inside `elapsed`. */
  readonly moving: readonly TimeSpan[];
  readonly distanceMm: number;
  /** `null` without a track (stopwatch only, imports without positions). */
  readonly path: EnergyPath | null;
  readonly heartRate: HeartRateColumns | null;
  /** Detected descents (`runs`), sorted; `null` without a track. Downhill skiing counts its MET over their moving time only. */
  readonly descents: readonly TimeSpan[] | null;
  readonly power: PowerColumns | null;
}

export interface EnergyBody {
  /** Last weigh-in before the start (`CAL-003`). */
  readonly massGrams: number;
  readonly birthYear: number | null;
  readonly sex: BiologicalSex | null;
}

export interface EnergyEstimate {
  readonly kcal: number;
  readonly method: EnergyMethod;
  /** The Compendium value, for the `met` method only. */
  readonly met: MetEntry | null;
}

function totalMs(spans: readonly TimeSpan[]): number {
  return spans.reduce((total, span) => total + span.endMs - span.startMs, 0);
}

function movingWithin(moving: readonly TimeSpan[], spans: readonly TimeSpan[]): number {
  const overlap = new SpanOverlap(moving);
  return spans.reduce((total, span) => total + overlap.of(span.startMs, span.endMs), 0);
}

function restingKcal(massKg: number, durationMs: number): number {
  return (massKg * durationMs) / msPerHour;
}

/** Keytel over the time a reading holds; uncovered moving time at the mean covered moving rate, uncovered stops at rest. */
function heartRateKcal(activity: EnergyActivity, heartRate: HeartRateColumns, sex: BiologicalSex, massKg: number, age: number, movingMs: number): number | null {
  const overlap = new SpanOverlap(activity.moving);
  let coveredMs = 0;
  let coveredMovingMs = 0;
  let coveredKcal = 0;
  let coveredMovingKcal = 0;
  forEachHeartRateSpan(heartRate, activity.elapsed, (startMs, endMs, bpm) => {
    const ratePerMs = bpm < keytelMinimumBpm ? massKg / msPerHour : Math.max(keytelKcalPerMinute(sex, bpm, massKg, age) / msPerMinute, massKg / msPerHour);
    const duration = endMs - startMs;
    const moving = overlap.of(startMs, endMs);
    coveredMs += duration;
    coveredKcal += ratePerMs * duration;
    coveredMovingMs += moving;
    coveredMovingKcal += ratePerMs * moving;
  });
  if (coveredMovingMs < heartRateEnergyCoverage * movingMs) return null;
  const elapsedMs = activity.elapsed.endMs - activity.elapsed.startMs;
  const uncoveredMovingMs = movingMs - coveredMovingMs;
  const uncoveredStoppedMs = elapsedMs - coveredMs - uncoveredMovingMs;
  return coveredKcal + (coveredMovingKcal / coveredMovingMs) * uncoveredMovingMs + restingKcal(massKg, Math.max(uncoveredStoppedMs, 0));
}

/**
 * Mechanical work over the moving time a reading holds, the uncovered moving time at the mean covered power, over the gross
 * efficiency; stops at rest. `null` when the meter covers less than `powerEnergyCoverage` of the moving time.
 */
function powerKcal(activity: EnergyActivity, power: PowerColumns, massKg: number, movingMs: number): number | null {
  const overlap = new SpanOverlap(activity.moving);
  let coveredMovingMs = 0;
  let joules = 0;
  forEachSensorSpan(powerReadings(power), activity.elapsed, (startMs, endMs, watts) => {
    const moving = overlap.of(startMs, endMs);
    coveredMovingMs += moving;
    joules += (watts * moving) / 1000;
  });
  if (coveredMovingMs <= 0 || coveredMovingMs < powerEnergyCoverage * movingMs) return null;
  const work = joules * (movingMs / coveredMovingMs);
  const elapsedMs = activity.elapsed.endMs - activity.elapsed.startMs;
  return work / (joulesPerKcal * grossCyclingEfficiency) + restingKcal(massKg, Math.max(elapsedMs - movingMs, 0));
}

/** Minetti cost integrated over the counted distance with the carried mass, plus 1 MET over the elapsed time. */
function mechanicalKcal(path: EnergyPath, cost: (grade: number) => number, carriedKg: number, massKg: number, elapsedMs: number): number {
  let joulesPerKg = 0;
  for (let index = 1; index < path.distance.length; index += 1) {
    const step = (path.distance[index] ?? 0) - (path.distance[index - 1] ?? 0);
    if (step <= 0) continue;
    const grade = path.grade[index] ?? Number.NaN;
    joulesPerKg += cost(Number.isNaN(grade) ? 0 : grade) * step;
  }
  return (carriedKg * joulesPerKg) / joulesPerKcal + restingKcal(massKg, elapsedMs);
}

function footCost(sport: SportKey): ((grade: number) => number) | null {
  switch (sport) {
    case "run":
    case "trail":
      return minettiRunningCost;
    case "walk":
    case "hike":
      return minettiWalkingCost;
    case "strength":
    case "swim":
    case "bike":
    case "ski_touring":
    case "nordic_ski":
    case "alpine_ski":
    case "paddle":
    case "inline_skate":
    case "climb":
    case "yoga":
      return null;
    default: {
      const unreachable: never = sport;
      throw new Error(`Unhandled sport ${String(unreachable)}`);
    }
  }
}

/**
 * Gross energy estimate by the first applicable method (`CAL-001`, `CAL-002`): `power` for a bike ride whose power meter covers
 * 80 % of the moving time (`SPT-008`), `heart_rate` (Keytel) when a heart rate covers
 * 80 % of the moving time and the birth year and sex are known, `mechanical` (Minetti) for foot sports with a track, otherwise
 * `met`. `null` for sports never recorded.
 */
export function estimateEnergy(activity: EnergyActivity, body: EnergyBody): EnergyEstimate | null {
  const massKg = body.massGrams / 1000;
  const elapsedMs = activity.elapsed.endMs - activity.elapsed.startMs;
  const movingMs = totalMs(activity.moving);
  if (activity.sport === "bike" && activity.power !== null && movingMs > 0) {
    const kcal = powerKcal(activity, activity.power, massKg, movingMs);
    if (kcal !== null) return { kcal: Math.round(kcal), method: "power", met: null };
  }
  if (activity.heartRate !== null && body.birthYear !== null && body.sex !== null && movingMs > 0) {
    const kcal = heartRateKcal(activity, activity.heartRate, body.sex, massKg, ageAt(body.birthYear, activity.startedAt), movingMs);
    if (kcal !== null) return { kcal: Math.round(kcal), method: "heart_rate", met: null };
  }
  const cost = footCost(activity.sport);
  if (cost !== null && activity.path !== null && activity.path.distance.length > 1) {
    const pack = activity.sport === "hike" && typeof activity.values.pack_mass === "number" ? activity.values.pack_mass / 1000 : 0;
    return { kcal: Math.round(mechanicalKcal(activity.path, cost, massKg + pack, massKg, elapsedMs)), method: "mechanical", met: null };
  }
  const movingSpeed = movingMs > 0 && activity.distanceMm > 0 ? activity.distanceMm / movingMs : null;
  const met = metEntryFor(activity.sport, activity.values, movingSpeed);
  if (met === null) return null;
  const activeMs = activity.sport === "alpine_ski" && activity.descents !== null ? movingWithin(activity.moving, activity.descents) : movingMs;
  const kcal = (met.met * massKg * activeMs) / msPerHour + restingKcal(massKg, Math.max(elapsedMs - activeMs, 0));
  return { kcal: Math.round(kcal), method: "met", met };
}
