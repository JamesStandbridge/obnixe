import CoreBluetooth

/// `id` is the Core Bluetooth identifier of the peripheral, stable on this phone.
struct SensorDevice {
  let service: SensorService
  let id: String
  let name: String
  let rssi: Int

  var bridge: [String: Any] {
    ["service": service.rawValue, "id": id, "name": name, "rssi": rssi]
  }
}

enum SensorScanEnd {
  case finished
  case unavailable
}

/**
 Scans for advertisers of one sensor service, such as a Garmin watch broadcasting its heart rate or a power meter. Each
 sighting is reported, so the RSSI stays current. Callers hold the Bluetooth permission; confined to `queue`.
 */
final class SensorScanner: NSObject, CBCentralManagerDelegate {
  private let queue: DispatchQueue
  private let onDevice: (SensorDevice) -> Void
  private var central: CBCentralManager?
  private var onEnd: ((SensorScanEnd) -> Void)?
  private var timeout: DispatchWorkItem?
  private var timeoutMs = 0
  private var service = SensorService.heartRate

  init(queue: DispatchQueue, onDevice: @escaping (SensorDevice) -> Void) {
    self.queue = queue
    self.onDevice = onDevice
  }

  /// The scan starts once Bluetooth reports its state; `onEnd` tells why it ended.
  func start(service: SensorService, timeoutMs: Int, onEnd: @escaping (SensorScanEnd) -> Void) {
    stop()
    self.service = service
    self.onEnd = onEnd
    self.timeoutMs = timeoutMs
    if let central {
      centralManagerDidUpdateState(central)
    } else {
      central = CBCentralManager(delegate: self, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: false])
    }
  }

  func stop() {
    end(.finished)
  }

  private func end(_ reason: SensorScanEnd) {
    timeout?.cancel()
    timeout = nil
    guard let onEnd else { return }
    self.onEnd = nil
    if central?.isScanning == true { central?.stopScan() }
    onEnd(reason)
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard onEnd != nil else { return }
    switch central.state {
    case .poweredOn:
      central.scanForPeripherals(withServices: [service.uuid], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
      guard timeout == nil else { return }
      let timeout = DispatchWorkItem { [weak self] in self?.stop() }
      self.timeout = timeout
      queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeout)
    case .unknown, .resetting:
      break
    case .poweredOff, .unauthorized, .unsupported:
      end(timeout == nil ? .unavailable : .finished)
    @unknown default:
      end(.unavailable)
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? ""
    onDevice(SensorDevice(service: service, id: peripheral.identifier.uuidString, name: name, rssi: RSSI.intValue))
  }
}
