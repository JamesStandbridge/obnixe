import CoreLocation

/**
 Core Location fixes (`PLT-001`). Precise modes read `CLLocationUpdate.liveUpdates(.fitness)` on iOS 17+, which a
 `CLBackgroundActivitySession` keeps running while the app is not visible; the reduced accuracy of the battery modes
 and older systems use a `CLLocationManager` with background updates. Core Location delivers about one fix per second
 whatever is asked, so the source keeps one fix per `intervalMs`. Confined to the main thread, where the manager
 calls its delegate; fixes and issues reach their handlers on `queue`.
 */
final class CoreLocationSource: NSObject, LocationSource, CLLocationManagerDelegate {
  let kind = LocationSourceKind.coreLocation
  private let queue: DispatchQueue
  private let clock: TrackerClock
  private let background: Bool
  private let onFix: (Fix) -> Void
  private let onIssue: (TrackerIssue) -> Void
  private var manager: CLLocationManager?
  private var liveUpdates: Task<Void, Never>?
  /// A `CLBackgroundActivitySession`, which only exists on iOS 17+.
  private var backgroundSession: AnyObject?
  private var mode: LocationMode?
  private var lastT: Int64?

  init(queue: DispatchQueue, clock: TrackerClock, background: Bool, onFix: @escaping (Fix) -> Void, onIssue: @escaping (TrackerIssue) -> Void) {
    self.queue = queue
    self.clock = clock
    self.background = background
    self.onFix = onFix
    self.onIssue = onIssue
  }

  func start(_ mode: LocationMode) {
    DispatchQueue.main.async { self.apply(mode) }
  }

  func stop() {
    DispatchQueue.main.async { self.halt() }
  }

  private func apply(_ mode: LocationMode) {
    let manager = manager ?? makeManager()
    self.mode = mode
    if #available(iOS 17.0, *) {
      if background, backgroundSession == nil { backgroundSession = CLBackgroundActivitySession() }
      if mode.highAccuracy {
        manager.stopUpdatingLocation()
        if liveUpdates == nil { liveUpdates = readLiveUpdates() }
        return
      }
    }
    liveUpdates?.cancel()
    liveUpdates = nil
    manager.desiredAccuracy = mode.highAccuracy ? kCLLocationAccuracyBest : kCLLocationAccuracyNearestTenMeters
    manager.startUpdatingLocation()
  }

  private func halt() {
    mode = nil
    liveUpdates?.cancel()
    liveUpdates = nil
    manager?.stopUpdatingLocation()
    manager?.delegate = nil
    manager = nil
    if #available(iOS 17.0, *) { (backgroundSession as? CLBackgroundActivitySession)?.invalidate() }
    backgroundSession = nil
  }

  private func makeManager() -> CLLocationManager {
    let manager = CLLocationManager()
    manager.delegate = self
    manager.activityType = .fitness
    manager.distanceFilter = kCLDistanceFilterNone
    manager.pausesLocationUpdatesAutomatically = false
    if background {
      manager.allowsBackgroundLocationUpdates = true
      manager.showsBackgroundLocationIndicator = true
    }
    self.manager = manager
    return manager
  }

  @available(iOS 17.0, *)
  private func readLiveUpdates() -> Task<Void, Never> {
    Task { @MainActor [weak self] in
      do {
        for try await update in CLLocationUpdate.liveUpdates(.fitness) {
          guard let self, !Task.isCancelled else { return }
          if let location = update.location { self.deliver([location]) }
        }
      } catch {
        // The updates end with an error only when Core Location gives up; the authorization callback tells why.
      }
    }
  }

  /// A batch of locations shares its receipt time; older ones are placed before it by their timestamp difference.
  private func deliver(_ locations: [CLLocation]) {
    guard let mode, let newest = locations.last?.timestamp else { return }
    let receivedT = clock.now()
    for location in locations {
      let t = receivedT - Int64(roundedClamping: newest.timeIntervalSince(location.timestamp) * 1000)
      if let lastT, t - lastT < mode.intervalMs * 9 / 10 { continue }
      guard let fix = location.toFix(t: t, startedAt: clock.startedAt) else { continue }
      lastT = t
      queue.async { [onFix] in onFix(fix) }
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    deliver(locations)
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard mode != nil, !TrackerPermissions.isPrecise(manager) else { return }
    queue.async { [onIssue] in
      onIssue(CLLocationManager.locationServicesEnabled() ? .permissionLost : .providerDisabled)
    }
  }
}
