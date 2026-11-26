import Foundation

enum TrackerIssue: String {
  case permissionLost = "permission_lost"
  case providerDisabled = "provider_disabled"
  case storageLow = "storage_low"
  case storageFull = "storage_full"
  case heartRateLost = "heart_rate_lost"
}

struct TrackerSources {
  let location: LocationSourceKind
  let barometer: Bool
  let pedometer: Bool
  let heartRate: Bool

  var bridge: [String: Any] {
    ["location": location.rawValue, "barometer": barometer, "pedometer": pedometer, "heartRate": heartRate]
  }
}

struct StoppedRecording {
  let sessionId: String
  let endedAt: Int64
  let lastSequence: Int

  var bridge: [String: Any] {
    ["sessionId": sessionId, "endedAt": Double(endedAt), "lastSequence": Double(lastSequence)]
  }
}

protocol RecordingListener: AnyObject {
  func recording(_ recording: Recording, didWrite batch: JournalBatch)

  func recording(_ recording: Recording, didReport issue: TrackerIssue)

  /// The pause state or the Live Activity content changed.
  func recordingDidChangeDisplay(_ recording: Recording)

  /// The recording stopped itself (storage full); the owner releases it.
  func recording(_ recording: Recording, didStopItself stopped: StoppedRecording)
}

/**
 One recording: its sources, its journal and its pause state. Samples reach the journal before JavaScript sees them
 (`REC-080`); batches close every `batchIntervalMs` while the app is in the foreground and every 5 s otherwise
 (`PRF-003`, `PRF-051`), and immediately on a mark. Confined to `queue`.
 */
final class Recording: HeartRateLinkListener {
  private(set) var config: RecordingConfig
  private(set) var paused: Bool
  /// Timer value frozen by a pause, restored on resume so the Live Activity stays right while JavaScript sleeps.
  private(set) var frozenTimerMs: Int64?

  var sessionId: String { config.sessionId }
  var startedAt: Int64 { clock.startedAt }

  var activityState: RecordingActivityAttributes.ContentState {
    RecordingActivityAttributes.ContentState(
      title: config.notification.title,
      text: config.notification.text,
      timerBaseAt: config.notification.timerBaseAt.map { Date(timeIntervalSince1970: Double($0) / 1000) },
      paused: paused,
      frozenTimerMs: frozenTimerMs
    )
  }

  private let journal: JournalWriter
  private let clock: TrackerClock
  private let replay: ReplayTrack?
  private let queue: DispatchQueue
  private weak var listener: RecordingListener?
  private var foreground = true
  private var location: LocationSource?
  private var pressure: PressureStream?
  private var steps: StepStream?
  private var heartRate: HeartRateLink?
  private var tick: DispatchWorkItem?
  private var stopped = false
  /// Set once the journal is closed; a storage-full self stop can happen while `stop()` drains the mark requests.
  private var ended: StoppedRecording?
  private var storageLowReported = false
  private var storageCheckedAt: Int64?

  private static let normalIntervalMs: Int64 = 1_000
  private static let pausedIntervalMs: Int64 = 5_000
  private static let saverIntervalMs: Int64 = 5_000
  private static let criticalIntervalMs: Int64 = 10_000
  private static let maxPendingBytes = 64 * 1024
  private static let storageCheckIntervalMs: Int64 = 30_000
  private static let storageLowBytes: Int64 = 50 * 1024 * 1024
  private static let storageFullBytes: Int64 = 10 * 1024 * 1024

  private init(config: RecordingConfig, journal: JournalWriter, clock: TrackerClock, replay: ReplayTrack?, queue: DispatchQueue, listener: RecordingListener, paused: Bool) {
    self.config = config
    self.journal = journal
    self.clock = clock
    self.replay = replay
    self.queue = queue
    self.listener = listener
    self.paused = paused
  }

  /// Starts every available source the configuration asks for and reports which ones run.
  func startSources(foreground: Bool) -> TrackerSources {
    self.foreground = foreground
    let location = LocationSources.create(
      queue: queue,
      clock: clock,
      background: true,
      replay: replay,
      onFix: { [weak self] fix in self?.onSample(.fix(fix)) },
      onIssue: { [weak self] issue in self?.report(issue) }
    )
    self.location = location
    startLocation()
    let live = replay == nil
    let motion = TrackerPermissions.isGranted(.activity)
    if live, motion, config.barometer, let pressure = PressureStream(queue: queue) {
      pressure.start(clock: clock) { [weak self] sample in self?.onSample(.pressure(sample)) }
      self.pressure = pressure
    }
    if live, motion, config.pedometer, let steps = StepStream(queue: queue) {
      steps.start(clock: clock) { [weak self] sample in self?.onSample(.steps(sample)) }
      self.steps = steps
    }
    if let device = config.heartRateDevice, live || replay?.speed == 1, TrackerPermissions.isGranted(.bluetooth) {
      let heartRate = HeartRateLink(identifier: device, queue: queue, listener: self)
      heartRate.start()
      self.heartRate = heartRate
    }
    scheduleTick()
    return TrackerSources(location: location.kind, barometer: pressure != nil, pedometer: steps != nil, heartRate: heartRate != nil)
  }

  /// Writes a pause, resume or lap mark at `t` (now by default); false when the pause state makes it meaningless (lap or pause while paused).
  @discardableResult
  func mark(_ kind: MarkKind, at t: Int64? = nil) -> Bool {
    guard !stopped else { return false }
    let accepted: Bool
    switch kind {
    case .pause, .lap: accepted = !paused
    case .resume: accepted = paused
    case .start, .stop: accepted = false
    }
    guard accepted else { return false }
    if kind == .pause || kind == .resume {
      paused = kind == .pause
      updateTimer()
      startLocation()
      listener?.recordingDidChangeDisplay(self)
    }
    flush(mark: Mark(t: t ?? clock.now(), kind: kind))
    return true
  }

  /// Writes the marks asked from the Live Activity since the last call.
  func takeMarkRequests() {
    guard !stopped else { return }
    for request in MarkRequests.take(sessionId: sessionId) {
      let t = min(clock.at(monotonicNs: request.monotonicNs), clock.now())
      switch request.kind {
      case .pause: mark(.pause, at: t)
      case .resume: mark(.resume, at: t)
      case .lap: mark(.lap, at: t)
      }
    }
  }

  func setPower(_ power: TrackerPower) {
    guard !stopped, power != config.power else { return }
    config.power = power
    startLocation()
    if power == .critical { flush() }
  }

  func setNotification(_ notification: TrackerNotificationContent) {
    guard !stopped else { return }
    config.notification = notification
    listener?.recordingDidChangeDisplay(self)
  }

  func setForeground(_ foreground: Bool) {
    guard !stopped, foreground != self.foreground else { return }
    self.foreground = foreground
    if foreground { takeMarkRequests() }
    flush()
    scheduleTick()
  }

  /// Writes the pending Live Activity marks, stops the sources, writes the stop mark and closes the journal.
  func stop() -> StoppedRecording {
    takeMarkRequests()
    if let ended { return ended }
    let endT = clock.now()
    release()
    let batch = try? journal.flush(mark: Mark(t: endT, kind: .stop))
    journal.close()
    if let batch { listener?.recording(self, didWrite: batch) }
    let stopped = StoppedRecording(sessionId: sessionId, endedAt: startedAt + (batch?.mark?.t ?? endT), lastSequence: batch?.sequence ?? journal.nextSequence - 1)
    ended = stopped
    return stopped
  }

  private func release() {
    stopped = true
    tick?.cancel()
    tick = nil
    location?.stop()
    pressure?.stop()
    steps?.stop()
    heartRate?.stop()
    MarkRequests.clear(sessionId: sessionId)
  }

  private func onSample(_ sample: Sample) {
    guard !stopped, journal.append(sample) else { return }
    if journal.pendingBytes >= Self.maxPendingBytes { flush() }
  }

  private func report(_ issue: TrackerIssue) {
    guard !stopped else { return }
    listener?.recording(self, didReport: issue)
  }

  func heartRateLink(_ link: HeartRateLink, didMeasure measurement: HeartRateMeasurement) {
    onSample(.heartRate(HeartRateSample(t: clock.now(), bpm: measurement.bpm, contact: measurement.contact, rrInterval: measurement.rrInterval)))
  }

  func heartRateLinkDidLose(_ link: HeartRateLink) {
    report(.heartRateLost)
  }

  private func startLocation() {
    let intervalMs: Int64
    switch config.power {
    case .normal: intervalMs = paused ? Self.pausedIntervalMs : Self.normalIntervalMs
    case .saver: intervalMs = Self.saverIntervalMs
    case .critical: intervalMs = Self.criticalIntervalMs
    }
    location?.start(LocationMode(intervalMs: intervalMs, highAccuracy: config.power == .normal))
  }

  private func updateTimer() {
    let now = TrackerClock.wallMs()
    if paused {
      frozenTimerMs = config.notification.timerBaseAt.map { now - $0 }
    } else if let frozen = frozenTimerMs {
      config.notification.timerBaseAt = now - frozen
      frozenTimerMs = nil
    }
  }

  private func scheduleTick() {
    tick?.cancel()
    guard !stopped else { return }
    let tick = DispatchWorkItem { [weak self] in
      self?.flush()
      self?.scheduleTick()
    }
    self.tick = tick
    let intervalMs = foreground ? config.batchIntervalMs : RecordingConfig.backgroundBatchIntervalMs
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(intervalMs)), execute: tick)
  }

  private func flush(mark: Mark? = nil) {
    let batch: JournalBatch?
    do {
      batch = try journal.flush(mark: mark)
    } catch {
      return selfStop()
    }
    guard let batch else { return }
    listener?.recording(self, didWrite: batch)
    checkStorage(at: batch.mark?.t ?? clock.now())
  }

  /// Every 30 s at most: the capacity query is not free and a journal grows by about 50 bytes per second.
  private func checkStorage(at t: Int64) {
    if let storageCheckedAt, t - storageCheckedAt < Self.storageCheckIntervalMs { return }
    storageCheckedAt = t
    let directory = URL(fileURLWithPath: config.journalURL.deletingLastPathComponent().path, isDirectory: true)
    guard let free = (try? directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage else { return }
    if free < Self.storageFullBytes {
      selfStop()
    } else if free < Self.storageLowBytes, !storageLowReported {
      storageLowReported = true
      report(.storageLow)
    }
  }

  private func selfStop() {
    guard !stopped else { return }
    report(.storageFull)
    listener?.recording(self, didStopItself: stop())
  }

  /// Creates the journal and writes the start mark at `t = 0`.
  static func create(config: RecordingConfig, replay: ReplayTrack?, queue: DispatchQueue, listener: RecordingListener) throws -> Recording {
    let clock = TrackerClock.start(rate: replay?.speed ?? 1)
    let header = JournalHeader(sessionId: config.sessionId, startedAt: clock.startedAt, monotonicOriginNs: clock.originNs, platform: JournalFormat.platformIOS, device: deviceName())
    let journal = try JournalWriter.create(at: config.journalURL, header: header)
    let start: JournalBatch?
    do {
      start = try journal.flush(mark: Mark(t: 0, kind: .start))
    } catch {
      journal.close()
      try? FileManager.default.removeItem(at: config.journalURL)
      throw error
    }
    let recording = Recording(config: config, journal: journal, clock: clock, replay: replay, queue: queue, listener: listener, paused: false)
    if let start { listener.recording(recording, didWrite: start) }
    return recording
  }

  /// Continues the journal of an interrupted session, or of one resumed from its stop summary.
  /// A stop mark at the last record (unless the journal already ends with one) and a start mark now turn the gap into a pause (`REC-081`).
  static func open(config: RecordingConfig, queue: DispatchQueue, listener: RecordingListener) throws -> Recording {
    let resumed = try JournalWriter.resume(at: config.journalURL, afterStop: true)
    let header = resumed.writer.header
    guard header.sessionId == config.sessionId else {
      resumed.writer.close()
      throw JournalFormatError("Journal belongs to session \(header.sessionId)")
    }
    let clock = TrackerClock.continuing(startedAt: header.startedAt, originNs: header.monotonicOriginNs)
    let batches: [JournalBatch]
    do {
      let stop = resumed.stopped ? nil : try resumed.writer.flush(mark: Mark(t: resumed.lastT, kind: .stop))
      let start = try resumed.writer.flush(mark: Mark(t: clock.now(), kind: .start))
      batches = [stop, start].compactMap { $0 }
    } catch {
      resumed.writer.close()
      throw error
    }
    let recording = Recording(config: config, journal: resumed.writer, clock: clock, replay: nil, queue: queue, listener: listener, paused: false)
    for batch in batches { listener.recording(recording, didWrite: batch) }
    return recording
  }

  /// The hardware model, such as `Apple iPhone17,1`.
  private static func deviceName() -> String {
    var system = utsname()
    uname(&system)
    let machine = withUnsafeBytes(of: &system.machine) { bytes in String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self) }
    return "Apple \(machine)"
  }
}
