struct HeartRateMeasurement: Equatable {
  let bpm: Int
  let contact: HeartRateContact
  /// Last RR interval in 1/1024 s.
  let rrInterval: Int?

  /// Parses a Heart Rate Measurement characteristic value (`0x2A37`); nil when it is too short for its own flags.
  init?(_ value: [UInt8]) {
    guard let flags = value.first else { return nil }
    let wide = flags & 0x01 != 0
    var offset = 1
    guard value.count >= offset + (wide ? 2 : 1) else { return nil }
    bpm = wide ? Int(value.u16(at: offset)) : Int(value[offset])
    offset += wide ? 2 : 1
    if flags & 0x04 == 0 {
      contact = .unsupported
    } else {
      contact = flags & 0x02 != 0 ? .contact : .absent
    }
    if flags & 0x08 != 0 { offset += 2 }
    var rrInterval: Int?
    if flags & 0x10 != 0 {
      while offset + 2 <= value.count {
        rrInterval = Int(value.u16(at: offset))
        offset += 2
      }
    }
    self.rrInterval = rrInterval.flatMap { $0 > 0 ? $0 : nil }
  }
}

/// Cumulative crank revolutions and the time of the last one in 1/1024 s, both wrapping at 16 bits.
struct CrankRevolutions: Equatable {
  let revolutions: Int
  let eventTime: Int

  /// The crank data of a CSC Measurement (`0x2A5B`); nil without it or when the value is too short for its flags.
  init?(cscMeasurement value: [UInt8]) {
    guard let flags = value.first else { return nil }
    let offset = 1 + (flags & 0x01 != 0 ? 6 : 0)
    guard flags & 0x02 != 0, value.count >= offset + 4 else { return nil }
    self.init(revolutions: Int(value.u16(at: offset)), eventTime: Int(value.u16(at: offset + 2)))
  }

  init(revolutions: Int, eventTime: Int) {
    self.revolutions = revolutions
    self.eventTime = eventTime
  }
}

struct CyclingPowerMeasurement: Equatable {
  let watts: Int
  let crank: CrankRevolutions?

  /// Parses a Cycling Power Measurement (`0x2A63`); a negative power reads as 0 W. Nil when too short for its flags.
  init?(_ value: [UInt8]) {
    guard value.count >= 4 else { return nil }
    let flags = value.u16(at: 0)
    var offset = 4
    if flags & 0x01 != 0 { offset += 1 }
    if flags & 0x04 != 0 { offset += 2 }
    if flags & 0x10 != 0 { offset += 6 }
    if flags & 0x20 != 0 {
      guard value.count >= offset + 4 else { return nil }
      crank = CrankRevolutions(revolutions: Int(value.u16(at: offset)), eventTime: Int(value.u16(at: offset + 2)))
    } else {
      crank = nil
    }
    watts = max(Int(Int16(bitPattern: value.u16(at: 2))), 0)
  }

  init(watts: Int, crank: CrankRevolutions?) {
    self.watts = watts
    self.crank = crank
  }
}

/// Instantaneous cadence of an RSC Measurement (`0x2A53`) in steps per minute; nil when too short.
func rscCadence(_ value: [UInt8]) -> Int? {
  value.count < 4 ? nil : Int(value[3])
}

/**
 Turns successive crank revolution data into revolutions per minute. A notification without a new revolution reads
 0 rpm once `stoppedAfterNs` passed since the last one, and a first reading or an implausible cadence reads nil.
 */
final class CrankCadence {
  private var last: CrankRevolutions?
  private var lastEventNs: Int64 = 0

  private static let stoppedAfterNs: Int64 = 3_000_000_000
  private static let maxRpm = 250

  func push(receivedAtNs: Int64, _ crank: CrankRevolutions) -> Int? {
    guard let previous = last else {
      last = crank
      lastEventNs = receivedAtNs
      return nil
    }
    let revolutions = (crank.revolutions - previous.revolutions) & 0xFFFF
    let ticks = (crank.eventTime - previous.eventTime) & 0xFFFF
    if revolutions == 0 || ticks == 0 { return receivedAtNs - lastEventNs >= Self.stoppedAfterNs ? 0 : nil }
    last = crank
    lastEventNs = receivedAtNs
    let rpm = Int((Double(revolutions) * 60 * 1024 / Double(ticks)).rounded())
    return rpm <= Self.maxRpm ? rpm : nil
  }
}
