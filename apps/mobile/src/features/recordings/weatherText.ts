import type { WeatherHour } from "@obnixe/core";
import type { RecordingWeather } from "@obnixe/schema";
import { capitalize } from "@/format/labels";
import { formatInteger } from "@/format/numbers";

export interface WeatherText {
  /** « 14 °C, ressenti 12 °C, vent 18 km/h de nord-ouest, pluie faible » (`WTH-002`). */
  readonly headline: string;
  /** The strongest gust, the humidity, and the temperature range when it changed during the activity. */
  readonly details: string;
}

/** WMO weather interpretation codes as Open-Meteo emits them; other codes are left unnamed. */
function conditionText(code: number): string | null {
  switch (code) {
    case 0:
      return "ciel dégagé";
    case 1:
      return "ciel peu nuageux";
    case 2:
      return "éclaircies";
    case 3:
      return "ciel couvert";
    case 45:
      return "brouillard";
    case 48:
      return "brouillard givrant";
    case 51:
      return "bruine faible";
    case 53:
      return "bruine";
    case 55:
      return "bruine forte";
    case 56:
    case 57:
      return "bruine verglaçante";
    case 61:
      return "pluie faible";
    case 63:
      return "pluie";
    case 65:
      return "pluie forte";
    case 66:
    case 67:
      return "pluie verglaçante";
    case 71:
      return "neige faible";
    case 73:
      return "neige";
    case 75:
      return "neige forte";
    case 77:
      return "grains de neige";
    case 80:
      return "averses faibles";
    case 81:
      return "averses";
    case 82:
      return "fortes averses";
    case 85:
    case 86:
      return "averses de neige";
    case 95:
      return "orage";
    case 96:
    case 99:
      return "orage avec grêle";
    default:
      return null;
  }
}

/** Where the wind blows from, on eight points. */
const windOrigins = ["du nord", "de nord-est", "d'est", "de sud-est", "du sud", "de sud-ouest", "d'ouest", "de nord-ouest"] as const;

function windOrigin(directionDeg: number): string {
  return windOrigins[Math.round(directionDeg / 45) % windOrigins.length] ?? windOrigins[0];
}

function kilometersPerHour(mmS: number): number {
  return Math.round(mmS * 0.0036);
}

function degrees(deciC: number): string {
  return `${formatInteger(deciC / 10)} °C`;
}

/** The stored hour closest to the middle of the activity. */
function middleHour(hours: readonly WeatherHour[], middle: number): WeatherHour {
  return hours.reduce((best, hour) => (Math.abs(hour.at - middle) < Math.abs(best.at - middle) ? hour : best));
}

export function weatherText(weather: RecordingWeather, startedAt: number, endedAt: number): WeatherText {
  const { hours } = weather;
  const hour = middleHour(hours, (startedAt + endedAt) / 2);
  const wind = kilometersPerHour(hour.windSpeedMmS);
  const condition = conditionText(hour.weatherCode);
  const headline = [degrees(hour.temperatureDeciC), `ressenti ${degrees(hour.apparentTemperatureDeciC)}`, wind === 0 ? "sans vent" : `vent ${formatInteger(wind)} km/h ${windOrigin(hour.windDirectionDeg)}`, ...(condition === null ? [] : [condition])];
  const temperatures = hours.map((item) => Math.round(item.temperatureDeciC / 10));
  const coldest = Math.min(...temperatures);
  const warmest = Math.max(...temperatures);
  const gust = kilometersPerHour(Math.max(...hours.map((item) => item.windGustMmS)));
  const details = [
    ...(gust > wind ? [`rafales jusqu'à ${formatInteger(gust)} km/h`] : []),
    `humidité ${formatInteger(hour.humidityPercent)} %`,
    ...(coldest === warmest ? [] : [`de ${formatInteger(coldest)} à ${formatInteger(warmest)} °C pendant l'activité`]),
  ];
  return { headline: headline.join(", "), details: capitalize(details.join(" · ")) };
}
