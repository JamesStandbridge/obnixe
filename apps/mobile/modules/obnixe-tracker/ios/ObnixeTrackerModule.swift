import ExpoModulesCore
import Foundation

public final class ObnixeTrackerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ObnixeTracker")

    Events("onSamples", "onMark", "onIssue", "onHeartRateDevice", "onWarmupFix")

    OnCreate {
      TrackerHub.shared.module = self
      TrackerHub.shared.bind()
    }

    OnDestroy {
      if TrackerHub.shared.module === self { TrackerHub.shared.module = nil }
    }

    OnAppEntersBackground {
      TrackerHub.shared.cancelPreparation()
    }

    Function("status") {
      TrackerHub.shared.status()
    }

    AsyncFunction("getPermission") { (permission: TrackerPermission) -> [String: Any] in
      TrackerPermissions.status(permission)
    }
    .runOnQueue(.main)

    AsyncFunction("requestPermission") { (permission: TrackerPermission, promise: Promise) in
      TrackerPermissions.shared.request(permission, promise: promise)
    }
    .runOnQueue(.main)

    AsyncFunction("prepare") { (promise: Promise) in
      TrackerHub.shared.prepare(promise)
    }

    Function("cancelPreparation") {
      TrackerHub.shared.cancelPreparation()
    }

    AsyncFunction("start") { (request: StartRequestRecord, promise: Promise) in
      guard let config = request.toConfig() else { return promise.reject(TrackerException.invalidRequest("Invalid start request")) }
      TrackerHub.shared.start(config, mode: request.journal, promise: promise)
    }

    Function("mark") { (kind: ControlMark) in
      TrackerHub.shared.mark(kind.kind)
    }

    Function("setPower") { (power: TrackerPower) in
      TrackerHub.shared.setPower(power)
    }

    Function("setNotification") { (notification: NotificationRecord) in
      TrackerHub.shared.setNotification(notification.content)
    }

    AsyncFunction("scanHeartRate") { (timeoutMs: Double, promise: Promise) in
      TrackerHub.shared.scanHeartRate(timeoutMs: Int(min(max(timeoutMs, 1_000), 60_000)), promise: promise)
    }

    Function("stopScan") {
      TrackerHub.shared.stopScan()
    }

    AsyncFunction("stop") { (promise: Promise) in
      TrackerHub.shared.stop(promise)
    }
  }

  func emitBatch(sessionId: String, batch: JournalBatch) {
    let sequence = Double(batch.sequence)
    if !batch.samples.isEmpty {
      sendEvent("onSamples", ["sessionId": sessionId, "sequence": sequence, "samples": batch.samples.map(\.bridge)])
    }
    guard let mark = batch.mark else { return }
    sendEvent("onMark", ["sessionId": sessionId, "sequence": sequence, "kind": mark.kind.wire, "t": Double(mark.t)])
  }

  func emitIssue(sessionId: String, issue: TrackerIssue) {
    sendEvent("onIssue", ["sessionId": sessionId, "kind": issue.rawValue])
  }

  func emitHeartRateDevice(_ device: HeartRateDevice) {
    sendEvent("onHeartRateDevice", device.bridge)
  }

  func emitWarmupFix(_ fix: Fix) {
    sendEvent("onWarmupFix", fix.bridge)
  }
}

enum ControlMark: String, Enumerable {
  case pause
  case resume
  case lap

  var kind: MarkKind {
    switch self {
    case .pause: return .pause
    case .resume: return .resume
    case .lap: return .lap
    }
  }
}

struct NotificationRecord: Record {
  @Field var title: String = ""
  @Field var text: String = ""
  @Field var timerBaseAt: Double?

  var content: TrackerNotificationContent {
    TrackerNotificationContent(title: title, text: text, timerBaseAt: timerBaseAt.map { Int64($0) })
  }
}

struct SensorsRecord: Record {
  @Field var barometer: Bool = false
  @Field var pedometer: Bool = false
  @Field var heartRateDevice: String?
}

struct ReplayRecord: Record {
  @Field var gpxPath: String = ""
  @Field var speed: Double = 1
}

struct StartRequestRecord: Record {
  @Field var sessionId: String = ""
  @Field var journalPath: String = ""
  @Field var journal: JournalMode = .create
  @Field var power: TrackerPower = .normal
  @Field var sensors: SensorsRecord = SensorsRecord()
  @Field var batchIntervalMs: Double = 5_000
  @Field var notification: NotificationRecord = NotificationRecord()
  @Field var replay: ReplayRecord?

  /// The validated configuration, or nil when a field is out of its contract.
  func toConfig() -> RecordingConfig? {
    let heartRateDevice = sensors.heartRateDevice.flatMap { UUID(uuidString: $0) }
    let valid = JournalHeader.isSessionId(sessionId)
      && !journalPath.isEmpty
      && (batchIntervalMs == 1_000 || batchIntervalMs == 5_000)
      && (sensors.heartRateDevice == nil || heartRateDevice != nil)
      && (replay.map { (1...50).contains($0.speed) } ?? true)
    guard valid else { return nil }
    return RecordingConfig(
      sessionId: sessionId.lowercased(),
      journalURL: Self.fileURL(journalPath),
      power: power,
      barometer: sensors.barometer,
      pedometer: sensors.pedometer,
      heartRateDevice: heartRateDevice,
      batchIntervalMs: Int64(batchIntervalMs),
      notification: notification.content,
      replay: replay.map { ReplaySource(gpxURL: Self.fileURL($0.gpxPath), speed: $0.speed) }
    )
  }

  private static func fileURL(_ value: String) -> URL {
    if value.hasPrefix("file:"), let url = URL(string: value) { return url }
    return URL(fileURLWithPath: value)
  }
}
