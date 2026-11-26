import ActivityKit
import Foundation

/// Live Activity of a recording (`REC-072`): the app starts and updates it, the widget extension draws it. Compiled into both.
struct RecordingActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var title: String
    var text: String
    /// Instant at which the timer read zero; nil hides the timer.
    var timerBaseAt: Date?
    var paused: Bool
    /// Timer value shown while paused.
    var frozenTimerMs: Int64?
  }

  var sessionId: String
}
