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
