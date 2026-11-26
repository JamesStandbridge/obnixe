import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { recordingWeatherSchema } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";
import { WeatherResponseError, fetchWeather, parseWeather, settleWeather, weatherForecastMaxAgeMs, weatherMaxRetries, weatherRequest } from "./weather.ts";
import type { WeatherActivity, WeatherFailure, WeatherFetchResult, WeatherRequest, WeatherResponseProblem, WeatherTransport } from "./weather.ts";

const hourMs = 3_600_000;
const at = (year: number, month: number, day: number, hour: number, minute = 0): EpochMs => Date.UTC(year, month - 1, day, hour, minute) as EpochMs;
const recorded = (name: string): string => readFileSync(new URL(`../../test/fixtures/weather/${name}.json`, import.meta.url), "utf8");
const hourlyQuery = "hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT";

/** Morning run in Annecy, fetched the next afternoon: `forecast.json` was recorded for this request. */
const annecyRun: WeatherActivity = { startLatitudeE7: 458_992_000, startLongitudeE7: 61_294_000, startedAt: at(2026, 11, 25, 8, 20), endedAt: at(2026, 11, 25, 9, 47) };
const annecyNow = at(2026, 11, 26, 15);
/** Night trail from Chamonix over two UTC days: `archive.json` was recorded for this request. */
const chamonixTrail: WeatherActivity = { startLatitudeE7: 459_237_000, startLongitudeE7: 68_694_000, startedAt: at(2025, 8, 29, 16), endedAt: at(2025, 8, 30, 12, 20) };

const fetchedAt = at(2026, 11, 26, 15, 2);

function forecastBody(): { hourly_units: Record<string, string>; hourly: Record<string, (number | null)[]> } {
  return JSON.parse(recorded("forecast")) as { hourly_units: Record<string, string>; hourly: Record<string, (number | null)[]> };
}

function problemOf(request: WeatherRequest, body: unknown): WeatherResponseProblem | null {
  try {
    parseWeather(request, body, fetchedAt);
    return null;
  } catch (error) {
    if (error instanceof WeatherResponseError) return error.problem;
    throw error;
  }
}

function replay(status: number, body: string): { readonly transport: WeatherTransport; readonly urls: string[] } {
  const urls: string[] = [];
  const transport: WeatherTransport = async (url) => {
    urls.push(url);
    return { status, json: async () => JSON.parse(body) as unknown };
  };
  return { transport, urls };
}

function failing(error: Error): WeatherTransport {
  return () => Promise.reject(error);
}

const now = (): EpochMs => fetchedAt;

describe("weatherRequest", () => {
  it("asks the forecast API for the hours framing a recent activity at the start rounded to 0.1 degree", () => {
    expect(weatherRequest(annecyRun, annecyNow)).toEqual({
      source: "open_meteo_forecast",
      url: `https://api.open-meteo.com/v1/forecast?latitude=45.9&longitude=6.1&${hourlyQuery}&past_days=1&forecast_days=1`,
      fromHour: at(2026, 11, 25, 8),
      toHour: at(2026, 11, 25, 10),
    });
  });

  it("switches to the ERA5 archive from 60 days, with UTC dates", () => {
    const old = weatherRequest(chamonixTrail, annecyNow);
    expect(old).toEqual({
      source: "open_meteo_archive",
      url: `https://archive-api.open-meteo.com/v1/archive?latitude=45.9&longitude=6.9&${hourlyQuery}&start_date=2025-08-29&end_date=2025-08-30`,
      fromHour: at(2025, 8, 29, 16),
      toHour: at(2025, 8, 30, 13),
    });
    expect(weatherRequest(annecyRun, (annecyRun.startedAt + weatherForecastMaxAgeMs) as EpochMs).source).toBe("open_meteo_archive");
    const lastForecast = weatherRequest(annecyRun, (annecyRun.startedAt + weatherForecastMaxAgeMs - 1) as EpochMs);
    expect(lastForecast.source).toBe("open_meteo_forecast");
    expect(lastForecast.url).toContain("&past_days=60&forecast_days=1");
  });

  it("rounds southern and western coordinates symmetrically", () => {
    const sydney = weatherRequest({ ...annecyRun, startLatitudeE7: -338_688_000, startLongitudeE7: -1_512_093_000 }, annecyNow);
    expect(sydney.url).toContain("?latitude=-33.9&longitude=-151.2&");
    const greenwich = weatherRequest({ ...annecyRun, startLatitudeE7: 514_779_000, startLongitudeE7: -14_000 }, annecyNow);
    expect(greenwich.url).toContain("?latitude=51.5&longitude=0.0&");
  });

  it("covers tomorrow's first hour when the activity ends late today", () => {
    const request = weatherRequest({ ...annecyRun, startedAt: at(2026, 11, 26, 21, 10), endedAt: at(2026, 11, 26, 23, 30) }, at(2026, 11, 26, 23, 50));
    expect(request.url).toContain("&past_days=0&forecast_days=2");
    expect(request.toHour).toBe(at(2026, 11, 27, 0));
  });

  it("keeps an instant activity on one hour and caps long ones at 72 hours", () => {
    const instant = weatherRequest({ ...annecyRun, startedAt: at(2026, 11, 25, 9), endedAt: at(2026, 11, 25, 9) }, annecyNow);
    expect(instant.toHour).toBe(instant.fromHour);
    const ultra = weatherRequest({ ...annecyRun, startedAt: at(2026, 11, 20, 6, 30), endedAt: (at(2026, 11, 20, 6, 30) + 100 * hourMs) as EpochMs }, annecyNow);
    expect(ultra.toHour - ultra.fromHour).toBe(71 * hourMs);
    expect(ultra.url).toContain("&past_days=6&forecast_days=1");
  });
});

describe("parseWeather", () => {
  it("converts the recorded forecast hours of the activity to stored integer units", () => {
    const weather = parseWeather(weatherRequest(annecyRun, annecyNow), JSON.parse(recorded("forecast")), fetchedAt);
    expect(weather.source).toBe("open_meteo_forecast");
    expect(weather.fetchedAt).toBe(fetchedAt);
    expect(weather.hours.map((hour) => hour.at)).toEqual([at(2026, 11, 25, 8), at(2026, 11, 25, 9), at(2026, 11, 25, 10)]);
    expect(weather.hours[0]).toEqual({ at: at(2026, 11, 25, 8), temperatureDeciC: 46, apparentTemperatureDeciC: 30, humidityPercent: 97, precipitationDeciMm: 2, weatherCode: 61, windSpeedMmS: 500, windDirectionDeg: 323, windGustMmS: 2300 });
    expect(weather.hours[1]?.windSpeedMmS).toBe(320);
    expect(recordingWeatherSchema.parse(weather)).toEqual(weather);
  });

  it("parses the recorded ERA5 archive across two UTC days, below freezing included", () => {
    const weather = parseWeather(weatherRequest(chamonixTrail, annecyNow), JSON.parse(recorded("archive")), fetchedAt);
    expect(weather.source).toBe("open_meteo_archive");
    expect(weather.hours).toHaveLength(22);
    expect(weather.hours[1]).toEqual({ at: at(2025, 8, 29, 17), temperatureDeciC: 23, apparentTemperatureDeciC: -1, humidityPercent: 89, precipitationDeciMm: 4, weatherCode: 51, windSpeedMmS: 850, windDirectionDeg: 273, windGustMmS: 8600 });
    expect(weather.hours.at(-1)?.at).toBe(at(2025, 8, 30, 13));
  });

  it("drops the hours an incomplete response leaves out", () => {
    const request = weatherRequest(annecyRun, annecyNow);
    const withNull = forecastBody();
    withNull.hourly["temperature_2m"]![9] = null;
    expect(parseWeather(request, withNull, fetchedAt).hours.map((hour) => hour.at)).toEqual([at(2026, 11, 25, 8), at(2026, 11, 25, 10)]);
    const truncated = forecastBody();
    truncated.hourly["wind_gusts_10m"] = truncated.hourly["wind_gusts_10m"]!.slice(0, 9);
    expect(parseWeather(request, truncated, fetchedAt).hours.map((hour) => hour.at)).toEqual([at(2026, 11, 25, 8)]);
  });

  it("reports no data when no hour of the activity is complete", () => {
    const body = forecastBody();
    body.hourly["precipitation"] = body.hourly["precipitation"]!.map(() => null);
    expect(problemOf(weatherRequest(annecyRun, annecyNow), body)).toBe("no_data");
    expect(problemOf(weatherRequest({ ...annecyRun, startedAt: at(2026, 11, 28, 8), endedAt: at(2026, 11, 28, 9) }, annecyNow), forecastBody())).toBe("no_data");
  });

  it("refuses missing variables, other units and values outside the stored ranges", () => {
    const request = weatherRequest(annecyRun, annecyNow);
    const missing = forecastBody();
    delete missing.hourly["weather_code"];
    expect(problemOf(request, missing)).toBe("invalid_response");
    const kilometers = forecastBody();
    kilometers.hourly_units["wind_speed_10m"] = "km/h";
    expect(problemOf(request, kilometers)).toBe("invalid_response");
    const scorching = forecastBody();
    scorching.hourly["temperature_2m"]![8] = 75;
    expect(problemOf(request, scorching)).toBe("invalid_response");
    expect(problemOf(request, JSON.parse(recorded("rejected")))).toBe("invalid_response");
    expect(problemOf(request, null)).toBe("invalid_response");
  });
});

describe("fetchWeather", () => {
  const request = weatherRequest(annecyRun, annecyNow);

  it("accepts the platform fetch as transport", () => {
    expectTypeOf(fetch).toExtend<WeatherTransport>();
  });

  it("sends the built request once and stores the parsed weather with the fetch instant", async () => {
    const { transport, urls } = replay(200, recorded("forecast"));
    const result = await fetchWeather(request, transport, now);
    expect(urls).toEqual([request.url]);
    expect(result).toEqual({ status: "fetched", weather: parseWeather(request, JSON.parse(recorded("forecast")), fetchedAt) });
  });

  it("classifies HTTP, payload and transport failures", async () => {
    const outcomes: [WeatherTransport, WeatherFailure][] = [
      [replay(429, recorded("rate-limited")).transport, "rate_limited"],
      [replay(400, recorded("rejected")).transport, "rejected"],
      [replay(503, "<html>Service Unavailable</html>").transport, "server"],
      [replay(200, "<html>captive portal</html>").transport, "invalid_response"],
      [replay(200, recorded("rate-limited")).transport, "invalid_response"],
      [replay(200, JSON.stringify({ ...forecastBody(), hourly: { ...forecastBody().hourly, temperature_2m: [] } })).transport, "no_data"],
      [failing(new TypeError("fetch failed")), "network"],
      [failing(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "network"],
    ];
    for (const [transport, failure] of outcomes) {
      await expect(fetchWeather(request, transport, now)).resolves.toEqual({ status: "failed", failure });
    }
  });

  it("lets programming errors through", async () => {
    await expect(fetchWeather(request, failing(new RangeError("bug")), now)).rejects.toThrow(RangeError);
  });
});

describe("settleWeather", () => {
  const weather = parseWeather(weatherRequest(annecyRun, annecyNow), JSON.parse(recorded("forecast")), fetchedAt);
  const offline: WeatherFetchResult = { status: "failed", failure: "network" };

  it("stores fetched weather whatever the failures before", () => {
    expect(settleWeather(weatherMaxRetries, { status: "fetched", weather })).toEqual({ action: "store", weather });
  });

  it("retries a failed request at most 3 times per activity", () => {
    let failedAttempts = 0;
    const actions: string[] = [];
    for (;;) {
      const settlement = settleWeather(failedAttempts, offline);
      actions.push(settlement.action);
      if (settlement.action !== "retry") break;
      failedAttempts = settlement.failedAttempts;
    }
    expect(actions).toEqual(["retry", "retry", "retry", "abandon"]);
    expect(settleWeather(weatherMaxRetries, { status: "failed", failure: "rate_limited" })).toEqual({ action: "abandon", failure: "rate_limited" });
  });

  it("gives up at once when the provider refuses the request", () => {
    expect(settleWeather(0, { status: "failed", failure: "rejected" })).toEqual({ action: "abandon", failure: "rejected" });
  });
});
