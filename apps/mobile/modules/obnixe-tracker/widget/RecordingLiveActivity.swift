import ActivityKit
import SwiftUI
import WidgetKit

@main
struct ObnixeTrackerWidgets: WidgetBundle {
  var body: some Widget {
    RecordingLiveActivity()
  }
}

private enum Palette {
  static let background = Color(red: 0x0B / 255, green: 0x0E / 255, blue: 0x11 / 255)
  static let text = Color(red: 0xF2 / 255, green: 0xF5 / 255, blue: 0xF7 / 255)
  static let secondary = Color(red: 0xB0 / 255, green: 0xB8 / 255, blue: 0xC0 / 255)
  static let act = Color(red: 0xE5 / 255, green: 0xED / 255, blue: 0x32 / 255)
  static let actInk = Color(red: 0x12 / 255, green: 0x14 / 255, blue: 0x0A / 255)
}

/// Lock screen and Dynamic Island of a recording (`REC-072`); tapping it opens the live screen.
struct RecordingLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
      RecordingLockScreen(sessionId: context.attributes.sessionId, state: context.state)
        .activityBackgroundTint(Palette.background)
        .activitySystemActionForegroundColor(Palette.text)
        .widgetURL(liveScreenURL(context.attributes.sessionId))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text(context.state.title).font(.headline).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          RecordingTimer(state: context.state).font(.title3.weight(.semibold).monospacedDigit())
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 8) {
            Text(context.state.text).font(.subheadline).foregroundStyle(Palette.secondary).lineLimit(1)
            RecordingActions(sessionId: context.attributes.sessionId, paused: context.state.paused)
          }
        }
      } compactLeading: {
        StateIcon(paused: context.state.paused)
      } compactTrailing: {
        RecordingTimer(state: context.state).monospacedDigit().frame(maxWidth: 56)
      } minimal: {
        StateIcon(paused: context.state.paused)
      }
      .widgetURL(liveScreenURL(context.attributes.sessionId))
      .keylineTint(Palette.act)
    }
  }

  private func liveScreenURL(_ sessionId: String) -> URL? {
    URL(string: "obnixe://record/\(sessionId)")
  }
}

private struct RecordingLockScreen: View {
  let sessionId: String
  let state: RecordingActivityAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 2) {
          Text(state.title).font(.headline).foregroundStyle(Palette.text).lineLimit(1)
          Text(state.paused ? "En pause" : state.text).font(.subheadline).foregroundStyle(Palette.secondary).lineLimit(1)
        }
        Spacer(minLength: 12)
        RecordingTimer(state: state).font(.title2.weight(.semibold).monospacedDigit()).foregroundStyle(Palette.text)
      }
      RecordingActions(sessionId: sessionId, paused: state.paused)
    }
    .padding(16)
  }
}

private struct StateIcon: View {
  let paused: Bool

  var body: some View {
    Image(systemName: paused ? "pause.fill" : "record.circle").foregroundStyle(Palette.act)
  }
}

/// Running chronometer, or the time frozen by a pause.
private struct RecordingTimer: View {
  let state: RecordingActivityAttributes.ContentState

  var body: some View {
    if state.paused {
      Text(state.frozenTimerMs.map(formatTimer) ?? "Pause")
    } else if let timerBaseAt = state.timerBaseAt {
      Text(timerInterval: timerBaseAt...Date.distantFuture, countsDown: false)
    }
  }

  private func formatTimer(_ ms: Int64) -> String {
    let seconds = ms / 1000
    let hours = seconds / 3600
    let minutes = seconds / 60 % 60
    return hours > 0 ? String(format: "%lld:%02lld:%02lld", hours, minutes, seconds % 60) : String(format: "%lld:%02lld", minutes, seconds % 60)
  }
}

/// Pause or Resume and Lap, written by the app through `MarkRequests`; buttons in Live Activities need iOS 17.
private struct RecordingActions: View {
  let sessionId: String
  let paused: Bool

  var body: some View {
    if #available(iOS 17.0, *) {
      HStack(spacing: 8) {
        if paused {
          action("Reprendre", systemImage: "play.fill", kind: .resume)
        } else {
          action("Pause", systemImage: "pause.fill", kind: .pause)
          action("Tour", systemImage: "flag.fill", kind: .lap)
        }
      }
    }
  }

  @available(iOS 17.0, *)
  private func action(_ title: String, systemImage: String, kind: RecordingMarkKind) -> some View {
    Button(intent: RecordingMarkIntent(sessionId: sessionId, kind: kind)) {
      Label(title, systemImage: systemImage).font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .tint(Palette.act)
    .foregroundStyle(Palette.actInk)
  }
}
