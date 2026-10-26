const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"] as const;
const weekdays = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;

interface DayParts {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

function parts(localDate: string): DayParts {
  const [year, month, day] = localDate.split("-").map(Number);
  return { year: year ?? 1970, month: (month ?? 1) - 1, day: day ?? 1 };
}

function dayLabel(day: number): string {
  return day === 1 ? "1er" : String(day);
}

function monthName(index: number): string {
  return months[index] ?? "";
}

export function upperFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase("fr-FR") + text.slice(1);
}

export function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase("fr-FR") + text.slice(1);
}

/** "10 octobre" */
export function frenchDay(localDate: string): string {
  const { day, month } = parts(localDate);
  return `${dayLabel(day)} ${monthName(month)}`;
}

/** "du 3 au 30 octobre", "du 28 septembre au 4 octobre" */
export function frenchSpan(from: string, to: string): string {
  const start = parts(from);
  const end = parts(to);
  if (from === to) return `du ${frenchDay(from)}`;
  if (start.month === end.month && start.year === end.year) return `du ${dayLabel(start.day)} au ${frenchDay(to)}`;
  return `du ${frenchDay(from)} au ${frenchDay(to)}`;
}

/** "Vendredi 23 octobre" for a timestamp in the device time zone. */
export function frenchWeekdayTitle(epochMs: number): string {
  const date = new Date(epochMs);
  return upperFirst(`${weekdays[date.getDay()] ?? ""} ${dayLabel(date.getDate())} ${monthName(date.getMonth())}`);
}

/** "14:02" in the device time zone. */
export function clockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "9,2 km", "32 km", "800 m" */
export function frenchDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  const kilometers = meters / 1000;
  const rounded = kilometers >= 20 ? Math.round(kilometers) : Math.round(kilometers * 10) / 10;
  return `${rounded.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`;
}

/** "45 min", "1 h 30" */
export function frenchDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}

/** Local calendar date of a timestamp in an IANA time zone. */
export function localDateIn(epochMs: number, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes): string => formatted.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
