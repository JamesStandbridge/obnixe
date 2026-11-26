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
  "energy",
  "gps_quality",
  "clock",
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
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "pace_now", secondary: ["distance", "moving", "pace_avg", "cadence"] },
  bestEffortMeters: runningDistances,
  bestAscentWindowMs: null,
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
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "distance", secondary: ["moving", "ascent", "vertical_speed", "pace_now"] },
  bestEffortMeters: runningDistances,
  bestAscentWindowMs: oneHourMs,
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
  ],
  readout: { main: "moving", secondary: ["distance", "pace_now", "steps"] },
  bestEffortMeters: [1000, 5000, 10000, 21097.5],
  bestAscentWindowMs: null,
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
  ],
  readout: { main: "elapsed", secondary: ["distance", "ascent", "altitude", "vam"] },
  bestEffortMeters: [],
  bestAscentWindowMs: null,
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
    "ascent", "descent", "altitude", "altitude_min", "altitude_max", "grade_now", "vam", "vertical_speed",
    "heart_rate", "heart_rate_avg", "heart_rate_max", "heart_rate_zone", "energy", "gps_quality", "clock",
  ],
  readout: { main: "speed_now", secondary: ["distance", "moving", "speed_avg", "ascent"] },
  bestEffortMeters: [10000, 20000, 40000, 50000, 100000, 160934],
  bestAscentWindowMs: oneHourMs,
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
