import CoreBluetooth

enum HeartRateGatt {
  static let service = CBUUID(string: "180D")
  static let measurement = CBUUID(string: "2A37")
}

/// `id` is the Core Bluetooth identifier of the peripheral, stable on this phone.
struct HeartRateDevice {
  let id: String
  let name: String
  let rssi: Int

  var bridge: [String: Any] {
    ["id": id, "name": name, "rssi": rssi]
  }
}

enum HeartRateScanEnd {
  case finished
  case unavailable
}

/**
 Scans for advertisers of the Heart Rate service, such as a Garmin watch broadcasting its heart rate. Each sighting is
 reported, so the RSSI stays current. Callers hold the Bluetooth permission; confined to `queue`.
 */
final class HeartRateScanner: NSObject, CBCentralManagerDelegate {
  private let queue: DispatchQueue
  private let onDevice: (HeartRateDevice) -> Void
  private var central: CBCentralManager?
  private var onEnd: ((HeartRateScanEnd) -> Void)?
  private var timeout: DispatchWorkItem?
  private var timeoutMs = 0

  init(queue: DispatchQueue, onDevice: @escaping (HeartRateDevice) -> Void) {
    self.queue = queue
    self.onDevice = onDevice
  }

  /// The scan starts once Bluetooth reports its state; `onEnd` tells why it ended.
  func start(timeoutMs: Int, onEnd: @escaping (HeartRateScanEnd) -> Void) {
    stop()
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

  private func end(_ reason: HeartRateScanEnd) {
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
      central.scanForPeripherals(withServices: [HeartRateGatt.service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
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
    onDevice(HeartRateDevice(id: peripheral.identifier.uuidString, name: name, rssi: RSSI.intValue))
  }
}
