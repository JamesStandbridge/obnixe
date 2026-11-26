import CoreBluetooth
import ExpoModulesCore

/// What a paired source measures; its loss is reported once per role (`SPT-007`, `SPT-008`).
enum SensorRole {
  case heartRate
  case cadence
  case power

  var issue: TrackerIssue {
    switch self {
    case .heartRate: return .heartRateLost
    case .cadence: return .cadenceLost
    case .power: return .powerLost
    }
  }
}

/// The GATT services of the Bluetooth sources, each streaming one measurement characteristic.
enum SensorService: String, Enumerable {
  case heartRate = "heart_rate"
  case cyclingSpeedCadence = "cycling_speed_cadence"
  case cyclingPower = "cycling_power"
  case runningSpeedCadence = "running_speed_cadence"

  var uuid: CBUUID {
    switch self {
    case .heartRate: return CBUUID(string: "180D")
    case .cyclingSpeedCadence: return CBUUID(string: "1816")
    case .cyclingPower: return CBUUID(string: "1818")
    case .runningSpeedCadence: return CBUUID(string: "1814")
    }
  }

  var measurement: CBUUID {
    switch self {
    case .heartRate: return CBUUID(string: "2A37")
    case .cyclingSpeedCadence: return CBUUID(string: "2A5B")
    case .cyclingPower: return CBUUID(string: "2A63")
    case .runningSpeedCadence: return CBUUID(string: "2A53")
    }
  }

  var role: SensorRole {
    switch self {
    case .heartRate: return .heartRate
    case .cyclingSpeedCadence, .runningSpeedCadence: return .cadence
    case .cyclingPower: return .power
    }
  }
}
