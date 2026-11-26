/// IEEE CRC-32 (polynomial `0xEDB88320`, initial and final XOR `0xFFFFFFFF`), as `java.util.zip.CRC32` and the core reader.
enum CRC32 {
  private static let table: [UInt32] = (0..<256).map { index in
    (0..<8).reduce(UInt32(index)) { crc, _ in crc & 1 == 1 ? 0xEDB8_8320 ^ (crc >> 1) : crc >> 1 }
  }

  static func checksum(_ bytes: ArraySlice<UInt8>) -> UInt32 {
    var crc: UInt32 = 0xFFFF_FFFF
    for byte in bytes {
      crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
    }
    return crc ^ 0xFFFF_FFFF
  }
}
