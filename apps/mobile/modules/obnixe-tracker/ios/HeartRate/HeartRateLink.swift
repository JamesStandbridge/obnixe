import CoreBluetooth

protocol HeartRateLinkListener: AnyObject {
  func heartRateLink(_ link: HeartRateLink, didMeasure measurement: HeartRateMeasurement)

  func heartRateLinkDidLose(_ link: HeartRateLink)
}

/**
 Keeps a link to one Heart Rate source and streams its measurements (`SPT-007`). Core Bluetooth connection requests
 never expire, so after a loss the link asks again and the system reconnects once the source is back, in the
 background too (`bluetooth-central`). A source this phone no longer knows is looked for by a Heart Rate scan. Callers
 hold the Bluetooth permission; every callback runs on `queue`.
 */
final class HeartRateLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private enum State {
    case connecting
    case streaming
    case lost
  }

  private let identifier: UUID
  private let queue: DispatchQueue
  private weak var listener: HeartRateLinkListener?
  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var state = State.connecting

  init(identifier: UUID, queue: DispatchQueue, listener: HeartRateLinkListener) {
    self.identifier = identifier
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
      central.scanForPeripherals(withServices: [HeartRateGatt.service])
    }
  }

  private func onFailure() {
    guard state != .lost else { return }
    state = .lost
    listener?.heartRateLinkDidLose(self)
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
    peripheral.discoverServices([HeartRateGatt.service])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    onFailure()
    connect()
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    onFailure()
    connect()
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let service = peripheral.services?.first(where: { $0.uuid == HeartRateGatt.service }) else { return drop(peripheral) }
    peripheral.discoverCharacteristics([HeartRateGatt.measurement], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard let measurement = service.characteristics?.first(where: { $0.uuid == HeartRateGatt.measurement }) else { return drop(peripheral) }
    peripheral.setNotifyValue(true, for: measurement)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil, characteristic.isNotifying else { return drop(peripheral) }
    state = .streaming
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == HeartRateGatt.measurement, let value = characteristic.value, let measurement = HeartRateMeasurement([UInt8](value)) else { return }
    listener?.heartRateLink(self, didMeasure: measurement)
  }
}
