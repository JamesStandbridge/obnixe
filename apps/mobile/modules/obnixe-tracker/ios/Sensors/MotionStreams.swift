import CoreMotion

/// Barometric pressure from `CMAltimeter` (`ELE-002`); its timestamps count from boot, so samples are placed by their age. Needs the Motion & Fitness permission.
final class PressureStream {
  private let altimeter = CMAltimeter()
  private let operations: OperationQueue

  /// Nil when the phone has no barometer.
  init?(queue: DispatchQueue) {
    guard CMAltimeter.isRelativeAltitudeAvailable() else { return nil }
    operations = OperationQueue.serial(on: queue)
  }

  func start(clock: TrackerClock, onSample: @escaping (PressureSample) -> Void) {
    altimeter.startRelativeAltitudeUpdates(to: operations) { data, _ in
      guard let data else { return }
      let ageMs = max(0, ProcessInfo.processInfo.systemUptime - data.timestamp) * 1000
      onSample(PressureSample(t: clock.now() - Int64(roundedClamping: ageMs), pascals: Int64(roundedClamping: data.pressure.doubleValue * 1000)))
    }
  }

  func stop() {
    altimeter.stopRelativeAltitudeUpdates()
  }
}

/// Steps from `CMPedometer`, counted from the start of the recording, so a continued journal keeps its cumulative count. Needs the Motion & Fitness permission.
final class StepStream {
  private let pedometer = CMPedometer()
  private let queue: DispatchQueue

  /// Nil when the phone cannot count steps.
  init?(queue: DispatchQueue) {
    guard CMPedometer.isStepCountingAvailable() else { return nil }
    self.queue = queue
  }

  func start(clock: TrackerClock, onSample: @escaping (StepSample) -> Void) {
    let origin = Date(timeIntervalSince1970: Double(clock.startedAt) / 1000)
    pedometer.startUpdates(from: origin) { [queue] data, _ in
      guard let data else { return }
      let sample = StepSample(t: clock.at(date: data.endDate), count: data.numberOfSteps.int64Value)
      queue.async { onSample(sample) }
    }
  }

  func stop() {
    pedometer.stopUpdates()
  }
}

private extension OperationQueue {
  static func serial(on queue: DispatchQueue) -> OperationQueue {
    let operations = OperationQueue()
    operations.underlyingQueue = queue
    operations.maxConcurrentOperationCount = 1
    return operations
  }
}
