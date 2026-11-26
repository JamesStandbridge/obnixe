import { z } from "zod";
import { metricKeys } from "./catalog/recording.ts";
import { recordingAlerts } from "./enums.ts";

const metricKey = z.enum(metricKeys);

export const autoLapMeters = [400, 1000, 2000, 5000, 10000] as const;
export const autoLapDurationsMs = [60_000, 300_000, 600_000] as const;

export const readoutSchema = z
  .strictObject({ main: metricKey, secondary: z.array(metricKey).min(3).max(5) })
  .refine((readout) => new Set([readout.main, ...readout.secondary]).size === readout.secondary.length + 1, { path: ["secondary"], message: "Metrics must be distinct" });

export const recordingSettingsSchema = z.strictObject({
  autoPause: z.boolean(),
  autoLap: z
    .discriminatedUnion("trigger", [
      z.strictObject({ trigger: z.literal("distance"), meters: z.literal(autoLapMeters) }),
      z.strictObject({ trigger: z.literal("duration"), ms: z.literal(autoLapDurationsMs) }),
    ])
    .nullable(),
  readout: readoutSchema.nullable(),
  alerts: z.strictObject({ disabled: z.array(z.enum(recordingAlerts)), sound: z.boolean() }),
  heartRateDevice: z.string().min(1).nullable(),
});
export type RecordingSettings = z.infer<typeof recordingSettingsSchema>;

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
