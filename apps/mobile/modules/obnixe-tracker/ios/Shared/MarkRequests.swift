import Foundation

/**
 Marks asked from the Live Activity (`REC-072`). Its button intent drops one empty file per request in the app group,
 named after the instant of the tap on the `CLOCK_MONOTONIC` base, then posts a Darwin notification; the recording
 writes the marks, in order and at those instants, when it hears the notification, when the app comes back to the
 foreground and before a stop. Compiled into the module, the app and the widget extension, whichever process runs the
 intent.
 */
enum MarkRequests {
  enum Kind: String {
    case pause
    case resume
    case lap
  }

  struct Request {
    let monotonicNs: Int64
    let kind: Kind
  }

  struct UnavailableError: Error {}

  static let notification = "app.obnixe.tracker.mark-request"

  /// Info.plist key holding the app group shared by the app and its widget extension.
  static let appGroupKey = "ObnixeTrackerAppGroup"

  static func post(_ kind: Kind, sessionId: String) throws {
    guard let directory = directory(of: sessionId) else { throw UnavailableError() }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let name = "\(clock_gettime_nsec_np(CLOCK_MONOTONIC))-\(kind.rawValue)"
    guard FileManager.default.createFile(atPath: directory.appendingPathComponent(name).path, contents: nil) else { throw UnavailableError() }
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(notification as CFString), nil, nil, true)
  }

  /// The pending requests of the session, oldest first, removed from the app group.
  static func take(sessionId: String) -> [Request] {
    guard let directory = directory(of: sessionId), let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return [] }
    var requests: [Request] = []
    for name in names {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
      let parts = name.split(separator: "-", maxSplits: 1)
      guard parts.count == 2, let monotonicNs = Int64(parts[0]), let kind = Kind(rawValue: String(parts[1])) else { continue }
      requests.append(Request(monotonicNs: monotonicNs, kind: kind))
    }
    return requests.sorted { $0.monotonicNs < $1.monotonicNs }
  }

  static func clear(sessionId: String) {
    guard let directory = directory(of: sessionId) else { return }
    try? FileManager.default.removeItem(at: directory)
  }

  private static func directory(of sessionId: String) -> URL? {
    guard UUID(uuidString: sessionId) != nil,
      let group = Bundle.main.object(forInfoDictionaryKey: appGroupKey) as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { return nil }
    return container.appendingPathComponent("obnixe-tracker/marks/\(sessionId)", isDirectory: true)
  }
}
