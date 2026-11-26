import Foundation

struct JournalHeader: Equatable {
  /// Canonical lowercase UUID of the session.
  var sessionId: String
  /// `t0`: EpochMs of the time origin.
  var startedAt: Int64
  /// `m0`: monotonic clock reading, in ns, taken together with `t0`.
  var monotonicOriginNs: Int64
  var platform: UInt8
  var device: String

  func encode() -> [UInt8] {
    let device = Self.truncatedUtf8(device, maxBytes: 255)
    var sink = ByteSink(capacity: 64 + device.count)
    sink.append(JournalFormat.magic)
    sink.u8(JournalFormat.version)
    sink.append(Self.uuidBytes(sessionId))
    sink.i64(startedAt)
    sink.i64(monotonicOriginNs)
    sink.u8(platform)
    sink.u8(UInt8(device.count))
    sink.append(device)
    sink.u32(sink.crc32(from: 0, count: sink.count))
    return sink.bytes
  }

  /// Reads the header at [offset] and moves [offset] right after it.
  static func decode(_ bytes: [UInt8], offset: inout Int) throws -> JournalHeader {
    let start = offset
    func need(_ count: Int) throws {
      if bytes.count - offset < count { throw JournalFormatError("Truncated journal header") }
    }
    try need(4 + 1 + 16 + 8 + 8 + 1 + 1)
    guard Array(bytes[start..<start + 4]) == JournalFormat.magic else { throw JournalFormatError("Not a raw journal") }
    let version = bytes[start + 4]
    guard version == JournalFormat.version else { throw JournalFormatError("Unsupported journal version \(version)") }
    let session = Array(bytes[start + 5..<start + 21])
    let startedAt = bytes.i64(at: start + 21)
    let monotonicOriginNs = bytes.i64(at: start + 29)
    let platform = bytes[start + 37]
    let deviceLength = Int(bytes[start + 38])
    offset = start + 39
    try need(deviceLength + 4)
    let device = bytes[offset..<offset + deviceLength]
    offset += deviceLength
    guard CRC32.checksum(bytes[start..<offset]) == bytes.u32(at: offset) else { throw JournalFormatError("Journal header checksum mismatch") }
    offset += 4
    return JournalHeader(
      sessionId: uuidString(session),
      startedAt: startedAt,
      monotonicOriginNs: monotonicOriginNs,
      platform: platform,
      device: String(decoding: device, as: UTF8.self)
    )
  }

  static func isSessionId(_ value: String) -> Bool {
    value.utf8.count == 36 && UUID(uuidString: value) != nil
  }

  private static func uuidBytes(_ sessionId: String) -> [UInt8] {
    precondition(isSessionId(sessionId), "Session id must be a UUID: \(sessionId)")
    let hex = Array(sessionId.utf8.filter { $0 != UInt8(ascii: "-") })
    return (0..<16).map { index in hexValue(hex[index * 2]) << 4 | hexValue(hex[index * 2 + 1]) }
  }

  private static func hexValue(_ digit: UInt8) -> UInt8 {
    switch digit {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): return digit - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): return digit - UInt8(ascii: "a") + 10
    default: return digit - UInt8(ascii: "A") + 10
    }
  }

  private static func uuidString(_ bytes: [UInt8]) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var text: [UInt8] = []
    for (index, byte) in bytes.enumerated() {
      if [4, 6, 8, 10].contains(index) { text.append(UInt8(ascii: "-")) }
      text.append(digits[Int(byte >> 4)])
      text.append(digits[Int(byte & 0x0F)])
    }
    return String(decoding: text, as: UTF8.self)
  }

  private static func truncatedUtf8(_ value: String, maxBytes: Int) -> [UInt8] {
    let bytes = Array(value.utf8)
    if bytes.count <= maxBytes { return bytes }
    var end = maxBytes
    while end > 0 && bytes[end] & 0xC0 == 0x80 { end -= 1 }
    return Array(bytes[..<end])
  }
}
