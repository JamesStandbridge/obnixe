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

struct RecordingConfig {
  let sessionId: String
  let journalURL: URL
  var power: TrackerPower
  let barometer: Bool
  let pedometer: Bool
  /// Core Bluetooth identifier of the heart rate source.
  let heartRateDevice: UUID?
  /// Batch interval while the app is in the foreground; batches are `backgroundBatchIntervalMs` apart otherwise.
  let batchIntervalMs: Int64
  var notification: TrackerNotificationContent
  let replay: ReplaySource?

  static let backgroundBatchIntervalMs: Int64 = 5_000
}
