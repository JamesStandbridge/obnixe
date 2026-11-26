/**
 Journal records in the integer units of annex C; `t` is in milliseconds since the recording's time origin on the
 monotonic time base (`GPS-012`). Mirrors `Sample` and `TrackerMark` of `packages/core/src/tracking/types.ts`.
 */
struct Fix: Equatable {
  var t: Int64
  /// `t` minus the GNSS timestamp of the fix, both on the recording's time axis.
  var fixAgeMs: Int32
  var latitudeE7: Int32
  var longitudeE7: Int32
  var altitudeEllipsoidMm: Int32?
  var altitudeMslMm: Int32?
  var horizontalAccuracyDm: Int?
  var verticalAccuracyDm: Int?
  var speedCmS: Int?
  var speedAccuracyCmS: Int?
  var bearingCentiDeg: Int?
  var bearingAccuracyCentiDeg: Int?
  var simulated: Bool

  var bridge: [String: Any?] {
    [
      "type": "fix",
      "t": Double(t),
      "fixAgeMs": Int(fixAgeMs),
      "latitudeE7": Int(latitudeE7),
      "longitudeE7": Int(longitudeE7),
      "altitudeEllipsoidMm": altitudeEllipsoidMm.map { Int($0) },
      "altitudeMslMm": altitudeMslMm.map { Int($0) },
      "horizontalAccuracyDm": horizontalAccuracyDm,
      "verticalAccuracyDm": verticalAccuracyDm,
      "speedCmS": speedCmS,
      "speedAccuracyCmS": speedAccuracyCmS,
      "bearingCentiDeg": bearingCentiDeg,
      "bearingAccuracyCentiDeg": bearingAccuracyCentiDeg,
      "simulated": simulated,
    ]
  }
}

struct PressureSample: Equatable {
  var t: Int64
  var pascals: Int64
}

struct StepSample: Equatable {
  var t: Int64
  /// Steps counted since the start of the recording.
  var count: Int64
}

enum HeartRateContact: UInt8 {
  case absent = 0
  case contact = 1
  case unsupported = 2

  var wire: String {
    switch self {
    case .absent: return "absent"
    case .contact: return "contact"
    case .unsupported: return "unsupported"
    }
  }
}

struct HeartRateSample: Equatable {
  var t: Int64
  var bpm: Int
  var contact: HeartRateContact
  /// Last RR interval in 1/1024 s.
  var rrInterval: Int?
}

struct CadenceSample: Equatable {
  var t: Int64
  /// Pedal revolutions or steps per minute, as the sport's cadence.
  var perMinute: Int
}

struct PowerSample: Equatable {
  var t: Int64
  var watts: Int
  /// Crank revolutions per minute from the power meter.
  var cadence: Int?
}

enum Sample: Equatable {
  case fix(Fix)
  case pressure(PressureSample)
  case steps(StepSample)
  case heartRate(HeartRateSample)
  case cadence(CadenceSample)
  case power(PowerSample)

  var t: Int64 {
    switch self {
    case .fix(let fix): return fix.t
    case .pressure(let sample): return sample.t
    case .steps(let sample): return sample.t
    case .heartRate(let sample): return sample.t
    case .cadence(let sample): return sample.t
    case .power(let sample): return sample.t
    }
  }

  var recordType: RecordType {
    switch self {
    case .fix: return .fix
    case .pressure: return .pressure
    case .steps: return .steps
    case .heartRate: return .heartRate
    case .cadence: return .cadence
    case .power: return .power
    }
  }

  var bridge: [String: Any?] {
    switch self {
    case .fix(let fix):
      return fix.bridge
    case .pressure(let sample):
      return ["type": "pressure", "t": Double(sample.t), "pascals": Double(sample.pascals)]
    case .steps(let sample):
      return ["type": "steps", "t": Double(sample.t), "count": Double(sample.count)]
    case .heartRate(let sample):
      return ["type": "heart_rate", "t": Double(sample.t), "bpm": sample.bpm, "contact": sample.contact.wire, "rrInterval": sample.rrInterval]
    case .cadence(let sample):
      return ["type": "cadence", "t": Double(sample.t), "perMinute": sample.perMinute]
    case .power(let sample):
      return ["type": "power", "t": Double(sample.t), "watts": sample.watts, "cadence": sample.cadence]
    }
  }
}

/// `extend` adds a minute to the current time step of a guided workout.
enum MarkKind: UInt8, CaseIterable {
  case start = 0
  case pause = 1
  case resume = 2
  case lap = 3
  case extend = 4
  case stop = 5

  var wire: String {
    switch self {
    case .start: return "start"
    case .pause: return "pause"
    case .resume: return "resume"
    case .lap: return "lap"
    case .extend: return "extend"
    case .stop: return "stop"
    }
  }
}

struct Mark: Equatable {
  var t: Int64
  var kind: MarkKind
}

extension FixedWidthInteger {
  /// [value] rounded to the nearest integer and clamped to the type's range; NaN reads as zero.
  init(roundedClamping value: Double) {
    let rounded = value.rounded()
    if rounded.isNaN {
      self = 0
    } else if rounded <= Double(Self.min) {
      self = .min
    } else if rounded >= Double(Self.max) {
      self = .max
    } else {
      self = Self(rounded)
    }
  }
}
