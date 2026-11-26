export const archetypes = ["strength", "itemized", "continuous"] as const;
export type Archetype = (typeof archetypes)[number];

export const authors = ["user", "agent", "import"] as const;
export type Author = (typeof authors)[number];

export const painLevels = ["none", "discomfort", "stop"] as const;
export type PainLevel = (typeof painLevels)[number];

export const painPhases = ["before", "during", "between", "end"] as const;
export type PainPhase = (typeof painPhases)[number];

export const efforts = ["easy", "moderate", "hard", "very_hard", "max"] as const;
export type Effort = (typeof efforts)[number];

export const sensations = ["heavy", "normal", "light"] as const;
export type Sensation = (typeof sensations)[number];

export const sleepBuckets = ["lt6", "h6", "h7", "h8", "gte9"] as const;
export type SleepBucket = (typeof sleepBuckets)[number];

export const sessionStatuses = ["in_progress", "interrupted", "completed"] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

export const reviewStatuses = ["skipped", "pending", "done"] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

export const strengthEntryStatuses = ["pending", "done", "stopped", "skipped"] as const;
export type StrengthEntryStatus = (typeof strengthEntryStatuses)[number];

export const exerciseMeasures = ["load_reps", "bodyweight_reps", "duration"] as const;
export type ExerciseMeasure = (typeof exerciseMeasures)[number];

export const equipments = ["barbell", "dumbbell", "kettlebell", "machine", "cable", "bodyweight", "band", "other"] as const;
export type Equipment = (typeof equipments)[number];

export const loadModes = ["total", "per_hand", "per_side"] as const;
export type LoadMode = (typeof loadModes)[number];

export const programStatuses = ["draft", "active", "archived"] as const;
export type ProgramStatus = (typeof programStatuses)[number];

export const zoneTrackingReasons = ["user", "pain_reported"] as const;
export type ZoneTrackingReason = (typeof zoneTrackingReasons)[number];

export const photoPoses = ["front", "side", "back"] as const;
export type PhotoPose = (typeof photoPoses)[number];

export const changeOperations = ["insert", "update", "delete"] as const;
export type ChangeOperation = (typeof changeOperations)[number];

export const journaledTables = [
  "sport_preference",
  "gear",
  "exercise",
  "exercise_zone",
  "measurement_kind",
  "program",
  "program_version",
  "program_slot",
  "program_variant",
  "program_item",
  "rotation_skip",
  "session",
  "strength_entry",
  "strength_set",
  "session_item",
  "weigh_in",
  "measurement",
  "photo",
  "check_in",
  "pain_report",
  "zone_tracking",
  "recording",
  "lap",
  "privacy_zone",
  "segment",
] as const;
export type JournaledTable = (typeof journaledTables)[number];

export const dimensions = ["mass", "length", "distance", "duration", "count", "heart_rate", "power"] as const;
export type Dimension = (typeof dimensions)[number];

export const agentCallKinds = ["read", "write"] as const;
export type AgentCallKind = (typeof agentCallKinds)[number];

export const connectionEndReasons = ["user", "screen_closed", "timeout", "network", "protocol", "error"] as const;
export type ConnectionEndReason = (typeof connectionEndReasons)[number];

export const backupKinds = ["export", "import_merge", "import_replace", "pre_migration"] as const;
export type BackupKind = (typeof backupKinds)[number];

export const themes = ["dark", "sunlight", "system"] as const;
export type Theme = (typeof themes)[number];

export const massUnits = ["kg", "lb"] as const;
export type MassUnit = (typeof massUnits)[number];

export const recordingSources = ["live", "import"] as const;
export type RecordingSource = (typeof recordingSources)[number];

export const importFormats = ["gpx", "tcx", "fit", "garmin_archive"] as const;
export type ImportFormat = (typeof importFormats)[number];

export const elevationSources = ["barometer", "gnss", "file", "none"] as const;
export type ElevationSource = (typeof elevationSources)[number];

export const cadenceSources = ["pedometer", "file", "none"] as const;
export type CadenceSource = (typeof cadenceSources)[number];

export const sensorSources = ["sensor", "file", "none"] as const;
export type SensorSource = (typeof sensorSources)[number];

export const lapTriggers = ["manual", "distance", "duration", "import"] as const;
export type LapTrigger = (typeof lapTriggers)[number];

export const energyMethods = ["heart_rate", "mechanical", "met"] as const;
export type EnergyMethod = (typeof energyMethods)[number];

export const segmentFamilies = ["foot", "bike"] as const;
export type SegmentFamily = (typeof segmentFamilies)[number];

export const biologicalSexes = ["female", "male"] as const;
export type BiologicalSex = (typeof biologicalSexes)[number];

export const mapStyles = ["obnixe_outdoor", "plan_ign"] as const;
export type MapStyle = (typeof mapStyles)[number];

export const recordingAlerts = ["lap", "split", "auto_pause", "goal", "gps", "sensor", "battery"] as const;
export type RecordingAlert = (typeof recordingAlerts)[number];
