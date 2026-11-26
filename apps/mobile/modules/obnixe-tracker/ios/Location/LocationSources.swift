import Foundation

enum LocationSourceKind: String {
  case coreLocation = "core_location"
  case replay
}

/// Fix cadence asked of a source; `highAccuracy` false is the reduced accuracy of the battery modes (`NRG-001`).
struct LocationMode: Equatable {
  let intervalMs: Int64
  let highAccuracy: Bool
}

/// Callers hold the precise location permission; calling `start` again replaces the current mode. Fixes and issues reach their handlers on the recording queue.
protocol LocationSource: AnyObject {
  var kind: LocationSourceKind { get }

  func start(_ mode: LocationMode)

  func stop()
}

enum LocationSources {
  /// `background` keeps fixes coming while the app is not visible; the warm-up of `REC-012` runs without it.
  static func create(
    queue: DispatchQueue,
    clock: TrackerClock,
    background: Bool,
    replay: ReplayTrack?,
    onFix: @escaping (Fix) -> Void,
    onIssue: @escaping (TrackerIssue) -> Void
  ) -> LocationSource {
    if let replay {
      return ReplayLocationSource(track: replay, queue: queue, clock: clock, onFix: onFix)
    }
    return CoreLocationSource(queue: queue, clock: clock, background: background, onFix: onFix, onIssue: onIssue)
  }
}

/// A GPX track and the speed factor (1 to 50) at which it is replayed.
struct ReplayTrack {
  let points: [GpxPoint]
  let speed: Double
}

/**
 Replays a GPX track as simulated fixes (`DEC-08`). The recording's clock runs `speed` times faster, so each fix keeps
 the GPX time offset as its `t` and the replayed track keeps its real paces. GPX has no accuracy, Doppler speed nor
 bearing: accuracy is reported as 5 m and the other fields as absent. Confined to `queue`.
 */
private final class ReplayLocationSource: LocationSource {
  let kind = LocationSourceKind.replay
  private let track: ReplayTrack
  private let queue: DispatchQueue
  private let clock: TrackerClock
  private let onFix: (Fix) -> Void
  private let offsets: [Int64]
  private var next = 0
  private var startT: Int64 = 0
  private var startUptime = DispatchTime.now()
  private var running = false

  private static let accuracyDm = 50

  init(track: ReplayTrack, queue: DispatchQueue, clock: TrackerClock, onFix: @escaping (Fix) -> Void) {
    self.track = track
    self.queue = queue
    self.clock = clock
    self.onFix = onFix
    offsets = replayOffsets(track.points)
  }

  func start(_ mode: LocationMode) {
    guard !running else { return }
    running = true
    startT = clock.now()
    startUptime = .now()
    queue.async { [weak self] in self?.emit() }
  }

  func stop() {
    running = false
  }

  private func emit() {
    guard running else { return }
    let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startUptime.uptimeNanoseconds) / 1_000_000 * track.speed
    while next < offsets.count, Double(offsets[next]) <= elapsedMs {
      let point = track.points[next]
      onFix(
        Fix(
          t: startT + offsets[next],
          fixAgeMs: 0,
          latitudeE7: point.latitudeE7,
          longitudeE7: point.longitudeE7,
          altitudeEllipsoidMm: nil,
          altitudeMslMm: point.elevationMm,
          horizontalAccuracyDm: Self.accuracyDm,
          verticalAccuracyDm: point.elevationMm.map { _ in Self.accuracyDm * 2 },
          speedCmS: nil,
          speedAccuracyCmS: nil,
          bearingCentiDeg: nil,
          bearingAccuracyCentiDeg: nil,
          simulated: true
        )
      )
      next += 1
    }
    guard next < offsets.count else { return }
    let delayNs = UInt64(Double(offsets[next]) / track.speed * 1_000_000)
    queue.asyncAfter(deadline: DispatchTime(uptimeNanoseconds: startUptime.uptimeNanoseconds + delayNs)) { [weak self] in self?.emit() }
  }
}
