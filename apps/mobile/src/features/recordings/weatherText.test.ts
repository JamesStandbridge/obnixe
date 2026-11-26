import { describe, expect, it } from "vitest";
import type { WeatherHour } from "@obnixe/core";
import type { RecordingWeather } from "@obnixe/schema";
import { weatherText } from "@/features/recordings/weatherText";

const hourMs = 3_600_000;
const start = Date.UTC(2026, 10, 25, 8, 20);
const hour = (offset: number, overrides: Partial<WeatherHour> = {}): WeatherHour => ({
  at: Date.UTC(2026, 10, 25, 8) + offset * hourMs,
  temperatureDeciC: 142,
  apparentTemperatureDeciC: 118,
  humidityPercent: 81,
  precipitationDeciMm: 3,
  weatherCode: 61,
  windSpeedMmS: 5000,
  windDirectionDeg: 315,
  windGustMmS: 9400,
  ...overrides,
});
const weatherOf = (hours: readonly WeatherHour[]): RecordingWeather => ({ source: "open_meteo_forecast", fetchedAt: start + 4 * hourMs, hours: [...hours] });

describe("weatherText (WTH-002)", () => {
  it("writes the hour closest to the middle of the activity compactly", () => {
    const text = weatherText(weatherOf([hour(0, { temperatureDeciC: 98 }), hour(1), hour(2, { temperatureDeciC: 165 })]), start, start + 80 * 60_000);
    expect(text.headline).toBe("14 °C, ressenti 12 °C, vent 18 km/h de nord-ouest, pluie faible");
    expect(text.details).toBe("Rafales jusqu'à 34 km/h · humidité 81 % · de 10 à 17 °C pendant l'activité");
  });

  it("names calm air, negative temperatures and every wind origin, and leaves unknown codes out", () => {
    const calm = weatherText(weatherOf([hour(0, { temperatureDeciC: -34, apparentTemperatureDeciC: -71, windSpeedMmS: 100, windGustMmS: 100, weatherCode: 4 })]), start, start);
    expect(calm).toEqual({ headline: "−3 °C, ressenti −7 °C, sans vent", details: "Humidité 81 %" });
    const origins = [0, 45, 90, 135, 180, 225, 270, 359].map((windDirectionDeg) => weatherText(weatherOf([hour(0, { windDirectionDeg, weatherCode: 0 })]), start, start).headline.split(", ")[2]);
    expect(origins).toEqual([
      "vent 18 km/h du nord",
      "vent 18 km/h de nord-est",
      "vent 18 km/h d'est",
      "vent 18 km/h de sud-est",
      "vent 18 km/h du sud",
      "vent 18 km/h de sud-ouest",
      "vent 18 km/h d'ouest",
      "vent 18 km/h du nord",
    ]);
  });
});
