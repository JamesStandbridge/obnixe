import { z } from "zod";
import { metricKeys } from "./catalog/recording.ts";
import { recordingAlerts } from "./enums.ts";

const metricKey = z.enum(metricKeys);

export const autoLapMeters = [400, 1000, 2000, 5000, 10000] as const;
export const autoLapDurationsMs = [60_000, 300_000, 600_000] as const;

export const readoutSchema = z
  .strictObject({ main: metricKey, secondary: z.array(metricKey).min(3).max(5) })
  .refine((readout) => new Set([readout.main, ...readout.secondary]).size === readout.secondary.length + 1, { path: ["secondary"], message: "Metrics must be distinct" });

export const secondsPerKmSchema = z.int().min(120).max(1800);
export const speedMmSSchema = z.int().min(500).max(30_000);
export const heartRateZoneSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

/** Pace sports watch a pace span, speed sports a speed span (the profile's `primary`). */
export const paceRangeSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({ kind: z.literal("pace"), fastestSecondsPerKm: secondsPerKmSchema, slowestSecondsPerKm: secondsPerKmSchema })
    .refine((range) => range.fastestSecondsPerKm < range.slowestSecondsPerKm, { path: ["slowestSecondsPerKm"] }),
  z.strictObject({ kind: z.literal("speed"), minMmS: speedMmSSchema, maxMmS: speedMmSSchema }).refine((range) => range.minMmS < range.maxMmS, { path: ["maxMmS"] }),
]);
export type PaceRange = z.infer<typeof paceRangeSchema>;

export const heartRateRangeSchema = z.strictObject({ lowest: heartRateZoneSchema, highest: heartRateZoneSchema }).refine((range) => range.lowest <= range.highest, { path: ["highest"] });
export type HeartRateRange = z.infer<typeof heartRateRangeSchema>;

export const recordingSettingsSchema = z.strictObject({
  autoPause: z.boolean(),
  autoLap: z
    .discriminatedUnion("trigger", [
      z.strictObject({ trigger: z.literal("distance"), meters: z.literal(autoLapMeters) }),
      z.strictObject({ trigger: z.literal("duration"), ms: z.literal(autoLapDurationsMs) }),
    ])
    .nullable(),
  readout: readoutSchema.nullable(),
  alerts: z.strictObject({
    disabled: z.array(z.enum(recordingAlerts)),
    sound: z.boolean(),
    paceRange: paceRangeSchema.nullable(),
    heartRateRange: heartRateRangeSchema.nullable(),
  }),
  heartRateDevice: z.strictObject({ id: z.string().min(1), name: z.string().trim().min(1) }).nullable(),
});
export type RecordingSettings = z.infer<typeof recordingSettingsSchema>;
export type RecordingAlertSettings = RecordingSettings["alerts"];
export type HeartRateDeviceChoice = NonNullable<RecordingSettings["heartRateDevice"]>;

const latitudeE7 = z.int().min(-900_000_000).max(900_000_000);
const longitudeE7 = z.int().min(-1_800_000_000).max(1_800_000_000);

export const boundingBoxE7Schema = z
  .strictObject({ south: latitudeE7, west: longitudeE7, north: latitudeE7, east: longitudeE7 })
  .refine((box) => box.south <= box.north, { path: ["north"] });
export type BoundingBoxE7 = z.infer<typeof boundingBoxE7Schema>;

const deciCelsius = z.int().min(-900).max(600);
const nonNegative = z.int().nonnegative();

export const weatherHourSchema = z.strictObject({
  at: nonNegative,
  temperatureDeciC: deciCelsius,
  apparentTemperatureDeciC: deciCelsius,
  humidityPercent: z.int().min(0).max(100),
  precipitationDeciMm: nonNegative,
  weatherCode: z.int().min(0).max(99),
  windSpeedMmS: nonNegative,
  windDirectionDeg: z.int().min(0).max(360),
  windGustMmS: nonNegative,
});

export const recordingWeatherSchema = z.strictObject({
  source: z.enum(["open_meteo_forecast", "open_meteo_archive"]),
  fetchedAt: nonNegative,
  hours: z.array(weatherHourSchema).min(1).max(72),
});
export type RecordingWeather = z.infer<typeof recordingWeatherSchema>;
