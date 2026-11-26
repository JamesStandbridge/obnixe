import { assembleActivity } from "./activity.ts";
import type { RoutePoint } from "../routes.ts";
import type { ExportPoint, FilePoint, FileTotals, ImportedActivity } from "./activity.ts";
import { ImportError } from "./errors.ts";
import { fileRoute } from "./fileRoute.ts";
import type { FileRoute } from "./fileRoute.ts";
import { sportOfTcx } from "./sports.ts";
import type { TcxSport } from "./sports.ts";
import { centiDegrees, contentId, parseDecimal, parseTime, positionE7 } from "./values.ts";
import { degreesOf, escapeXml, obnixeElements, obnixeNamespace, readXmlFile } from "./xml.ts";
import type { XmlAttributes, XmlHandler } from "./xml.ts";

interface TrackpointDraft {
  time: number | null;
  latitude: number | null;
  longitude: number | null;
  altitudeMm: number | null;
  heartRate: number | null;
  cadence: number | null;
  runCadence: number | null;
  power: number | null;
  speedMmS: number | null;
  courseCentiDeg: number | null;
  horizontalAccuracyDm: number | null;
  verticalAccuracyDm: number | null;
  speedAccuracyCmS: number | null;
  pressurePa: number | null;
}

interface LapDraft {
  startTime: number;
  timerMs: number;
  distanceMm: number;
  energyKcal: number | null;
  heartRateAvg: number | null;
  heartRateMax: number | null;
}

/** Garmin Training Center v2 reader: one activity, its laps, and the trackpoints of all its tracks; a new track inside a lap is a pause. */
class TcxReader implements XmlHandler {
  readonly points: FilePoint[] = [];
  readonly segmentStarts: number[] = [];
  readonly laps: LapDraft[] = [];
  sport: string | null = null;
  start: number | null = null;
  device: string | null = null;
  activities = 0;
  untimed = 0;
  private readonly path: string[] = [];
  private content = "";
  private point: TrackpointDraft | null = null;
  private lap: LapDraft | null = null;
  private lapTracks = 0;
  private segmentPending = false;

  open(name: string, attributes: XmlAttributes): void {
    if (this.path.length === 0 && name !== "TrainingCenterDatabase") throw new ImportError("unsupported_format", `the root element is <${name}>, not <TrainingCenterDatabase>`);
    this.path.push(name);
    this.content = "";
    if (name === "Activity" && this.parent(1) === "Activities") {
      this.activities += 1;
      if (this.activities > 1) throw new ImportError("several_activities", "the file holds several activities");
      this.sport = attributes.Sport ?? null;
    }
    if (name === "Lap" && this.parent(1) === "Activity") {
      const startTime = attributes.StartTime;
      if (startTime === undefined) throw new ImportError("invalid_value", "a lap has no StartTime");
      this.lap = { startTime: parseTime(startTime), timerMs: 0, distanceMm: 0, energyKcal: null, heartRateAvg: null, heartRateMax: null };
      this.lapTracks = 0;
    }
    if (name === "Track" && this.parent(1) === "Lap") {
      if (this.lapTracks > 0) this.segmentPending = this.points.length > 0;
      this.lapTracks += 1;
    }
    if (name === "Trackpoint") {
      this.point = {
        time: null,
        latitude: null,
        longitude: null,
        altitudeMm: null,
        heartRate: null,
        cadence: null,
        runCadence: null,
        power: null,
        speedMmS: null,
        courseCentiDeg: null,
        horizontalAccuracyDm: null,
        verticalAccuracyDm: null,
        speedAccuracyCmS: null,
        pressurePa: null,
      };
    }
  }

  text(text: string): void {
    this.content += text;
  }

  close(name: string): void {
    const parent = this.parent(1);
    this.path.pop();
    if (this.point !== null) {
      this.closePoint(name, parent, this.point);
      return;
    }
    const lap = this.lap;
    if (name === "Id" && parent === "Activity") this.start = parseTime(this.content);
    if (name === "Name" && parent === "Creator" && this.device === null) this.device = this.content.trim() || null;
    if (lap === null) return;
    if (name === "Lap") {
      this.laps.push(lap);
      this.lap = null;
    } else if (parent === "Lap" && name === "TotalTimeSeconds") {
      lap.timerMs = Math.round(parseDecimal(this.content, "lap time") * 1000);
    } else if (parent === "Lap" && name === "DistanceMeters") {
      lap.distanceMm = Math.round(parseDecimal(this.content, "lap distance") * 1000);
    } else if (parent === "Lap" && name === "Calories") {
      lap.energyKcal = Math.round(parseDecimal(this.content, "calories"));
    } else if (parent === "AverageHeartRateBpm" && name === "Value") {
      lap.heartRateAvg = Math.round(parseDecimal(this.content, "heart rate"));
    } else if (parent === "MaximumHeartRateBpm" && name === "Value") {
      lap.heartRateMax = Math.round(parseDecimal(this.content, "heart rate"));
    }
  }

  private closePoint(name: string, parent: string | undefined, point: TrackpointDraft): void {
    switch (name) {
      case "Trackpoint":
        this.finishPoint(point);
        return;
      case "Time":
        point.time = parseTime(this.content);
        return;
      case "LatitudeDegrees":
        point.latitude = parseDecimal(this.content, "latitude");
        return;
      case "LongitudeDegrees":
        point.longitude = parseDecimal(this.content, "longitude");
        return;
      case "AltitudeMeters":
        point.altitudeMm = Math.round(parseDecimal(this.content, "altitude") * 1000);
        return;
      case "Value":
        if (parent === "HeartRateBpm") point.heartRate = Math.round(parseDecimal(this.content, "heart rate"));
        return;
      case "Cadence":
        point.cadence = parseDecimal(this.content, "cadence");
        return;
      case "RunCadence":
        point.runCadence = parseDecimal(this.content, "cadence");
        return;
      case "Watts":
        point.power = Math.round(parseDecimal(this.content, "power"));
        return;
      case "Speed":
        point.speedMmS = Math.round(parseDecimal(this.content, "speed") * 1000);
        return;
      case "course":
        point.courseCentiDeg = centiDegrees(parseDecimal(this.content, "course"));
        return;
      case "hacc":
        point.horizontalAccuracyDm = Math.round(parseDecimal(this.content, "horizontal accuracy") * 10);
        return;
      case "vacc":
        point.verticalAccuracyDm = Math.round(parseDecimal(this.content, "vertical accuracy") * 10);
        return;
      case "sacc":
        point.speedAccuracyCmS = Math.round(parseDecimal(this.content, "speed accuracy") * 100);
        return;
      case "pressure":
        point.pressurePa = Math.round(parseDecimal(this.content, "pressure"));
        return;
      default:
        return;
    }
  }

  private finishPoint(point: TrackpointDraft): void {
    this.point = null;
    if (point.time === null) {
      this.untimed += 1;
      return;
    }
    if ((point.latitude === null) !== (point.longitude === null)) throw new ImportError("invalid_value", "a trackpoint has only one coordinate");
    const position = point.latitude === null || point.longitude === null ? null : positionE7(point.latitude, point.longitude);
    if (this.segmentPending) this.segmentStarts.push(this.points.length);
    this.segmentPending = false;
    this.points.push({
      time: point.time,
      latitudeE7: position?.latitudeE7 ?? null,
      longitudeE7: position?.longitudeE7 ?? null,
      altitudeMm: point.altitudeMm,
      heartRate: point.heartRate,
      cadence: point.runCadence ?? point.cadence,
      power: point.power,
      speedMmS: point.speedMmS,
      courseCentiDeg: point.courseCentiDeg,
      horizontalAccuracyDm: point.horizontalAccuracyDm,
      verticalAccuracyDm: point.verticalAccuracyDm,
      speedAccuracyCmS: point.speedAccuracyCmS,
      pressurePa: point.pressurePa,
    });
  }

  private parent(depth: number): string | undefined {
    return this.path[this.path.length - 1 - depth];
  }
}

function lapTotals(laps: readonly LapDraft[]): FileTotals | null {
  if (laps.length === 0) return null;
  const timerMs = laps.reduce((total, lap) => total + lap.timerMs, 0);
  const energy = laps.filter((lap) => lap.energyKcal !== null);
  const rated = laps.filter((lap) => lap.heartRateAvg !== null);
  const ratedMs = rated.reduce((total, lap) => total + lap.timerMs, 0);
  const maxima = laps.flatMap((lap) => (lap.heartRateMax === null ? [] : [lap.heartRateMax]));
  return {
    elapsedMs: null,
    timerMs,
    distanceMm: laps.reduce((total, lap) => total + lap.distanceMm, 0),
    energyKcal: energy.length === 0 ? null : energy.reduce((total, lap) => total + (lap.energyKcal ?? 0), 0),
    heartRateAvg: ratedMs === 0 ? null : Math.round(rated.reduce((total, lap) => total + (lap.heartRateAvg ?? 0) * lap.timerMs, 0) / ratedMs),
    heartRateMax: maxima.length === 0 ? null : Math.max(...maxima),
    powerAvg: null,
  };
}

interface CoursePointDraft {
  latitude: number | null;
  longitude: number | null;
  altitudeMm: number | null;
}

/** Garmin Training Center v2 course reader: the name and the trackpoints of the first `Courses/Course`. */
class TcxCourseReader implements XmlHandler {
  readonly points: RoutePoint[] = [];
  name: string | null = null;
  courses = 0;
  private readonly path: string[] = [];
  private content = "";
  private point: CoursePointDraft | null = null;

  open(name: string): void {
    if (this.path.length === 0 && name !== "TrainingCenterDatabase") throw new ImportError("unsupported_format", `the root element is <${name}>, not <TrainingCenterDatabase>`);
    const parent = this.path[this.path.length - 1];
    this.path.push(name);
    this.content = "";
    if (name === "Course" && parent === "Courses") this.courses += 1;
    if (name === "Trackpoint" && this.courses === 1 && this.path.includes("Course")) this.point = { latitude: null, longitude: null, altitudeMm: null };
  }

  text(text: string): void {
    this.content += text;
  }

  close(name: string): void {
    this.path.pop();
    const parent = this.path[this.path.length - 1];
    const point = this.point;
    if (point === null) {
      if (name === "Name" && parent === "Course" && this.courses === 1) this.name ??= this.content.trim() || null;
      return;
    }
    switch (name) {
      case "Trackpoint":
        this.point = null;
        if ((point.latitude === null) !== (point.longitude === null)) throw new ImportError("invalid_value", "a trackpoint has only one coordinate");
        if (point.latitude === null || point.longitude === null) return;
        this.points.push({ ...positionE7(point.latitude, point.longitude), altitudeMm: point.altitudeMm });
        return;
      case "LatitudeDegrees":
        point.latitude = parseDecimal(this.content, "latitude");
        return;
      case "LongitudeDegrees":
        point.longitude = parseDecimal(this.content, "longitude");
        return;
      case "AltitudeMeters":
        point.altitudeMm = Math.round(parseDecimal(this.content, "altitude") * 1000);
        return;
      default:
        return;
    }
  }
}

/** Reads a TCX course (`RTE-001`); a course names no sport. */
export function readTcxCourse(bytes: Uint8Array): FileRoute {
  const reader = new TcxCourseReader();
  readXmlFile(bytes, reader);
  if (reader.courses === 0) throw new ImportError("not_a_route", "the file holds no course");
  return fileRoute("tcx", reader.name, null, reader.points);
}

/**
 * Reads a TCX activity: laps (`IO-010`), lap totals for activities without positions (`IO-011`), `RunCadence`, `Watts` and
 * `Speed` extensions, and the Obnixe accuracy, course and pressure extensions.
 */
export function readTcx(bytes: Uint8Array): ImportedActivity {
  const reader = new TcxReader();
  readXmlFile(bytes, reader);
  if (reader.activities === 0) throw new ImportError("not_an_activity", "the file holds no activity");
  if (reader.points.length === 0 && reader.untimed > 0) throw new ImportError("untimed", "the trackpoints have no time");
  return assembleActivity({
    format: "tcx",
    externalId: contentId(bytes),
    device: reader.device,
    name: null,
    sport: reader.sport === null ? null : sportOfTcx(reader.sport),
    startTime: reader.laps[0]?.startTime ?? reader.start,
    points: reader.points,
    segmentStarts: reader.segmentStarts,
    timer: [],
    lapStarts: reader.laps.map((lap) => lap.startTime),
    totals: lapTotals(reader.laps),
    pool: null,
  });
}

export type TcxTrigger = "Manual" | "Distance" | "Time";

export interface TcxLap {
  readonly startTime: number;
  /** Elapsed time outside the manual pauses. */
  readonly timerMs: number;
  readonly distanceMm: number;
  readonly energyKcal: number;
  readonly heartRateAvg: number | null;
  readonly heartRateMax: number | null;
  readonly trigger: TcxTrigger;
  /** One `Track` per continuous part of the lap. */
  readonly tracks: readonly (readonly ExportPoint[])[];
}

export interface TcxDocument {
  readonly sport: TcxSport;
  readonly startTime: number;
  readonly laps: readonly TcxLap[];
}

const isoOf = (time: number): string => new Date(time).toISOString();

function heartRateElement(name: string, bpm: number | null): string {
  return bpm === null ? "" : `<${name}><Value>${Math.max(1, Math.min(Math.round(bpm), 255))}</Value></${name}>`;
}

/** A bike's cadence is the trackpoint `Cadence` in pedal revolutions, any other the `RunCadence` extension in strides. */
function trackpointOf(point: ExportPoint, sport: TcxSport): string {
  const parts = [`<Time>${isoOf(point.time)}</Time>`, `<Position><LatitudeDegrees>${degreesOf(point.latitudeE7)}</LatitudeDegrees><LongitudeDegrees>${degreesOf(point.longitudeE7)}</LongitudeDegrees></Position>`];
  if (point.altitudeMm !== null) parts.push(`<AltitudeMeters>${(Math.round(point.altitudeMm / 100) / 10).toFixed(1)}</AltitudeMeters>`);
  parts.push(`<DistanceMeters>${(point.distanceMm / 1000).toFixed(2)}</DistanceMeters>`);
  parts.push(heartRateElement("HeartRateBpm", point.heartRate));
  const pedals = sport === "Biking";
  if (pedals && point.cadence !== null) parts.push(`<Cadence>${Math.min(Math.round(point.cadence), 254)}</Cadence>`);
  const garmin: string[] = [];
  if (point.speedMmS !== null) garmin.push(`<ns3:Speed>${(point.speedMmS / 1000).toFixed(3)}</ns3:Speed>`);
  if (!pedals && point.cadence !== null) garmin.push(`<ns3:RunCadence>${Math.min(Math.round(point.cadence), 254)}</ns3:RunCadence>`);
  if (point.power !== null) garmin.push(`<ns3:Watts>${Math.round(point.power)}</ns3:Watts>`);
  const extensions: string[] = garmin.length === 0 ? [] : [`<ns3:TPX>${garmin.join("")}</ns3:TPX>`];
  if (point.courseCentiDeg !== null) extensions.push(`<obnixe:course>${(point.courseCentiDeg / 100).toFixed(2)}</obnixe:course>`);
  extensions.push(...obnixeElements(point));
  if (extensions.length > 0) parts.push(`<Extensions>${extensions.join("")}</Extensions>`);
  return `<Trackpoint>${parts.join("")}</Trackpoint>`;
}

/**
 * Garmin Training Center v2 (`IO-003`): one `Activity` whose `Lap` elements hold their totals and one `Track` per continuous
 * part, trackpoints with position, altitude, counted distance, heart rate, pedaling cadence, and speed, stride cadence and power
 * in the Garmin `ActivityExtension` v2, and the course, fix accuracies and pressure in the Obnixe namespace.
 */
export function writeTcx(document: TcxDocument): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:obnixe="${obnixeNamespace}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">`,
    `<Activities><Activity Sport="${escapeXml(document.sport)}"><Id>${isoOf(document.startTime)}</Id>`,
  ];
  for (const lap of document.laps) {
    lines.push(
      `<Lap StartTime="${isoOf(lap.startTime)}"><TotalTimeSeconds>${(lap.timerMs / 1000).toFixed(3)}</TotalTimeSeconds><DistanceMeters>${(lap.distanceMm / 1000).toFixed(2)}</DistanceMeters><Calories>${Math.min(Math.round(lap.energyKcal), 65_535)}</Calories>${heartRateElement("AverageHeartRateBpm", lap.heartRateAvg)}${heartRateElement("MaximumHeartRateBpm", lap.heartRateMax)}<Intensity>Active</Intensity><TriggerMethod>${lap.trigger}</TriggerMethod>`,
    );
    for (const track of lap.tracks) {
      if (track.length === 0) continue;
      lines.push("<Track>", ...track.map((point) => trackpointOf(point, document.sport)), "</Track>");
    }
    lines.push("</Lap>");
  }
  lines.push("</Activity></Activities>", "</TrainingCenterDatabase>", "");
  return lines.join("\n");
}
