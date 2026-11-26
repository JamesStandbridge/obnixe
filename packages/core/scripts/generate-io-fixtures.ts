import { mkdirSync, writeFileSync } from "node:fs";
import { Encoder, Profile } from "@garmin/fitsdk";
import { gzipSync, zipSync } from "fflate";

const directory = new URL("../test/fixtures/import/", import.meta.url);
const malformed = new URL("malformed/", directory);
mkdirSync(malformed, { recursive: true });

let seed = 20_261_102;
function random(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
}

interface Sample {
  readonly time: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number;
  readonly heartRate: number;
  /** Strides or pedal revolutions per minute. */
  readonly cadence: number;
  readonly speed: number;
  readonly distance: number;
}

interface PathOptions {
  readonly start: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly count: number;
  readonly speed: number;
  readonly cadence: number;
  /** Inclusive range of the seconds between samples, as a watch's smart recording. */
  readonly interval: readonly [number, number];
  /** Seconds stopped after a sample index. */
  readonly gaps?: ReadonlyMap<number, number>;
}

function path(options: PathOptions): Sample[] {
  const samples: Sample[] = [];
  let { latitude, longitude } = options;
  let heading = 40;
  let time = options.start;
  let distance = 0;
  for (let index = 0; index < options.count; index += 1) {
    const progress = index / options.count;
    samples.push({
      time,
      latitude,
      longitude,
      altitude: 447 + 18 * Math.sin(progress * Math.PI * 2) + 6 * progress,
      heartRate: Math.round(118 + 40 * Math.min(progress * 3, 1) + 4 * Math.sin(index / 7)),
      cadence: Math.round(options.cadence + 3 * Math.sin(index / 5)),
      speed: options.speed * (0.92 + 0.16 * random()),
      distance,
    });
    const [low, high] = options.interval;
    const step = low + Math.floor(random() * (high - low + 1));
    const meters = (samples[index]?.speed ?? options.speed) * step;
    heading += (random() - 0.5) * 16;
    latitude += (meters * Math.cos((heading * Math.PI) / 180)) / 111_132;
    longitude += (meters * Math.sin((heading * Math.PI) / 180)) / (111_320 * Math.cos((latitude * Math.PI) / 180));
    distance += meters;
    time += (step + (options.gaps?.get(index) ?? 0)) * 1000;
  }
  return samples;
}

const iso = (time: number): string => new Date(time).toISOString();
const isoSeconds = (time: number): string => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
const fixed = (value: number, digits: number): string => value.toFixed(digits);

function write(name: string, content: string | Uint8Array, folder: URL = directory): void {
  writeFileSync(new URL(name, folder), content);
}

const garminRun = path({ start: Date.UTC(2026, 10, 2, 7, 31, 5), latitude: 45.899_213, longitude: 6.129_418, count: 120, speed: 3.1, cadence: 84, interval: [2, 2] });
write(
  "garmin-connect-run.gpx",
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx creator="Garmin Connect" version="1.1" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3">',
    "  <metadata>",
    '    <link href="connect.garmin.com">',
    "      <text>Garmin Connect</text>",
    "    </link>",
    `    <time>${iso(garminRun[0]?.time ?? 0)}</time>`,
    "  </metadata>",
    "  <trk>",
    "    <name>Annecy Course &#224; pied</name>",
    "    <type>running</type>",
    "    <trkseg>",
    ...garminRun.map((sample) =>
      [
        `      <trkpt lat="${fixed(sample.latitude, 14)}" lon="${fixed(sample.longitude, 14)}">`,
        `        <ele>${fixed(sample.altitude, 1)}</ele>`,
        `        <time>${iso(sample.time)}</time>`,
        "        <extensions>",
        "          <ns3:TrackPointExtension>",
        `            <ns3:hr>${sample.heartRate}</ns3:hr>`,
        `            <ns3:cad>${sample.cadence}</ns3:cad>`,
        "          </ns3:TrackPointExtension>",
        "        </extensions>",
        "      </trkpt>",
      ].join("\n"),
    ),
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
    "",
  ].join("\n"),
);

const ride = path({ start: Date.UTC(2026, 9, 18, 6, 2, 40), latitude: 45.861_02, longitude: 6.168_7, count: 100, speed: 7.4, cadence: 86, interval: [1, 1], gaps: new Map([[50, 240]]) });
write(
  "strava-ride.gpx",
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx creator="StravaGPX" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/GpxExtensions/v3 http://www.garmin.com/xmlschemas/GpxExtensionsv3.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">',
    " <metadata>",
    `  <time>${isoSeconds(ride[0]?.time ?? 0)}</time>`,
    " </metadata>",
    " <trk>",
    "  <name>Sortie v&#xE9;lo du matin</name>",
    "  <type>cycling</type>",
    "  <trkseg>",
    ...ride.map((sample) =>
      [
        `   <trkpt lat="${fixed(sample.latitude, 7)}" lon="${fixed(sample.longitude, 7)}">`,
        `    <ele>${fixed(sample.altitude, 1)}</ele>`,
        `    <time>${isoSeconds(sample.time)}</time>`,
        "    <extensions>",
        `     <power>${190 + Math.round(random() * 60)}</power>`,
        "     <gpxtpx:TrackPointExtension>",
        "      <gpxtpx:atemp>11</gpxtpx:atemp>",
        `      <gpxtpx:hr>${sample.heartRate}</gpxtpx:hr>`,
        `      <gpxtpx:cad>${sample.cadence}</gpxtpx:cad>`,
        "     </gpxtpx:TrackPointExtension>",
        "    </extensions>",
        "   </trkpt>",
      ].join("\n"),
    ),
    "  </trkseg>",
    " </trk>",
    "</gpx>",
    "",
  ].join("\n"),
);

const hike = path({ start: Date.UTC(2026, 7, 9, 5, 48, 0), latitude: 45.802_31, longitude: 6.231_95, count: 90, speed: 1.2, cadence: 52, interval: [4, 6] });
write(
  "komoot-hike.gpx",
  [
    "<?xml version='1.0' encoding='UTF-8'?>",
    '<gpx version="1.1" creator="https://www.komoot.de" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    "  <metadata>",
    "    <name><![CDATA[Col de la Forclaz – Montmin]]></name>",
    "    <author>",
    "      <link href=\"https://www.komoot.de\">",
    "        <text>komoot</text>",
    "        <type>text/html</type>",
    "      </link>",
    "    </author>",
    "  </metadata>",
    "  <trk>",
    "    <name><![CDATA[Col de la Forclaz – Montmin]]></name>",
    "    <trkseg>",
    ...hike.map((sample) => `      <trkpt lat="${fixed(sample.latitude, 6)}" lon="${fixed(sample.longitude, 6)}">\n        <ele>${fixed(sample.altitude + 400, 6)}</ele>\n        <time>${isoSeconds(sample.time)}</time>\n      </trkpt>`),
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
    "",
  ].join("\n"),
);

write(
  "komoot-route.gpx",
  [
    "<?xml version='1.0' encoding='UTF-8'?>",
    '<gpx version="1.1" creator="https://www.komoot.de" xmlns="http://www.topografix.com/GPX/1/1">',
    "  <metadata><name>Planned tour</name></metadata>",
    "  <trk>",
    "    <name>Planned tour</name>",
    "    <trkseg>",
    ...hike.slice(0, 20).map((sample) => `      <trkpt lat="${fixed(sample.latitude, 6)}" lon="${fixed(sample.longitude, 6)}">\n        <ele>${fixed(sample.altitude, 6)}</ele>\n      </trkpt>`),
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
    "",
  ].join("\n"),
);

const firstWalk = path({ start: Date.UTC(2026, 4, 1, 16, 0, 0), latitude: 45.9, longitude: 6.12, count: 40, speed: 1.4, cadence: 55, interval: [3, 3] });
const lastWalkStart = (firstWalk[firstWalk.length - 1]?.time ?? 0) + 600_000;
const secondWalk = path({ start: lastWalkStart, latitude: 45.905, longitude: 6.125, count: 40, speed: 1.4, cadence: 55, interval: [3, 3] });
write(
  "multi-track.gpx",
  [
    '<?xml version="1.0"?>',
    '<gpx version="1.0" creator="GPSBabel - https://www.gpsbabel.org" xmlns="http://www.topografix.com/GPX/1/0">',
    `<time>${isoSeconds(firstWalk[0]?.time ?? 0)}</time>`,
    ...[firstWalk, secondWalk].map((walk, index) =>
      [
        "<trk>",
        `  <name>ACTIVE LOG ${index + 1}</name>`,
        "  <type>walking</type>",
        "<trkseg>",
        ...walk.map((sample) => `<trkpt lat="${fixed(sample.latitude, 6)}" lon="${fixed(sample.longitude, 6)}"><time>${isoSeconds(sample.time)}</time><course>${fixed(90 + 10 * random(), 1)}</course><speed>${fixed(sample.speed, 2)}</speed></trkpt>`),
        "</trkseg>",
        "</trk>",
      ].join("\n"),
    ),
    "</gpx>",
    "",
  ].join("\n"),
);

const tcxRun = path({ start: Date.UTC(2026, 10, 12, 17, 45, 12), latitude: 45.913_4, longitude: 6.114_2, count: 80, speed: 3.4, cadence: 86, interval: [2, 2] });
const tcxLaps = [tcxRun.slice(0, 40), tcxRun.slice(40)];
function trackpoint(sample: Sample): string {
  return [
    "            <Trackpoint>",
    `              <Time>${iso(sample.time)}</Time>`,
    "              <Position>",
    `                <LatitudeDegrees>${fixed(sample.latitude, 14)}</LatitudeDegrees>`,
    `                <LongitudeDegrees>${fixed(sample.longitude, 14)}</LongitudeDegrees>`,
    "              </Position>",
    `              <AltitudeMeters>${fixed(sample.altitude, 1)}</AltitudeMeters>`,
    `              <DistanceMeters>${fixed(sample.distance, 2)}</DistanceMeters>`,
    "              <HeartRateBpm>",
    `                <Value>${sample.heartRate}</Value>`,
    "              </HeartRateBpm>",
    "              <Extensions>",
    "                <ns3:TPX>",
    `                  <ns3:Speed>${fixed(sample.speed, 3)}</ns3:Speed>`,
    `                  <ns3:RunCadence>${sample.cadence}</ns3:RunCadence>`,
    "                </ns3:TPX>",
    "              </Extensions>",
    "            </Trackpoint>",
  ].join("\n");
}
write(
  "garmin-run.tcx",
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd" xmlns:ns5="http://www.garmin.com/xmlschemas/ActivityGoals/v1" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:ns2="http://www.garmin.com/xmlschemas/UserProfile/v2" xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ns4="http://www.garmin.com/xmlschemas/ProfileExtension/v1">',
    "  <Activities>",
    '    <Activity Sport="Running">',
    `      <Id>${iso(tcxRun[0]?.time ?? 0)}</Id>`,
    ...tcxLaps.map((lap, index) => {
      const first = lap[0] ?? tcxRun[0];
      const last = lap[lap.length - 1] ?? first;
      const next = tcxLaps[index + 1]?.[0] ?? last;
      const seconds = ((next?.time ?? 0) - (first?.time ?? 0)) / 1000 + (index === tcxLaps.length - 1 ? 2 : 0);
      const meters = (next?.distance ?? 0) - (first?.distance ?? 0) + (index === tcxLaps.length - 1 ? 6.8 : 0);
      return [
        `      <Lap StartTime="${iso(first?.time ?? 0)}">`,
        `        <TotalTimeSeconds>${fixed(seconds, 1)}</TotalTimeSeconds>`,
        `        <DistanceMeters>${fixed(meters, 2)}</DistanceMeters>`,
        "        <MaximumSpeed>3.9</MaximumSpeed>",
        `        <Calories>${31 + index * 4}</Calories>`,
        `        <AverageHeartRateBpm><Value>${140 + index * 12}</Value></AverageHeartRateBpm>`,
        `        <MaximumHeartRateBpm><Value>${152 + index * 12}</Value></MaximumHeartRateBpm>`,
        "        <Intensity>Active</Intensity>",
        "        <TriggerMethod>Manual</TriggerMethod>",
        "        <Track>",
        ...lap.map(trackpoint),
        "        </Track>",
        "      </Lap>",
      ].join("\n");
    }),
    '      <Creator xsi:type="Device_t">',
    "        <Name>Forerunner 965</Name>",
    "        <UnitId>3456781234</UnitId>",
    "        <ProductID>4315</ProductID>",
    "      </Creator>",
    "    </Activity>",
    "  </Activities>",
    '  <Author xsi:type="Application_t">',
    "    <Name>Connect Api</Name>",
    "  </Author>",
    "</TrainingCenterDatabase>",
    "",
  ].join("\n"),
);

const semicircles = (degrees: number): number => Math.round((degrees * 2 ** 31) / 180);
const date = (time: number): Date => new Date(time);
const mesg = Profile.MesgNum;

interface FitHeader {
  readonly encoder: Encoder;
  readonly start: number;
}

function fitHeader(start: number, sportFields: { readonly sport: string; readonly subSport: string }, type = "activity"): FitHeader {
  const encoder = new Encoder();
  encoder.onMesg(mesg.FILE_ID, { type, manufacturer: "garmin", product: 4261, serialNumber: 3_456_789_012, timeCreated: date(start) });
  encoder.onMesg(mesg.DEVICE_INFO, { timestamp: date(start), deviceIndex: "creator", manufacturer: "garmin", product: 4261, softwareVersion: 14.22 });
  encoder.onMesg(mesg.SPORT, { ...sportFields, name: "Course" });
  return { encoder, start };
}

/** Venu 3S run in smart recording: points 1 to 7 s apart, a timer pause, two laps and a Stryd developer power field. */
function venuRun(): Uint8Array {
  const start = Date.UTC(2026, 10, 20, 6, 58, 30);
  const before = path({ start, latitude: 45.899_5, longitude: 6.129_8, count: 70, speed: 3.0, cadence: 83, interval: [1, 7] });
  const pauseStart = (before[before.length - 1]?.time ?? start) + 1000;
  const resume = pauseStart + 75_000;
  const stop = before[before.length - 1];
  const after = path({ start: resume, latitude: stop?.latitude ?? 45.9, longitude: stop?.longitude ?? 6.13, count: 70, speed: 3.2, cadence: 85, interval: [1, 7] }).map((sample) => ({
    ...sample,
    distance: sample.distance + (before[before.length - 1]?.distance ?? 0),
  }));
  const end = (after[after.length - 1]?.time ?? resume) + 1000;
  const { encoder } = fitHeader(start, { sport: "running", subSport: "generic" });
  const developerDataIdMesg = { developerDataIndex: 0, applicationId: Array.from({ length: 16 }, (_, index) => index * 7), applicationVersion: 112 };
  const fieldDescriptionMesg = { developerDataIndex: 0, fieldDefinitionNumber: 0, fitBaseTypeId: 0x84, fieldName: "Power", units: "Watts", nativeMesgNum: mesg.RECORD };
  encoder.onMesg(mesg.DEVELOPER_DATA_ID, developerDataIdMesg);
  encoder.onMesg(mesg.FIELD_DESCRIPTION, fieldDescriptionMesg);
  encoder.addDeveloperField("power", developerDataIdMesg, fieldDescriptionMesg);
  encoder.onMesg(mesg.EVENT, { timestamp: date(start), event: "timer", eventType: "start", eventGroup: 0 });
  const record = (sample: Sample): void => {
    encoder.onMesg(mesg.RECORD, {
      timestamp: date(sample.time),
      positionLat: semicircles(sample.latitude),
      positionLong: semicircles(sample.longitude),
      distance: sample.distance,
      enhancedSpeed: sample.speed,
      enhancedAltitude: sample.altitude,
      heartRate: sample.heartRate,
      cadence: sample.cadence,
      fractionalCadence: 0.5,
      temperature: 24,
      developerFields: { power: 230 + Math.round(random() * 40) },
    });
  };
  before.forEach(record);
  encoder.onMesg(mesg.EVENT, { timestamp: date(pauseStart), event: "timer", eventType: "stopAll", eventGroup: 0 });
  encoder.onMesg(mesg.EVENT, { timestamp: date(resume), event: "timer", eventType: "start", eventGroup: 0 });
  after.slice(0, 30).forEach(record);
  const lapSplit = after[30]?.time ?? resume;
  const lapDistance = after[30]?.distance ?? 0;
  encoder.onMesg(mesg.LAP, {
    timestamp: date(lapSplit),
    startTime: date(start),
    totalElapsedTime: (lapSplit - start) / 1000,
    totalTimerTime: (lapSplit - start - 75_000) / 1000,
    totalDistance: lapDistance,
    event: "lap",
    eventType: "stop",
    lapTrigger: "manual",
    sport: "running",
  });
  after.slice(30).forEach(record);
  const total = (after[after.length - 1]?.distance ?? 0) + 3;
  encoder.onMesg(mesg.EVENT, { timestamp: date(end), event: "timer", eventType: "stopAll", eventGroup: 0 });
  encoder.onMesg(mesg.LAP, {
    timestamp: date(end),
    startTime: date(lapSplit),
    totalElapsedTime: (end - lapSplit) / 1000,
    totalTimerTime: (end - lapSplit) / 1000,
    totalDistance: total - lapDistance,
    event: "lap",
    eventType: "stop",
    lapTrigger: "sessionEnd",
    sport: "running",
  });
  encoder.onMesg(mesg.SESSION, {
    timestamp: date(end),
    startTime: date(start),
    totalElapsedTime: (end - start) / 1000,
    totalTimerTime: (end - start - 75_000) / 1000,
    totalDistance: total,
    totalCalories: 61,
    avgHeartRate: 147,
    maxHeartRate: 163,
    sport: "running",
    subSport: "generic",
    firstLapIndex: 0,
    numLaps: 2,
    event: "session",
    eventType: "stop",
    trigger: "activityEnd",
  });
  encoder.onMesg(mesg.ACTIVITY, { timestamp: date(end), totalTimerTime: (end - start - 75_000) / 1000, numSessions: 1, type: "manual", event: "activity", eventType: "stop", localTimestamp: (end + 3_600_000) / 1000 - 631_065_600 });
  return encoder.close();
}

/** Venu 3S pool swim: 25 m pool, four sets of ten lengths with rests, heart rate records without positions. */
function venuPool(): Uint8Array {
  const start = Date.UTC(2026, 10, 24, 11, 5, 0);
  const { encoder } = fitHeader(start, { sport: "swimming", subSport: "lapSwimming" });
  encoder.onMesg(mesg.EVENT, { timestamp: date(start), event: "timer", eventType: "start", eventGroup: 0 });
  let time = start;
  let lengthIndex = 0;
  for (let set = 0; set < 4; set += 1) {
    const setStart = time;
    for (let length = 0; length < 10; length += 1) {
      const lengthStart = time;
      const seconds = 27 + Math.round(random() * 4);
      for (let second = 0; second < seconds; second += 5) encoder.onMesg(mesg.RECORD, { timestamp: date(time + second * 1000), heartRate: 128 + set * 6 + Math.round(random() * 5) });
      time += seconds * 1000;
      encoder.onMesg(mesg.LENGTH, {
        timestamp: date(time),
        messageIndex: lengthIndex,
        startTime: date(lengthStart),
        totalElapsedTime: seconds,
        totalTimerTime: seconds,
        totalStrokes: 18,
        avgSpeed: 25 / seconds,
        swimStroke: "freestyle",
        lengthType: "active",
        event: "length",
        eventType: "stop",
      });
      lengthIndex += 1;
    }
    const restStart = time;
    time += 45_000;
    encoder.onMesg(mesg.LENGTH, { timestamp: date(time), messageIndex: lengthIndex, startTime: date(restStart), totalElapsedTime: 45, totalTimerTime: 45, lengthType: "idle", event: "length", eventType: "stop" });
    lengthIndex += 1;
    encoder.onMesg(mesg.LAP, {
      timestamp: date(time),
      startTime: date(setStart),
      totalElapsedTime: (time - setStart) / 1000,
      totalTimerTime: (time - setStart) / 1000,
      totalDistance: 250,
      numLengths: 11,
      numActiveLengths: 10,
      event: "lap",
      eventType: "stop",
      lapTrigger: "manual",
      sport: "swimming",
      subSport: "lapSwimming",
    });
  }
  encoder.onMesg(mesg.EVENT, { timestamp: date(time), event: "timer", eventType: "stopAll", eventGroup: 0 });
  encoder.onMesg(mesg.SESSION, {
    timestamp: date(time),
    startTime: date(start),
    totalElapsedTime: (time - start) / 1000,
    totalTimerTime: (time - start) / 1000,
    totalDistance: 1000,
    totalCalories: 214,
    avgHeartRate: 139,
    maxHeartRate: 151,
    sport: "swimming",
    subSport: "lapSwimming",
    poolLength: 25,
    poolLengthUnit: "metric",
    numLengths: 44,
    numActiveLengths: 40,
    firstLapIndex: 0,
    numLaps: 4,
    event: "session",
    eventType: "stop",
    trigger: "activityEnd",
  });
  encoder.onMesg(mesg.ACTIVITY, { timestamp: date(time), totalTimerTime: (time - start) / 1000, numSessions: 1, type: "manual", event: "activity", eventType: "stop" });
  return encoder.close();
}

/** Treadmill run: speed, distance, cadence and heart rate without positions. */
function treadmill(): Uint8Array {
  const start = Date.UTC(2026, 10, 25, 18, 30, 0);
  const { encoder } = fitHeader(start, { sport: "running", subSport: "treadmill" });
  encoder.onMesg(mesg.EVENT, { timestamp: date(start), event: "timer", eventType: "start", eventGroup: 0 });
  let distance = 0;
  const seconds = 600;
  for (let second = 0; second <= seconds; second += 1) {
    encoder.onMesg(mesg.RECORD, { timestamp: date(start + second * 1000), distance, enhancedSpeed: 2.9, heartRate: 120 + Math.min(second / 10, 30), cadence: 82 });
    distance += 2.9;
  }
  const end = start + seconds * 1000;
  encoder.onMesg(mesg.EVENT, { timestamp: date(end), event: "timer", eventType: "stopAll", eventGroup: 0 });
  encoder.onMesg(mesg.LAP, { timestamp: date(end), startTime: date(start), totalElapsedTime: seconds, totalTimerTime: seconds, totalDistance: 1750, event: "lap", eventType: "stop", lapTrigger: "sessionEnd" });
  encoder.onMesg(mesg.SESSION, {
    timestamp: date(end),
    startTime: date(start),
    totalElapsedTime: seconds,
    totalTimerTime: seconds,
    totalDistance: 1750,
    totalCalories: 118,
    avgHeartRate: 146,
    maxHeartRate: 150,
    sport: "running",
    subSport: "treadmill",
    firstLapIndex: 0,
    numLaps: 1,
    event: "session",
    eventType: "stop",
    trigger: "activityEnd",
  });
  encoder.onMesg(mesg.ACTIVITY, { timestamp: date(end), totalTimerTime: seconds, numSessions: 1, type: "manual", event: "activity", eventType: "stop" });
  return encoder.close();
}

function course(): Uint8Array {
  const start = Date.UTC(2026, 10, 1, 9, 0, 0);
  const { encoder } = fitHeader(start, { sport: "running", subSport: "generic" }, "course");
  for (const sample of path({ start, latitude: 45.9, longitude: 6.13, count: 10, speed: 3, cadence: 80, interval: [5, 5] })) {
    encoder.onMesg(mesg.RECORD, { timestamp: date(sample.time), positionLat: semicircles(sample.latitude), positionLong: semicircles(sample.longitude), distance: sample.distance });
  }
  return encoder.close();
}

/** Road ride with a power meter: one record per second with crank cadence and power, a coasting stretch at 0 W and 0 rpm, and the session averages. */
function powerRide(): Uint8Array {
  const start = Date.UTC(2026, 10, 22, 8, 15, 0);
  const samples = path({ start, latitude: 45.92, longitude: 6.14, count: 600, speed: 8.5, cadence: 88, interval: [1, 1] });
  const end = (samples[samples.length - 1]?.time ?? start) + 1000;
  const { encoder } = fitHeader(start, { sport: "cycling", subSport: "road" });
  encoder.onMesg(mesg.EVENT, { timestamp: date(start), event: "timer", eventType: "start", eventGroup: 0 });
  let energy = 0;
  let maxPower = 0;
  samples.forEach((sample, index) => {
    const coasting = index >= 400 && index < 460;
    const power = coasting ? 0 : 190 + Math.round(random() * 60);
    energy += power;
    maxPower = Math.max(maxPower, power);
    encoder.onMesg(mesg.RECORD, {
      timestamp: date(sample.time),
      positionLat: semicircles(sample.latitude),
      positionLong: semicircles(sample.longitude),
      distance: sample.distance,
      enhancedSpeed: sample.speed,
      enhancedAltitude: sample.altitude,
      heartRate: sample.heartRate,
      cadence: coasting ? 0 : sample.cadence,
      power,
    });
  });
  const total = samples[samples.length - 1]?.distance ?? 0;
  const seconds = (end - start) / 1000;
  const avgPower = Math.round(energy / samples.length);
  encoder.onMesg(mesg.EVENT, { timestamp: date(end), event: "timer", eventType: "stopAll", eventGroup: 0 });
  encoder.onMesg(mesg.LAP, { timestamp: date(end), startTime: date(start), totalElapsedTime: seconds, totalTimerTime: seconds, totalDistance: total, avgPower, maxPower, event: "lap", eventType: "stop", lapTrigger: "sessionEnd", sport: "cycling" });
  encoder.onMesg(mesg.SESSION, {
    timestamp: date(end),
    startTime: date(start),
    totalElapsedTime: seconds,
    totalTimerTime: seconds,
    totalDistance: total,
    totalCalories: 160,
    avgHeartRate: 141,
    maxHeartRate: 158,
    avgPower,
    maxPower,
    sport: "cycling",
    subSport: "road",
    firstLapIndex: 0,
    numLaps: 1,
    event: "session",
    eventType: "stop",
    trigger: "activityEnd",
  });
  encoder.onMesg(mesg.ACTIVITY, { timestamp: date(end), totalTimerTime: seconds, numSessions: 1, type: "manual", event: "activity", eventType: "stop" });
  return encoder.close();
}

const run = venuRun();
write("venu3s-run.fit", run);
write("venu3s-pool-swim.fit", venuPool());
write("venu3s-treadmill.fit", treadmill());
write("venu3s-run.fit.gz", gzipSync(run, { mtime: 0 }));
write("garmin-export-original.zip", zipSync({ "21456789012_ACTIVITY.fit": [run, { mtime: new Date(Date.UTC(2026, 10, 20)) }] }));

const garminText = garminRun.map((sample) => `<trkpt lat="${fixed(sample.latitude, 7)}" lon="${fixed(sample.longitude, 7)}"><ele>${fixed(sample.altitude, 1)}</ele><time>${iso(sample.time)}</time></trkpt>`).join("\n");
const gpxOf = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>running</type><trkseg>\n${body}\n</trkseg></trk></gpx>\n`;
const whole = gpxOf(garminText);
write("truncated.gpx", whole.slice(0, Math.floor(whole.length * 0.6)), malformed);
const lines = garminText.split("\n");
write("unordered-times.gpx", gpxOf([...lines.slice(0, 20), lines[40] ?? "", ...lines.slice(20, 40), ...lines.slice(41)].join("\n")), malformed);
write("out-of-bounds.gpx", gpxOf(lines.map((line, index) => (index === 12 ? line.replace(/lat="[^"]+"/, 'lat="91.2000000"') : line)).join("\n")), malformed);
write("bare-ampersand.gpx", gpxOf(lines.slice(0, 10).join("\n")).replace("<type>running</type>", "<name>Run & fun</name><type>running</type>"), malformed);
write("no-track.gpx", '<?xml version="1.0"?>\n<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="45.9" lon="6.1"><name>Parking</name></wpt></gpx>\n', malformed);
const badCrc = run.slice();
badCrc[Math.floor(badCrc.length / 2)] = (badCrc[Math.floor(badCrc.length / 2)] ?? 0) ^ 0x40;
write("bad-crc.fit", badCrc, malformed);
write("truncated.fit", run.slice(0, Math.floor(run.length * 0.7)), malformed);
write("course.fit", course(), malformed);
write("two-activities.zip", zipSync({ "a.fit": run, "b.gpx": new TextEncoder().encode(whole) }), malformed);
write("photos.zip", zipSync({ "IMG_0001.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }), malformed);
const tcx = '<?xml version="1.0"?>\n<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities>';
const tcxActivity = (id: string): string => `<Activity Sport="Biking"><Id>${id}</Id><Lap StartTime="${id}"><TotalTimeSeconds>60</TotalTimeSeconds><DistanceMeters>400</DistanceMeters><Track><Trackpoint><Time>${id}</Time><Position><LatitudeDegrees>45.9</LatitudeDegrees><LongitudeDegrees>6.1</LongitudeDegrees></Position></Trackpoint></Track></Lap></Activity>`;
write("two-activities.tcx", `${tcx}${tcxActivity("2026-11-01T08:00:00Z")}${tcxActivity("2026-11-01T09:00:00Z")}</Activities></TrainingCenterDatabase>\n`, malformed);
write("unclosed.tcx", `${tcx}${tcxActivity("2026-11-01T08:00:00Z").replace("</Lap>", "")}</Activities></TrainingCenterDatabase>\n`, malformed);
write("not-an-activity.txt", "Ceci n'est pas une activité.\n", malformed);
write("power-ride.fit", powerRide());
