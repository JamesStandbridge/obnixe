import ExpoModulesCore
import Foundation

/// `saver` and `critical` are the battery modes of `NRG-001`: a fix every 5 s, then every 10 s.
enum TrackerPower: String, Enumerable {
  case normal
  case saver
  case critical
}

struct TrackerNotificationContent: Equatable {
  var title: String
  var text: String
  /// EpochMs at which the timer read zero; nil hides the timer.
  var timerBaseAt: Int64?
}

struct ReplaySource {
  let gpxURL: URL
  let speed: Double
}

struct BluetoothSensor: Equatable {
  let service: SensorService
  /// Core Bluetooth identifier of the source.
  let identifier: UUID
}

struct RecordingConfig {
  let sessionId: String
  let journalURL: URL
  var power: TrackerPower
  /// False for a stopwatch recording (`REC-060`): no location source, no location permission needed.
  let location: Bool
  let barometer: Bool
  let pedometer: Bool
  /// At most one per role; one source may appear under several services.
  let bluetooth: [BluetoothSensor]
  /// Interval of the parts sent to JavaScript while the app is in the foreground.
  let deliveryIntervalMs: Int64
  /// The same interval while the app is in the background.
  let backgroundDeliveryIntervalMs: Int64
  var notification: TrackerNotificationContent
  let replay: ReplaySource?
}
