import type { FieldValues } from "../fields.ts";

export const metricKeys = [
  "elapsed",
  "moving",
  "distance",
  "pace_avg",
  "pace_now",
  "pace_lap",
  "gap_avg",
  "gap_now",
  "speed_avg",
  "speed_now",
  "speed_max",
  "ascent",
  "descent",
  "altitude",
  "altitude_min",
  "altitude_max",
  "grade_now",
  "vam",
  "vertical_speed",
  "cadence",
  "steps",
  "heart_rate",
  "heart_rate_avg",
  "heart_rate_max",
  "heart_rate_zone",
  "power",
  "power_avg",
  "energy",
  "gps_quality",
  "clock",
  /** The current step of a guided workout; the main metric while one runs, never in a profile's `metrics`. */
  "workout_step",
  "route_remaining",
  "route_ascent_remaining",
  "route_progress",
] as const;
export type MetricKey = (typeof metricKeys)[number];

/** Classifier hysteresis: start when any start condition holds for `startAfterMs`, stop when every stop condition holds for `stopAfterMs`. */
export interface MotionThresholds {
  readonly startSpeedMmS: number;
  readonly stopSpeedMmS: number;
  readonly startVerticalMmS: number | null;
  readonly stopVerticalMmS: number | null;
  readonly startCadence: number | null;
  readonly stopCadence: number | null;
  readonly startAfterMs: number;
  readonly stopAfterMs: number;
}

export interface Readout {
  readonly main: MetricKey;
  readonly secondary: readonly MetricKey[];
}

/** Every signal-processing threshold of a sport lives here or in the versioned algorithm constants, nowhere else. */
export interface RecordingProfile {
  readonly primary: "pace" | "speed";
  readonly pacePerMeters: 1000 | 100;
  readonly splitMeters: number | null;
  readonly accuracyGateDm: number;
  readonly maxSpeedMmS: number;
  readonly maxAccelerationMmS2: number;
  readonly accelerationNoiseMmS2: number;
  readonly speedSmoothingMs: number;
  readonly motion: MotionThresholds;
  readonly autoPauseDefault: boolean;
  readonly gradeAdjustedPace: boolean;
  readonly cadence: "steps" | "none";
  readonly metrics: readonly MetricKey[];
  readonly readout: Readout;
  readonly bestEffortMeters: readonly number[];
  readonly bestAscentWindowMs: number | null;
  /** Least D+ of a detected climb (`GPS-062`); null for the sports without climbs. */
  readonly climbMinimumAscentMeters: number | null;
  /** Least D- of a detected descent (`runs`); null for the sports without descents. */
  readonly descentMinimumMeters: number | null;
  /** Session values every recorded activity of the sport carries, written at the stop. */
  readonly recordedValues: FieldValues;
}

/** Overrides keyed by an option of the choice field `field`; a `null` override disables GPS recording for that option. */
export interface RecordingOverrides {
  readonly field: string;
  readonly byOption: Readonly<Record<string, Partial<RecordingProfile> | null>>;
}

const runningDistances = [400, 1000, 1609.344, 5000, 10000, 15000, 21097.5, 30000, 42195, 50000] as const;
const oneHourMs = 3_600_000;

export const runProfile: RecordingProfile = {
  primary: "pace",
  pacePerMeters: 1000,
  splitMeters: 1000,
  accuracyGateDm: 300,
  maxSpeedMmS: 13000,
  maxAccelerationMmS2: 6000,
  accelerationNoiseMmS2: 1500,
  speedSmoothingMs: 6000,
  motion: { startSpeedMmS: 1000, stopSpeedMmS: 600, startVerticalMmS: null, stopVerticalMmS: null, startCadence: 120, stopCadence: 50, startAfterMs: 2000, stopAfterMs: 4000 },
  autoPauseDefault: true,
  gradeAdjustedPace: true,
  cadence: "steps",
  metrics: [
    "elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "gap_avg", "gap_now", "speed_avg", "speed_now", "speed_max",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now", "cadence", "steps",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "power", "power_avg", "energy", "gps_quality", "clock",
    "route_remaining", "route_ascent_remaining", "route_progress",
  ],
  readout: { main: "pace_now", secondary: ["distance", "moving", "pace_avg", "cadence"] },
  bestEffortMeters: runningDistances,
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: null,
  descentMinimumMeters: null,
  recordedValues: {},
};

export const trailProfile: RecordingProfile = {
  primary: "pace",
  pacePerMeters: 1000,
  splitMeters: 1000,
  accuracyGateDm: 300,
  maxSpeedMmS: 10000,
  maxAccelerationMmS2: 6000,
  accelerationNoiseMmS2: 1500,
  speedSmoothingMs: 6000,
  motion: { startSpeedMmS: 500, stopSpeedMmS: 300, startVerticalMmS: 100, stopVerticalMmS: 50, startCadence: 70, stopCadence: 30, startAfterMs: 2000, stopAfterMs: 6000 },
  autoPauseDefault: true,
  gradeAdjustedPace: true,
  cadence: "steps",
  metrics: [
    "elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "gap_avg", "gap_now", "speed_avg", "speed_now", "speed_max",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now", "vam", "vertical_speed", "cadence", "steps",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "power", "power_avg", "energy", "gps_quality", "clock",
    "route_remaining", "route_ascent_remaining", "route_progress",
  ],
  readout: { main: "distance", secondary: ["moving", "ascent", "vertical_speed", "pace_now"] },
  bestEffortMeters: runningDistances,
  bestAscentWindowMs: oneHourMs,
  climbMinimumAscentMeters: 50,
  descentMinimumMeters: null,
  recordedValues: {},
};

export const walkProfile: RecordingProfile = {
  primary: "pace",
  pacePerMeters: 1000,
  splitMeters: 1000,
  accuracyGateDm: 300,
  maxSpeedMmS: 4000,
  maxAccelerationMmS2: 3000,
  accelerationNoiseMmS2: 1000,
  speedSmoothingMs: 6000,
  motion: { startSpeedMmS: 500, stopSpeedMmS: 300, startVerticalMmS: null, stopVerticalMmS: null, startCadence: 60, stopCadence: 20, startAfterMs: 3000, stopAfterMs: 6000 },
  autoPauseDefault: false,
  gradeAdjustedPace: false,
  cadence: "steps",
  metrics: [
    "elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "speed_avg", "speed_now",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "cadence", "steps",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
    "route_remaining", "route_ascent_remaining", "route_progress",
  ],
  readout: { main: "moving", secondary: ["distance", "pace_now", "steps"] },
  bestEffortMeters: [1000, 5000, 10000, 21097.5],
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: null,
  descentMinimumMeters: null,
  recordedValues: {},
};

export const hikeProfile: RecordingProfile = {
  primary: "speed",
  pacePerMeters: 1000,
  splitMeters: 1000,
  accuracyGateDm: 500,
  maxSpeedMmS: 4000,
  maxAccelerationMmS2: 3000,
  accelerationNoiseMmS2: 1000,
  speedSmoothingMs: 6000,
  motion: { startSpeedMmS: 400, stopSpeedMmS: 250, startVerticalMmS: 80, stopVerticalMmS: 40, startCadence: 50, stopCadence: 15, startAfterMs: 3000, stopAfterMs: 10000 },
  autoPauseDefault: false,
  gradeAdjustedPace: false,
  cadence: "steps",
  metrics: [
    "elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "speed_avg", "speed_now",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now", "vam", "vertical_speed", "cadence", "steps",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
    "route_remaining", "route_ascent_remaining", "route_progress",
  ],
  readout: { main: "elapsed", secondary: ["distance", "ascent", "altitude", "vam"] },
  bestEffortMeters: [],
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: 50,
  descentMinimumMeters: null,
  recordedValues: {},
};

export const bikeProfile: RecordingProfile = {
  primary: "speed",
  pacePerMeters: 1000,
  splitMeters: 5000,
  accuracyGateDm: 300,
  maxSpeedMmS: 33000,
  maxAccelerationMmS2: 8000,
  accelerationNoiseMmS2: 2500,
  speedSmoothingMs: 3000,
  motion: { startSpeedMmS: 1600, stopSpeedMmS: 1000, startVerticalMmS: null, stopVerticalMmS: null, startCadence: null, stopCadence: null, startAfterMs: 2000, stopAfterMs: 3000 },
  autoPauseDefault: true,
  gradeAdjustedPace: false,
  cadence: "none",
  metrics: [
    "elapsed", "moving", "distance", "speed_avg", "speed_now", "speed_max",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now", "vam", "vertical_speed", "cadence",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "power", "power_avg", "energy", "gps_quality", "clock",
    "route_remaining", "route_ascent_remaining", "route_progress",
  ],
  readout: { main: "speed_now", secondary: ["distance", "moving", "speed_avg", "ascent"] },
  bestEffortMeters: [10000, 20000, 40000, 50000, 100000, 160934],
  bestAscentWindowMs: oneHourMs,
  climbMinimumAscentMeters: 30,
  descentMinimumMeters: null,
  recordedValues: {},
};

const glidingDistances = [1000, 5000, 10000, 20000] as const;

export const skiTouringProfile: RecordingProfile = {
  primary: "speed",
  pacePerMeters: 1000,
  splitMeters: null,
  accuracyGateDm: 500,
  maxSpeedMmS: 40000,
  maxAccelerationMmS2: 10000,
  accelerationNoiseMmS2: 4000,
  speedSmoothingMs: 2000,
  motion: { startSpeedMmS: 400, stopSpeedMmS: 200, startVerticalMmS: 80, stopVerticalMmS: 40, startCadence: null, stopCadence: null, startAfterMs: 3000, stopAfterMs: 10000 },
  autoPauseDefault: false,
  gradeAdjustedPace: false,
  cadence: "none",
  metrics: [
    "elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "speed_avg", "speed_now", "speed_max",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now", "vam", "vertical_speed",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "ascent", secondary: ["elapsed", "vertical_speed", "altitude", "distance"] },
  bestEffortMeters: [],
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: 50,
  descentMinimumMeters: 50,
  recordedValues: {},
};

export const nordicSkiProfile: RecordingProfile = {
  primary: "pace",
  pacePerMeters: 1000,
  splitMeters: 1000,
  accuracyGateDm: 300,
  maxSpeedMmS: 20000,
  maxAccelerationMmS2: 8000,
  accelerationNoiseMmS2: 2500,
  speedSmoothingMs: 2000,
  motion: { startSpeedMmS: 1000, stopSpeedMmS: 600, startVerticalMmS: null, stopVerticalMmS: null, startCadence: null, stopCadence: null, startAfterMs: 2000, stopAfterMs: 4000 },
  autoPauseDefault: true,
  gradeAdjustedPace: false,
  cadence: "none",
  metrics: [
    "elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "speed_avg", "speed_now", "speed_max",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "speed_now", secondary: ["distance", "moving", "pace_avg", "ascent"] },
  bestEffortMeters: glidingDistances,
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: null,
  descentMinimumMeters: null,
  recordedValues: {},
};

export const alpineSkiProfile: RecordingProfile = {
  primary: "speed",
  pacePerMeters: 1000,
  splitMeters: null,
  accuracyGateDm: 300,
  maxSpeedMmS: 40000,
  maxAccelerationMmS2: 10000,
  accelerationNoiseMmS2: 4000,
  speedSmoothingMs: 2000,
  motion: { startSpeedMmS: 1500, stopSpeedMmS: 800, startVerticalMmS: null, stopVerticalMmS: null, startCadence: null, stopCadence: null, startAfterMs: 2000, stopAfterMs: 5000 },
  autoPauseDefault: false,
  gradeAdjustedPace: false,
  cadence: "none",
  metrics: [
    "elapsed", "moving", "distance", "speed_avg", "speed_now", "speed_max",
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "speed_now", secondary: ["descent", "speed_max", "altitude", "elapsed"] },
  bestEffortMeters: [],
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: null,
  descentMinimumMeters: 30,
  recordedValues: {},
};

export const paddleProfile: RecordingProfile = {
  primary: "speed",
  pacePerMeters: 1000,
  splitMeters: 1000,
  accuracyGateDm: 300,
  maxSpeedMmS: 8000,
  maxAccelerationMmS2: 3000,
  accelerationNoiseMmS2: 800,
  speedSmoothingMs: 6000,
  motion: { startSpeedMmS: 500, stopSpeedMmS: 300, startVerticalMmS: null, stopVerticalMmS: null, startCadence: null, stopCadence: null, startAfterMs: 3000, stopAfterMs: 6000 },
  autoPauseDefault: false,
  gradeAdjustedPace: false,
  cadence: "none",
  metrics: [
    "elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "speed_avg", "speed_now", "speed_max",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "speed_now", secondary: ["distance", "moving", "pace_avg"] },
  bestEffortMeters: glidingDistances,
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: null,
  descentMinimumMeters: null,
  recordedValues: {},
};

export const inlineSkateProfile: RecordingProfile = {
  primary: "speed",
  pacePerMeters: 1000,
  splitMeters: 1000,
  accuracyGateDm: 300,
  maxSpeedMmS: 20000,
  maxAccelerationMmS2: 6000,
  accelerationNoiseMmS2: 2500,
  speedSmoothingMs: 3000,
  motion: { startSpeedMmS: 1500, stopSpeedMmS: 900, startVerticalMmS: null, stopVerticalMmS: null, startCadence: null, stopCadence: null, startAfterMs: 2000, stopAfterMs: 4000 },
  autoPauseDefault: true,
  gradeAdjustedPace: false,
  cadence: "none",
  metrics: [
    "elapsed", "moving", "distance", "speed_avg", "speed_now", "speed_max", "ascent", "descent",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "speed_now", secondary: ["distance", "moving", "speed_avg"] },
  bestEffortMeters: glidingDistances,
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: null,
  descentMinimumMeters: null,
  recordedValues: {},
};

/** `SPT-009`: phone in a dry bag on a tow float; noisy fixes, so low process noise for a stronger RTS smoothing, and no auto-pause. */
export const openWaterSwimProfile: RecordingProfile = {
  primary: "pace",
  pacePerMeters: 100,
  splitMeters: 100,
  accuracyGateDm: 300,
  maxSpeedMmS: 3000,
  maxAccelerationMmS2: 2000,
  accelerationNoiseMmS2: 300,
  speedSmoothingMs: 10000,
  motion: { startSpeedMmS: 250, stopSpeedMmS: 150, startVerticalMmS: null, stopVerticalMmS: null, startCadence: null, stopCadence: null, startAfterMs: 3000, stopAfterMs: 10000 },
  autoPauseDefault: false,
  gradeAdjustedPace: false,
  cadence: "none",
  metrics: ["elapsed", "moving", "distance", "pace_avg", "pace_now", "pace_lap", "energy", "gps_quality", "clock"],
  readout: { main: "distance", secondary: ["elapsed", "pace_now", "pace_avg"] },
  bestEffortMeters: [400, 1000, 1500, 3800],
  bestAscentWindowMs: null,
  climbMinimumAscentMeters: null,
  descentMinimumMeters: null,
  recordedValues: { water: "open_water" },
};

export const mountainBikeMotion: MotionThresholds = {
  startSpeedMmS: 1000,
  stopSpeedMmS: 600,
  startVerticalMmS: null,
  stopVerticalMmS: null,
  startCadence: null,
  stopCadence: null,
  startAfterMs: 2000,
  stopAfterMs: 4000,
};
