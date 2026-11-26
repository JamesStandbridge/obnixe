import ActivityKit
import CoreBluetooth
import CoreLocation
import CoreMotion
import ExpoModulesCore

/// `activity` is Motion & Fitness (barometer and pedometer); `notifications` is the Live Activities switch.
enum TrackerPermission: String, Enumerable {
  case location
  case activity
  case bluetooth
  case notifications
}

/**
 Authorizations behind each tracker capability (`PRV-001`, `PRV-003`, `PRV-006`). Location is only ever asked while
 in use; when only an approximate position is granted, a request asks for temporary full accuracy. Live Activities
 have no prompt: only the system settings turn them on. Requests run on the main thread.
 */
final class TrackerPermissions: NSObject, CLLocationManagerDelegate, CBCentralManagerDelegate {
  static let shared = TrackerPermissions()

  private var locationManager: CLLocationManager?
  private var locationWaiters: [Promise] = []
  private var bluetooth: CBCentralManager?
  private var bluetoothWaiters: [Promise] = []
  private let pedometer = CMPedometer()

  /// Location counts as granted only with full accuracy (`PRV-003`).
  static func isGranted(_ permission: TrackerPermission) -> Bool {
    switch permission {
    case .location: return isPrecise(CLLocationManager())
    case .activity: return CMMotionActivityManager.authorizationStatus() == .authorized
    case .bluetooth: return CBManager.authorization == .allowedAlways
    case .notifications: return ActivityAuthorizationInfo().areActivitiesEnabled
    }
  }

  static func isPrecise(_ manager: CLLocationManager) -> Bool {
    let status = manager.authorizationStatus
    return (status == .authorizedWhenInUse || status == .authorizedAlways) && manager.accuracyAuthorization == .fullAccuracy
  }

  /// `{ grant, canAskAgain }` of the TypeScript `TrackerPermissionStatus`.
  static func status(_ permission: TrackerPermission) -> [String: Any] {
    switch permission {
    case .location:
      let manager = CLLocationManager()
      switch manager.authorizationStatus {
      case .notDetermined: return response("undetermined", canAskAgain: true)
      case .denied, .restricted: return response("denied", canAskAgain: false)
      case .authorizedWhenInUse, .authorizedAlways:
        return manager.accuracyAuthorization == .fullAccuracy ? response("granted", canAskAgain: true) : response("approximate", canAskAgain: true)
      @unknown default: return response("undetermined", canAskAgain: true)
      }
    case .activity:
      switch CMMotionActivityManager.authorizationStatus() {
      case .notDetermined: return response("undetermined", canAskAgain: true)
      case .denied, .restricted: return response("denied", canAskAgain: false)
      case .authorized: return response("granted", canAskAgain: true)
      @unknown default: return response("undetermined", canAskAgain: true)
      }
    case .bluetooth:
      switch CBManager.authorization {
      case .notDetermined: return response("undetermined", canAskAgain: true)
      case .denied, .restricted: return response("denied", canAskAgain: false)
      case .allowedAlways: return response("granted", canAskAgain: true)
      @unknown default: return response("undetermined", canAskAgain: true)
      }
    case .notifications:
      return ActivityAuthorizationInfo().areActivitiesEnabled ? response("granted", canAskAgain: true) : response("denied", canAskAgain: false)
    }
  }

  func request(_ permission: TrackerPermission, promise: Promise) {
    switch permission {
    case .location:
      let manager = locationManager ?? makeLocationManager()
      switch manager.authorizationStatus {
      case .notDetermined:
        locationWaiters.append(promise)
        manager.requestWhenInUseAuthorization()
      case .authorizedWhenInUse, .authorizedAlways:
        guard manager.accuracyAuthorization != .fullAccuracy else { return promise.resolve(Self.status(.location)) }
        manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: Self.fullAccuracyPurposeKey) { _ in
          DispatchQueue.main.async { promise.resolve(Self.status(.location)) }
        }
      case .denied, .restricted:
        promise.resolve(Self.status(.location))
      @unknown default:
        promise.resolve(Self.status(.location))
      }
    case .activity:
      guard CMMotionActivityManager.authorizationStatus() == .notDetermined, CMPedometer.isStepCountingAvailable() else { return promise.resolve(Self.status(.activity)) }
      let now = Date()
      pedometer.queryPedometerData(from: now, to: now) { _, _ in
        DispatchQueue.main.async { promise.resolve(Self.status(.activity)) }
      }
    case .bluetooth:
      guard CBManager.authorization == .notDetermined else { return promise.resolve(Self.status(.bluetooth)) }
      bluetoothWaiters.append(promise)
      if bluetooth == nil { bluetooth = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false]) }
    case .notifications:
      promise.resolve(Self.status(.notifications))
    }
  }

  /// Key of `NSLocationTemporaryUsageDescriptionDictionary`, written by the config plugin.
  private static let fullAccuracyPurposeKey = "Recording"

  private func makeLocationManager() -> CLLocationManager {
    let manager = CLLocationManager()
    manager.delegate = self
    locationManager = manager
    return manager
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard manager.authorizationStatus != .notDetermined else { return }
    let waiters = locationWaiters
    locationWaiters = []
    for waiter in waiters { waiter.resolve(Self.status(.location)) }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard CBManager.authorization != .notDetermined else { return }
    let waiters = bluetoothWaiters
    bluetoothWaiters = []
    bluetooth = nil
    for waiter in waiters { waiter.resolve(Self.status(.bluetooth)) }
  }

  private static func response(_ grant: String, canAskAgain: Bool) -> [String: Any] {
    ["grant": grant, "canAskAgain": canAskAgain]
  }
}
