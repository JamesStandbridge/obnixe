import { z } from "zod";
import { recordingWeatherSchema } from "@obnixe/schema";
import type { EpochMs, RecordingWeather } from "@obnixe/schema";
import { dayMs } from "../dates.ts";

export type WeatherSource = RecordingWeather["source"];
export type WeatherHour = RecordingWeather["hours"][number];

const hourMs = 3_600_000;
const maxHours = 72;
const forecastUrl = "https://api.open-meteo.com/v1/forecast";
const archiveUrl = "https://archive-api.open-meteo.com/v1/archive";
const hourlyVariables = ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation", "weather_code", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"] as const;

/** Activities that started less than this long ago are served by the forecast API with `past_days`, older ones by the ERA5 archive (`WTH-001`). */
export const weatherForecastMaxAgeMs = 60 * dayMs;
/** Failed requests retried at later launches before the activity is left without weather (`WTH-003`). */
export const weatherMaxRetries = 3;

export interface WeatherActivity {
  readonly startLatitudeE7: number;
  readonly startLongitudeE7: number;
  readonly startedAt: EpochMs;
  readonly endedAt: EpochMs;
}

export interface WeatherRequest {
  readonly source: WeatherSource;
  readonly url: string;
  /** Hours kept from the response, both on the hour and inclusive: the hours that frame the activity, at most 72. */
  readonly fromHour: EpochMs;
  readonly toHour: EpochMs;
}

/** Rounds to 0.1 degree (about 11 km), so the provider never learns the exact start (`DEC-13`). */
function roundedDegrees(e7: number): string {
  return (Math.round(e7 / 1_000_000) / 10).toFixed(1);
}

function utcDay(at: number): number {
  return Math.floor(at / dayMs);
}

function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Builds the Open-Meteo request for the hourly weather around an activity's rounded start, in UTC with SI wind speeds. */
export function weatherRequest(activity: WeatherActivity, now: EpochMs): WeatherRequest {
  const fromHour = Math.floor(activity.startedAt / hourMs) * hourMs;
  const lastHour = Math.max(fromHour, Math.ceil(activity.endedAt / hourMs) * hourMs);
  const toHour = Math.min(lastHour, fromHour + (maxHours - 1) * hourMs);
  const query = `latitude=${roundedDegrees(activity.startLatitudeE7)}&longitude=${roundedDegrees(activity.startLongitudeE7)}&hourly=${hourlyVariables.join(",")}&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT`;
  const range = { fromHour: fromHour as EpochMs, toHour: toHour as EpochMs };
  if (now - activity.startedAt < weatherForecastMaxAgeMs) {
    const today = utcDay(now);
    const pastDays = Math.max(0, today - utcDay(fromHour));
    const forecastDays = Math.max(1, utcDay(toHour) - today + 1);
    return { source: "open_meteo_forecast", url: `${forecastUrl}?${query}&past_days=${pastDays}&forecast_days=${forecastDays}`, ...range };
  }
  return { source: "open_meteo_archive", url: `${archiveUrl}?${query}&start_date=${utcDate(fromHour)}&end_date=${utcDate(toHour)}`, ...range };
}

const series = z.array(z.number().nullable());

const openMeteoResponseSchema = z.object({
  hourly_units: z.object({
    time: z.literal("unixtime"),
    temperature_2m: z.literal("°C"),
    apparent_temperature: z.literal("°C"),
    relative_humidity_2m: z.literal("%"),
    precipitation: z.literal("mm"),
    wind_speed_10m: z.literal("m/s"),
    wind_direction_10m: z.literal("°"),
    wind_gusts_10m: z.literal("m/s"),
  }),
  hourly: z.object({
    time: z.array(z.int().nonnegative()),
    temperature_2m: series,
    apparent_temperature: series,
    relative_humidity_2m: series,
    precipitation: series,
    weather_code: series,
    wind_speed_10m: series,
    wind_direction_10m: series,
    wind_gusts_10m: series,
  }),
});
type OpenMeteoHourly = z.infer<typeof openMeteoResponseSchema>["hourly"];

export type WeatherResponseProblem = "invalid_response" | "no_data";

export class WeatherResponseError extends Error {
  constructor(readonly problem: WeatherResponseProblem) {
    super(problem === "no_data" ? "Open-Meteo returned no complete hour for the activity" : "Open-Meteo returned an unexpected response");
  }
}

/** Converts one hour to the stored integer units; `null` when the provider left any value out. */
function hourAt(hourly: OpenMeteoHourly, index: number, at: number): WeatherHour | null {
  const temperature = hourly.temperature_2m[index] ?? null;
  const apparentTemperature = hourly.apparent_temperature[index] ?? null;
  const humidity = hourly.relative_humidity_2m[index] ?? null;
  const precipitation = hourly.precipitation[index] ?? null;
  const weatherCode = hourly.weather_code[index] ?? null;
  const windSpeed = hourly.wind_speed_10m[index] ?? null;
  const windDirection = hourly.wind_direction_10m[index] ?? null;
  const windGust = hourly.wind_gusts_10m[index] ?? null;
  if (temperature === null || apparentTemperature === null || humidity === null || precipitation === null || weatherCode === null || windSpeed === null || windDirection === null || windGust === null) return null;
  return {
    at,
    temperatureDeciC: Math.round(temperature * 10),
    apparentTemperatureDeciC: Math.round(apparentTemperature * 10),
    humidityPercent: Math.round(humidity),
    precipitationDeciMm: Math.round(precipitation * 10),
    weatherCode,
    windSpeedMmS: Math.round(windSpeed * 1000),
    windDirectionDeg: Math.round(windDirection),
    windGustMmS: Math.round(windGust * 1000),
  };
}

/** Validates an Open-Meteo body and keeps the complete hours of the requested range; throws `WeatherResponseError`. */
export function parseWeather(request: WeatherRequest, body: unknown, fetchedAt: EpochMs): RecordingWeather {
  const response = openMeteoResponseSchema.safeParse(body);
  if (!response.success) throw new WeatherResponseError("invalid_response");
  const { hourly } = response.data;
  const hours: WeatherHour[] = [];
  for (const [index, seconds] of hourly.time.entries()) {
    const at = seconds * 1000;
    if (at < request.fromHour || at > request.toHour) continue;
    const hour = hourAt(hourly, index, at);
    if (hour !== null) hours.push(hour);
  }
  if (hours.length === 0) throw new WeatherResponseError("no_data");
  const weather = recordingWeatherSchema.safeParse({ source: request.source, fetchedAt, hours });
  if (!weather.success) throw new WeatherResponseError("invalid_response");
  return weather.data;
}

/** The part of `fetch` the weather client needs, so tests inject recorded responses and the app can add a timeout. */
export type WeatherTransport = (url: string) => Promise<{ readonly status: number; readonly json: () => Promise<unknown> }>;

export type WeatherFailure = "network" | "rate_limited" | "server" | "rejected" | WeatherResponseProblem;

export type WeatherFetchResult = { readonly status: "fetched"; readonly weather: RecordingWeather } | { readonly status: "failed"; readonly failure: WeatherFailure };

function failed(failure: WeatherFailure): WeatherFetchResult {
  return { status: "failed", failure };
}

function statusFailure(status: number): WeatherFailure {
  if (status === 429) return "rate_limited";
  return status >= 400 && status < 500 ? "rejected" : "server";
}

/** `fetch` rejects with a `TypeError` when the network fails and with an `AbortError` or `TimeoutError` when its signal fires. */
function isTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

/** Sends one request and classifies its outcome; never throws for network, HTTP or payload problems. */
export async function fetchWeather(request: WeatherRequest, transport: WeatherTransport, now: () => EpochMs): Promise<WeatherFetchResult> {
  let body: unknown;
  try {
    const response = await transport(request.url);
    if (response.status < 200 || response.status > 299) return failed(statusFailure(response.status));
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return failed("invalid_response");
    if (isTransportError(error)) return failed("network");
    throw error;
  }
  try {
    return { status: "fetched", weather: parseWeather(request, body, now()) };
  } catch (error) {
    if (error instanceof WeatherResponseError) return failed(error.problem);
    throw error;
  }
}

function isRetryable(failure: WeatherFailure): boolean {
  switch (failure) {
    case "network":
    case "rate_limited":
    case "server":
    case "invalid_response":
    case "no_data":
      return true;
    case "rejected":
      return false;
    default: {
      const unreachable: never = failure;
      throw new Error(`Unhandled weather failure ${String(unreachable)}`);
    }
  }
}

export type WeatherSettlement =
  | { readonly action: "store"; readonly weather: RecordingWeather }
  | { readonly action: "retry"; readonly failedAttempts: number }
  | { readonly action: "abandon"; readonly failure: WeatherFailure };

/**
 * What the deferred queue does after an attempt (`WTH-003`): store the weather, keep the activity for the next launch with network
 * with its failure count, or drop it once the retries are spent or the provider refused the request itself.
 */
export function settleWeather(failedAttempts: number, result: WeatherFetchResult): WeatherSettlement {
  if (result.status === "fetched") return { action: "store", weather: result.weather };
  const attempts = failedAttempts + 1;
  if (!isRetryable(result.failure) || attempts > weatherMaxRetries) return { action: "abandon", failure: result.failure };
  return { action: "retry", failedAttempts: attempts };
}
