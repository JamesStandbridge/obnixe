import { assembleActivity } from "./activity.ts";
import type { FilePoint, FileTotals, ImportedActivity } from "./activity.ts";
import { ImportError } from "./errors.ts";
import { sportOfTcx } from "./sports.ts";
import { contentId, parseDecimal, parseTime, positionE7 } from "./values.ts";
import { readXmlFile } from "./xml.ts";
import type { XmlAttributes, XmlHandler } from "./xml.ts";

interface TrackpointDraft {
  time: number | null;
  latitude: number | null;
  longitude: number | null;
  altitudeMm: number | null;
  heartRate: number | null;
  cadence: number | null;
  runCadence: number | null;
  speedMmS: number | null;
}

interface LapDraft {
  startTime: number;
  timerMs: number;
  distanceMm: number;
  energyKcal: number | null;
  heartRateAvg: number | null;
  heartRateMax: number | null;
}

/** Garmin Training Center v2 reader: one activity, its laps, and the trackpoints of all its tracks. */
class TcxReader implements XmlHandler {
  readonly points: FilePoint[] = [];
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
    }
    if (name === "Trackpoint") this.point = { time: null, latitude: null, longitude: null, altitudeMm: null, heartRate: null, cadence: null, runCadence: null, speedMmS: null };
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
      case "Speed":
        point.speedMmS = Math.round(parseDecimal(this.content, "speed") * 1000);
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
    this.points.push({
      time: point.time,
      latitudeE7: position?.latitudeE7 ?? null,
      longitudeE7: position?.longitudeE7 ?? null,
      altitudeMm: point.altitudeMm,
      heartRate: point.heartRate,
      cadence: point.runCadence ?? point.cadence,
      speedMmS: point.speedMmS,
      courseCentiDeg: null,
      horizontalAccuracyDm: null,
      verticalAccuracyDm: null,
      speedAccuracyCmS: null,
      pressurePa: null,
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
  };
}

/** Reads a TCX activity: laps (`IO-010`), lap totals for activities without positions (`IO-011`), `RunCadence` and `Speed` extensions. */
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
    segmentStarts: [],
    timer: [],
    lapStarts: reader.laps.map((lap) => lap.startTime),
    totals: lapTotals(reader.laps),
    pool: null,
  });
}
