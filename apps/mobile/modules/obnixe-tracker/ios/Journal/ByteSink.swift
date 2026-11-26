/// Growable little-endian byte buffer.
struct ByteSink {
  private(set) var bytes: [UInt8] = []

  init(capacity: Int) {
    bytes.reserveCapacity(capacity)
  }

  var count: Int { bytes.count }

  mutating func u8(_ value: UInt8) {
    bytes.append(value)
  }

  mutating func u16(_ value: UInt16) {
    bytes.append(UInt8(truncatingIfNeeded: value))
    bytes.append(UInt8(truncatingIfNeeded: value >> 8))
  }

  mutating func u32(_ value: UInt32) {
    withUnsafeBytes(of: value.littleEndian) { bytes.append(contentsOf: $0) }
  }

  mutating func i32(_ value: Int32) {
    u32(UInt32(bitPattern: value))
  }

  mutating func i64(_ value: Int64) {
    withUnsafeBytes(of: value.littleEndian) { bytes.append(contentsOf: $0) }
  }

  mutating func append(_ value: [UInt8]) {
    bytes.append(contentsOf: value)
  }

  mutating func setU32(at offset: Int, _ value: UInt32) {
    withUnsafeBytes(of: value.littleEndian) { bytes.replaceSubrange(offset..<offset + 4, with: $0) }
  }

  func crc32(from offset: Int, count: Int) -> UInt32 {
    CRC32.checksum(bytes[offset..<offset + count])
  }

  /// Keeps the first [length] bytes and the allocated capacity.
  mutating func truncate(to length: Int) {
    bytes.removeLast(bytes.count - length)
  }
}

extension Array where Element == UInt8 {
  func u16(at offset: Int) -> UInt16 {
    UInt16(self[offset]) | UInt16(self[offset + 1]) << 8
  }

  func u32(at offset: Int) -> UInt32 {
    UInt32(self[offset]) | UInt32(self[offset + 1]) << 8 | UInt32(self[offset + 2]) << 16 | UInt32(self[offset + 3]) << 24
  }

  func i32(at offset: Int) -> Int32 {
    Int32(bitPattern: u32(at: offset))
  }

  func i64(at offset: Int) -> Int64 {
    Int64(bitPattern: UInt64(u32(at: offset)) | UInt64(u32(at: offset + 4)) << 32)
  }
}
