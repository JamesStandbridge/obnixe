import AppIntents

@available(iOS 17.0, *)
enum RecordingMarkKind: String, AppEnum {
  case pause
  case resume
  case lap

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Marque"
  static let caseDisplayRepresentations: [RecordingMarkKind: DisplayRepresentation] = [
    .pause: "Pause",
    .resume: "Reprendre",
    .lap: "Tour",
  ]

  var request: MarkRequests.Kind {
    switch self {
    case .pause: return .pause
    case .resume: return .resume
    case .lap: return .lap
    }
  }
}

/**
 A Live Activity button (`REC-072`). Compiled into the widget extension, whose buttons name it, and into the app,
 where the system runs it, waking the app if it was suspended; the recording then writes the mark.
 */
@available(iOS 17.0, *)
struct RecordingMarkIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Marquer l'activité"
  static let isDiscoverable = false

  @Parameter(title: "Séance")
  var sessionId: String

  @Parameter(title: "Marque")
  var kind: RecordingMarkKind

  init() {}

  init(sessionId: String, kind: RecordingMarkKind) {
    self.sessionId = sessionId
    self.kind = kind
  }

  func perform() async throws -> some IntentResult {
    try MarkRequests.post(kind.request, sessionId: sessionId)
    return .result()
  }
}
