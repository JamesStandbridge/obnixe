import { assembleActivity } from "./activity.ts";
import type { FilePoint, ImportedActivity } from "./activity.ts";
import { ImportError } from "./errors.ts";
import { sportOfGpxType } from "./sports.ts";
import { contentId, parseDecimal, parseTime, positionE7 } from "./values.ts";
import { readXmlFile } from "./xml.ts";
import type { XmlAttributes, XmlHandler } from "./xml.ts";

interface PointDraft {
  latitudeE7: number;
  longitudeE7: number;
  time: number | null;
  altitudeMm: number | null;
  heartRate: number | null;
  cadence: number | null;
  speedMmS: number | null;
  courseCentiDeg: number | null;
  horizontalAccuracyDm: number | null;
  verticalAccuracyDm: number | null;
  speedAccuracyCmS: number | null;
  pressurePa: number | null;
}

const obnixeNamespace = "https://obnixe.app/xmlschemas/gpx/1";

const centiDegrees = (degrees: number): number => ((Math.round(degrees * 100) % 36_000) + 36_000) % 36_000;

/** GPX 1.0 and 1.1 track reader: every `trk` and `trkseg` in document order, each new part after the first one a pause. */
class GpxReader implements XmlHandler {
  readonly points: FilePoint[] = [];
  readonly segmentStarts: number[] = [];
  name: string | null = null;
  type: string | null = null;
  untimed = 0;
  private readonly path: string[] = [];
  private content = "";
  private point: PointDraft | null = null;
  private segmentPending = false;

  open(name: string, attributes: XmlAttributes): void {
    if (this.path.length === 0 && name !== "gpx") throw new ImportError("unsupported_format", `the root element is <${name}>, not <gpx>`);
    this.path.push(name);
    this.content = "";
    if (name === "trkseg") this.segmentPending = this.points.length > 0;
    if (name !== "trkpt" || this.parent(1) !== "trkseg") return;
    const latitude = attributes.lat;
    const longitude = attributes.lon;
    if (latitude === undefined || longitude === undefined) throw new ImportError("invalid_value", "a track point has no lat or lon");
    const position = positionE7(parseDecimal(latitude, "latitude"), parseDecimal(longitude, "longitude"));
    this.point = {
      ...position,
      time: null,
      altitudeMm: null,
      heartRate: null,
      cadence: null,
      speedMmS: null,
      courseCentiDeg: null,
      horizontalAccuracyDm: null,
      verticalAccuracyDm: null,
      speedAccuracyCmS: null,
      pressurePa: null,
    };
  }

  text(text: string): void {
    this.content += text;
  }

  close(name: string): void {
    const parent = this.parent(1);
    this.path.pop();
    const point = this.point;
    if (point === null) {
      if (name === "name" && parent === "trk" && this.name === null) this.name = this.value();
      if (name === "name" && parent === "metadata") this.name ??= this.value();
      if (name === "type" && parent === "trk" && this.type === null) this.type = this.value();
      return;
    }
    switch (name) {
      case "trkpt":
        this.finishPoint(point);
        return;
      case "ele":
        point.altitudeMm = Math.round(parseDecimal(this.content, "elevation") * 1000);
        return;
      case "time":
        point.time = parseTime(this.content);
        return;
      case "hr":
      case "heartrate":
        point.heartRate = Math.round(parseDecimal(this.content, "heart rate"));
        return;
      case "cad":
      case "cadence":
        point.cadence = parseDecimal(this.content, "cadence");
        return;
      case "speed":
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

  private finishPoint(point: PointDraft): void {
    this.point = null;
    if (point.time === null) {
      this.untimed += 1;
      return;
    }
    if (this.segmentPending) this.segmentStarts.push(this.points.length);
    this.segmentPending = false;
    this.points.push({ ...point, time: point.time });
  }

  private parent(depth: number): string | undefined {
    return this.path[this.path.length - 1 - depth];
  }

  private value(): string | null {
    const value = this.content.trim();
    return value === "" ? null : value;
  }
}

/** Reads a GPX activity (`IO-013`): without `ele`, several `trk`, Garmin `TrackPointExtension` v1 or v2; points without `time` are left out. */
export function readGpx(bytes: Uint8Array): ImportedActivity {
  const reader = new GpxReader();
  readXmlFile(bytes, reader);
  if (reader.points.length === 0 && reader.untimed > 0) throw new ImportError("untimed", "the track points have no time: the file is a route, not an activity");
  return assembleActivity({
    format: "gpx",
    externalId: contentId(bytes),
    device: null,
    name: reader.name,
    sport: reader.type === null ? null : sportOfGpxType(reader.type),
    startTime: null,
    points: reader.points,
    segmentStarts: reader.segmentStarts,
    timer: [],
    lapStarts: [],
    totals: null,
    pool: null,
  });
}

export interface GpxPoint {
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  /** Orthometric altitude. */
  readonly altitudeMm: number | null;
  readonly time: number;
  readonly heartRate: number | null;
  readonly cadence: number | null;
  readonly speedMmS: number | null;
  readonly courseCentiDeg: number | null;
  readonly horizontalAccuracyDm: number | null;
  readonly verticalAccuracyDm: number | null;
  readonly speedAccuracyCmS: number | null;
  readonly pressurePa: number | null;
}

export interface GpxDocument {
  readonly name: string | null;
  readonly time: number;
  /** `trk/type`: the sport key (annex D). */
  readonly type: string;
  readonly segments: readonly (readonly GpxPoint[])[];
}

const escapeXml = (text: string): string => text.replace(/[<>&"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** A 1e-7 degree integer as an exact decimal with 7 places. */
function degreesOf(e7: number): string {
  const magnitude = Math.abs(e7);
  const fraction = String(magnitude % 10_000_000).padStart(7, "0");
  return `${e7 < 0 ? "-" : ""}${Math.floor(magnitude / 10_000_000)}.${fraction}`;
}

function extensionsOf(point: GpxPoint): string {
  const garmin: string[] = [];
  if (point.heartRate !== null) garmin.push(`<gpxtpx:hr>${point.heartRate}</gpxtpx:hr>`);
  if (point.cadence !== null) garmin.push(`<gpxtpx:cad>${point.cadence}</gpxtpx:cad>`);
  if (point.speedMmS !== null) garmin.push(`<gpxtpx:speed>${(point.speedMmS / 1000).toFixed(3)}</gpxtpx:speed>`);
  if (point.courseCentiDeg !== null) garmin.push(`<gpxtpx:course>${(point.courseCentiDeg / 100).toFixed(2)}</gpxtpx:course>`);
  const extensions = garmin.length === 0 ? [] : [`<gpxtpx:TrackPointExtension>${garmin.join("")}</gpxtpx:TrackPointExtension>`];
  if (point.horizontalAccuracyDm !== null) extensions.push(`<obnixe:hacc>${(point.horizontalAccuracyDm / 10).toFixed(1)}</obnixe:hacc>`);
  if (point.verticalAccuracyDm !== null) extensions.push(`<obnixe:vacc>${(point.verticalAccuracyDm / 10).toFixed(1)}</obnixe:vacc>`);
  if (point.speedAccuracyCmS !== null) extensions.push(`<obnixe:sacc>${(point.speedAccuracyCmS / 100).toFixed(2)}</obnixe:sacc>`);
  if (point.pressurePa !== null) extensions.push(`<obnixe:pressure>${point.pressurePa}</obnixe:pressure>`);
  return extensions.length === 0 ? "" : `<extensions>${extensions.join("")}</extensions>`;
}

/**
 * GPX 1.1 valid against the Topografix schema (`IO-001`): `metadata`, one `trk` whose `type` is the sport key, a `trkseg`
 * per continuous part, positions to 7 decimals, `ele` to 0.1 m, `time` in UTC to the millisecond, heart rate, cadence,
 * speed and course in Garmin `TrackPointExtension` v2, and the fix accuracies and the pressure in pascals in the Obnixe
 * namespace that other software ignores.
 */
export function writeGpx(document: GpxDocument): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="Obnixe" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" xmlns:obnixe="${obnixeNamespace}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v2 http://www.garmin.com/xmlschemas/TrackPointExtensionv2.xsd">`,
    `<metadata>${document.name === null ? "" : `<name>${escapeXml(document.name)}</name>`}<time>${new Date(document.time).toISOString()}</time></metadata>`,
    `<trk>${document.name === null ? "" : `<name>${escapeXml(document.name)}</name>`}<type>${escapeXml(document.type)}</type>`,
  ];
  for (const segment of document.segments) {
    if (segment.length === 0) continue;
    lines.push("<trkseg>");
    for (const point of segment) {
      const altitude = point.altitudeMm === null ? "" : `<ele>${(Math.round(point.altitudeMm / 100) / 10).toFixed(1)}</ele>`;
      lines.push(`<trkpt lat="${degreesOf(point.latitudeE7)}" lon="${degreesOf(point.longitudeE7)}">${altitude}<time>${new Date(point.time).toISOString()}</time>${extensionsOf(point)}</trkpt>`);
    }
    lines.push("</trkseg>");
  }
  lines.push("</trk>", "</gpx>", "");
  return lines.join("\n");
}
