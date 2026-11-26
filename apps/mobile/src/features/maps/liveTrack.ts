/*
 * Live polyline feeding the map (GPS-071): points are appended to a JSON text that is never rebuilt,
 * and listeners are notified at most once per second.
 */

/** How the track reached a point: moving, or across a pause or a signal gap (drawn dashed, MAP-010). */
export type LiveStretch = "moving" | "interrupted";

export interface LiveTrackPoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly stretch: LiveStretch;
}

export interface LivePosition {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number | null;
  /** Course over ground, clockwise from north. */
  readonly bearingDegrees: number | null;
}

export interface LiveMapFrame {
  /** GeoJSON FeatureCollection text: the `track` line (with `lineMetrics` progress) and the `interrupted` stretches. */
  readonly track: string;
  /** GeoJSON FeatureCollection text: the `start` and `position` points. */
  readonly points: string;
  readonly position: LivePosition | null;
}

export interface LiveMapFeed {
  readonly subscribe: (listener: () => void) => () => void;
  readonly frame: () => LiveMapFrame;
}

export const minPointSpacingMeters = 2;
export const minPublishIntervalMs = 1000;

const earthRadiusMeters = 6_371_008.8;
const webMercatorCircumference = 40_075_016.686;
/** Pixels per meter at zoom 0 and the equator, for 512 px MapLibre tiles. */
const pixelsPerMeterAtZoom0 = 512 / webMercatorCircumference;

const emptyCollection = '{"type":"FeatureCollection","features":[]}';

function closerThan(a: LiveTrackPoint, b: LiveTrackPoint, meters: number): boolean {
  const toRadians = Math.PI / 180;
  const x = (b.longitude - a.longitude) * toRadians * Math.cos(((a.latitude + b.latitude) / 2) * toRadians);
  const y = (b.latitude - a.latitude) * toRadians;
  return (x * x + y * y) * earthRadiusMeters * earthRadiusMeters < meters * meters;
}

function coordinate(latitude: number, longitude: number): string {
  return `[${longitude.toFixed(6)},${latitude.toFixed(6)}]`;
}

function feature(kind: string, geometry: string, properties = ""): string {
  return `{"type":"Feature","properties":{"kind":"${kind}"${properties}},"geometry":${geometry}}`;
}

export class LiveTrack implements LiveMapFeed {
  private readonly listeners = new Set<() => void>();
  private coordinates = "";
  private count = 0;
  private last: LiveTrackPoint | null = null;
  private start: string | null = null;
  private readonly interruptions: string[][] = [];
  private openInterruption: string[] | null = null;
  private position: LivePosition | null = null;
  private published: LiveMapFrame = { track: emptyCollection, points: emptyCollection, position: null };
  private publishedAt = Number.NEGATIVE_INFINITY;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly frame = (): LiveMapFrame => this.published;

  push(point: LiveTrackPoint): void {
    const last = this.last;
    if (last !== null && closerThan(last, point, minPointSpacingMeters)) return;
    const text = coordinate(point.latitude, point.longitude);
    if (last === null) {
      this.start = text;
    } else if (point.stretch === "interrupted") {
      if (this.openInterruption === null) {
        this.openInterruption = [coordinate(last.latitude, last.longitude)];
        this.interruptions.push(this.openInterruption);
      }
      this.openInterruption.push(text);
    } else {
      this.openInterruption = null;
    }
    this.coordinates = this.count === 0 ? text : `${this.coordinates},${text}`;
    this.count += 1;
    this.last = point;
    this.schedule();
  }

  locate(position: LivePosition): void {
    this.position = position;
    this.schedule();
  }

  /** Cancels the pending notification; the feed stays readable. */
  dispose(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.pending !== null) return;
    const wait = this.publishedAt + minPublishIntervalMs - this.now();
    if (wait <= 0) {
      this.publish();
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = null;
      this.publish();
    }, wait);
  }

  private publish(): void {
    this.publishedAt = this.now();
    this.published = { track: this.trackText(), points: this.pointsText(), position: this.position };
    for (const listener of this.listeners) listener();
  }

  private trackText(): string {
    const features: string[] = [];
    if (this.count >= 2) features.push(feature("track", `{"type":"LineString","coordinates":[${this.coordinates}]}`));
    if (this.interruptions.length > 0) {
      const lines = this.interruptions.map((stretch) => `[${stretch.join(",")}]`).join(",");
      features.push(feature("interrupted", `{"type":"MultiLineString","coordinates":[${lines}]}`));
    }
    return `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
  }

  private pointsText(): string {
    const features: string[] = [];
    if (this.start !== null) features.push(feature("start", `{"type":"Point","coordinates":${this.start}}`));
    const position = this.position;
    if (position !== null) {
      const accuracy = position.accuracyMeters === null ? 0 : (position.accuracyMeters * pixelsPerMeterAtZoom0) / Math.cos((position.latitude * Math.PI) / 180);
      const bearing = position.bearingDegrees === null ? "" : `,"bearing":${position.bearingDegrees.toFixed(1)}`;
      features.push(feature("position", `{"type":"Point","coordinates":${coordinate(position.latitude, position.longitude)}}`, `,"accuracy0":${accuracy.toPrecision(6)}${bearing}`));
    }
    return `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
  }
}
