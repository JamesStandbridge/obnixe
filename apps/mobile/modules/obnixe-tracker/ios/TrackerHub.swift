import ExpoModulesCore
import UIKit

enum JournalMode: String, Enumerable {
  case create
  case `continue`
}

/**
 Joins the recording, owned by the process and kept running in the background by its location updates, to the
 JavaScript module, which may come and go. Every recording, preparation and scan operation runs on one serial queue;
 JavaScript events are dropped while no module is attached, the journal keeping everything. A recording does not
 survive the app being killed: the next launch reconciles its journal (`REC-081`) and may continue it.
 */
final class TrackerHub: RecordingListener {
  static let shared = TrackerHub()

  weak var module: ObnixeTrackerModule?
  private let queue = DispatchQueue(label: "app.obnixe.tracker", qos: .userInitiated)
  private let activity = RecordingActivity()
  private var recording: Recording?
  private var preparation: LocationSource?
  private var lastStopped: StoppedRecording?
  private var scanner: SensorScanner?
  private var foreground = true
  private var bound = false
  private let statusLock = NSLock()
  private var published: [String: Any?] = ["state": "idle", "sessionId": nil]

  private func confined(_ block: @escaping () -> Void) {
    queue.async(execute: block)
  }

  /// Follows the app between foreground and background, hears the Live Activity's mark requests and ends the Live Activities of a previous run.
  func bind() {
    confined {
      guard !self.bound else { return }
      self.bound = true
      self.activity.endOrphans()
      let center = NotificationCenter.default
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in self.setForeground(false) }
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in self.setForeground(true) }
      CFNotificationCenterAddObserver(
        CFNotificationCenterGetDarwinNotifyCenter(),
        Unmanaged.passUnretained(self).toOpaque(),
        { _, _, _, _, _ in TrackerHub.shared.takeMarkRequests() },
        MarkRequests.notification as CFString,
        nil,
        .deliverImmediately
      )
      DispatchQueue.main.async {
        let foreground = UIApplication.shared.applicationState != .background
        self.setForeground(foreground)
      }
    }
  }

  func status() -> [String: Any?] {
    statusLock.withLock { published }
  }

  private func publishStatus() {
    let state: [String: Any?]
    if let recording {
      state = ["state": "recording", "sessionId": recording.sessionId]
    } else {
      state = ["state": preparation == nil ? "idle" : "preparing", "sessionId": nil]
    }
    statusLock.withLock { published = state }
  }

  /// Starts fixes in the foreground so the receiver is warm when the recording starts (`REC-012`).
  func prepare(_ promise: Promise) {
    confined {
      if self.recording != nil || self.preparation != nil { return promise.resolve() }
      guard TrackerPermissions.isGranted(.location) else { return promise.reject(TrackerException.locationPermission()) }
      let source = LocationSources.create(
        queue: self.queue,
        clock: TrackerClock.start(),
        background: false,
        replay: nil,
        onFix: { fix in self.module?.emitWarmupFix(fix) },
        onIssue: { _ in }
      )
      source.start(LocationMode(intervalMs: 1_000, highAccuracy: true))
      self.preparation = source
      self.publishStatus()
      promise.resolve()
    }
  }

  func cancelPreparation() {
    confined { self.stopPreparation() }
  }

  func start(_ config: RecordingConfig, mode: JournalMode, promise: Promise) {
    confined {
      guard self.recording == nil else { return promise.reject(TrackerException.alreadyRecording()) }
      guard self.foreground else { return promise.reject(TrackerException.foregroundStart()) }
      guard TrackerPermissions.isGranted(.location) else { return promise.reject(TrackerException.locationPermission()) }
      let replay: ReplayTrack?
      do {
        replay = try config.replay.map { source in ReplayTrack(points: try GpxReader.read(Data(contentsOf: source.gpxURL)), speed: source.speed) }
      } catch let error as GpxFormatError {
        return promise.reject(TrackerException.invalidRequest("Replay file is not GPX: \(error.description)"))
      } catch {
        return promise.reject(TrackerException.invalidRequest("Replay file unreadable: \(error.localizedDescription)"))
      }
      self.stopPreparation()
      let recording: Recording
      do {
        switch mode {
        case .create: recording = try Recording.create(config: config, replay: replay, queue: self.queue, listener: self)
        case .continue: recording = try Recording.open(config: config, queue: self.queue, listener: self)
        }
      } catch {
        return promise.reject(TrackerException.journal(error))
      }
      self.recording = recording
      let sources = recording.startSources(foreground: self.foreground)
      self.activity.start(sessionId: recording.sessionId, state: recording.activityState)
      self.publishStatus()
      promise.resolve(["startedAt": Double(recording.startedAt), "sources": sources.bridge])
    }
  }

  func mark(_ kind: MarkKind) {
    confined { self.recording?.mark(kind) }
  }

  func setPower(_ power: TrackerPower) {
    confined { self.recording?.setPower(power) }
  }

  func setNotification(_ content: TrackerNotificationContent) {
    confined { self.recording?.setNotification(content) }
  }

  /// Stops the recording; for a recording that already stopped itself, answers with how it ended.
  func stop(_ promise: Promise) {
    confined {
      guard let recording = self.recording else {
        guard let stopped = self.lastStopped else { return promise.reject(TrackerException.notRecording()) }
        return promise.resolve(stopped.bridge)
      }
      let stopped = recording.stop()
      if self.recording === recording { self.finish(stopped) }
      promise.resolve(stopped.bridge)
    }
  }

  func scanSensors(service: SensorService, timeoutMs: Int, promise: Promise) {
    confined {
      guard TrackerPermissions.isGranted(.bluetooth) else { return promise.reject(TrackerException.bluetoothPermission()) }
      let scanner = self.scanner ?? SensorScanner(queue: self.queue) { device in self.module?.emitSensorDevice(device) }
      self.scanner = scanner
      scanner.start(service: service, timeoutMs: timeoutMs) { end in
        switch end {
        case .finished: promise.resolve()
        case .unavailable: promise.reject(TrackerException.bluetoothUnavailable())
        }
      }
    }
  }

  func stopScan() {
    confined { self.scanner?.stop() }
  }

  private func takeMarkRequests() {
    confined { self.recording?.takeMarkRequests() }
  }

  private func setForeground(_ foreground: Bool) {
    confined {
      self.foreground = foreground
      self.recording?.setForeground(foreground)
    }
  }

  func recording(_ recording: Recording, didDeliver part: SamplePart) {
    module?.emitPart(sessionId: recording.sessionId, part: part)
  }

  func recording(_ recording: Recording, didWrite batch: JournalBatch) {
    module?.emitBatch(sessionId: recording.sessionId, batch: batch)
  }

  func recording(_ recording: Recording, didReport issue: TrackerIssue) {
    module?.emitIssue(sessionId: recording.sessionId, issue: issue)
  }

  func recordingDidChangeDisplay(_ recording: Recording) {
    guard self.recording === recording else { return }
    activity.update(recording.activityState)
  }

  func recording(_ recording: Recording, didStopItself stopped: StoppedRecording) {
    finish(stopped)
  }

  private func finish(_ stopped: StoppedRecording) {
    recording = nil
    lastStopped = stopped
    activity.end()
    publishStatus()
  }

  private func stopPreparation() {
    preparation?.stop()
    preparation = nil
    publishStatus()
  }
}
