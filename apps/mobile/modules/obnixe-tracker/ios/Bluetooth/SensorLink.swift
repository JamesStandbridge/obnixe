import CoreBluetooth

protocol SensorLinkListener: AnyObject {
  /// `receivedAtNs` is the monotonic instant the notification reached the phone.
  func sensorLink(_ link: SensorLink, service: SensorService, didNotify value: [UInt8], receivedAtNs: Int64)

  func sensorLinkDidLose(_ link: SensorLink)
}

/**
 Keeps a link to one Bluetooth source and streams the measurements of `services` (`SPT-007`, `SPT-008`), so a power
 meter that also serves cadence holds a single connection. Core Bluetooth connection requests never expire, so after a
 loss the link asks again and the system reconnects once the source is back, in the background too
 (`bluetooth-central`). A source this phone no longer knows is looked for by a scan of its services. Callers hold the
 Bluetooth permission; every callback runs on `queue`.
 */
final class SensorLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private enum State {
    case connecting
    case streaming
    case lost
  }

  let services: Set<SensorService>
  private let identifier: UUID
  private let queue: DispatchQueue
  private weak var listener: SensorLinkListener?
  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var state = State.connecting
  private var unsubscribed: Set<CBUUID> = []

  init(identifier: UUID, services: Set<SensorService>, queue: DispatchQueue, listener: SensorLinkListener) {
    self.identifier = identifier
    self.services = services
    self.queue = queue
    self.listener = listener
  }

  func start() {
    central = CBCentralManager(delegate: self, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: false])
  }

  func stop() {
    guard let central else { return }
    self.central = nil
    central.delegate = nil
    if central.isScanning { central.stopScan() }
    if let peripheral { central.cancelPeripheralConnection(peripheral) }
    peripheral = nil
  }

  private func connect() {
    guard let central, central.state == .poweredOn else { return }
    if peripheral == nil, let known = central.retrievePeripherals(withIdentifiers: [identifier]).first {
      known.delegate = self
      peripheral = known
    }
    if let peripheral {
      central.connect(peripheral)
    } else if !central.isScanning {
      central.scanForPeripherals(withServices: services.map(\.uuid))
    }
  }

  private func onFailure() {
    guard state != .lost else { return }
    state = .lost
    listener?.sensorLinkDidLose(self)
  }

  private func drop(_ peripheral: CBPeripheral) {
    central?.cancelPeripheralConnection(peripheral)
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      connect()
    case .unknown, .resetting:
      break
    case .poweredOff, .unauthorized, .unsupported:
      onFailure()
    @unknown default:
      onFailure()
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard peripheral.identifier == identifier else { return }
    central.stopScan()
    peripheral.delegate = self
    self.peripheral = peripheral
    connect()
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    unsubscribed = Set(services.map(\.measurement))
    peripheral.discoverServices(services.map(\.uuid))
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    onFailure()
    connect()
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    onFailure()
    connect()
  }

  /// A source missing one of the measurements is dropped, so its loss gets reported.
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    for service in services {
      guard let discovered = peripheral.services?.first(where: { $0.uuid == service.uuid }) else { return drop(peripheral) }
      peripheral.discoverCharacteristics([service.measurement], for: discovered)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard let sensor = services.first(where: { $0.uuid == service.uuid }), let measurement = service.characteristics?.first(where: { $0.uuid == sensor.measurement }) else {
      return drop(peripheral)
    }
    peripheral.setNotifyValue(true, for: measurement)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil, characteristic.isNotifying else { return drop(peripheral) }
    unsubscribed.remove(characteristic.uuid)
    if unsubscribed.isEmpty { state = .streaming }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    let receivedAtNs = TrackerClock.monotonicNs()
    guard let service = services.first(where: { $0.measurement == characteristic.uuid }), let value = characteristic.value else { return }
    listener?.sensorLink(self, service: service, didNotify: [UInt8](value), receivedAtNs: receivedAtNs)
  }
}
