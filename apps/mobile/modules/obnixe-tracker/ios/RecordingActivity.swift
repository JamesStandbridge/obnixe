import ActivityKit

/**
 Live Activity of the recording on the lock screen and in the Dynamic Island (`REC-072`), the counterpart of the
 Android notification; skipped when the user turned Live Activities off. Requests run one after the other, so the
 last state wins.
 */
final class RecordingActivity {
  private var activity: Activity<RecordingActivityAttributes>?
  private var pending: Task<Void, Never>?

  func start(sessionId: String, state: RecordingActivityAttributes.ContentState) {
    guard activity == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    activity = try? Activity.request(attributes: RecordingActivityAttributes(sessionId: sessionId), content: ActivityContent(state: state, staleDate: nil), pushType: nil)
  }

  func update(_ state: RecordingActivityAttributes.ContentState) {
    guard let activity else { return }
    enqueue { await activity.update(ActivityContent(state: state, staleDate: nil)) }
  }

  func end() {
    guard let activity else { return }
    self.activity = nil
    enqueue { await activity.end(nil, dismissalPolicy: .immediate) }
  }

  /// Ends the activities left by a previous run of the app, whose recording is gone.
  func endOrphans() {
    for orphan in Activity<RecordingActivityAttributes>.activities where orphan.id != activity?.id {
      enqueue { await orphan.end(nil, dismissalPolicy: .immediate) }
    }
  }

  private func enqueue(_ operation: @escaping () async -> Void) {
    let previous = pending
    pending = Task {
      await previous?.value
      await operation()
    }
  }
}
