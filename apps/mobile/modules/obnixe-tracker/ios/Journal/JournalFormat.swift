import Foundation

/// Byte layout of the raw journal `.ojr` (annex C, little-endian, IEEE CRC-32).
enum JournalFormat {
  static let magic: [UInt8] = Array("OJRN".utf8)
  static let version: UInt8 = 1
  static let platformIOS: UInt8 = 2

  /// `length u32` and `sequence u32` before the records, `crc32 u32` after them.
  static let batchPrefixBytes = 8
  static let batchSuffixBytes = 4

  static let absentInt32 = Int32.min
  static let absentUInt16: UInt16 = 0xFFFF
  static let maxUInt16 = 0xFFFE
  static let maxUInt32 = Int64(UInt32.max)

  static let fixFlagSimulated: UInt8 = 0x01

  static let latitudeE7Range: ClosedRange<Int32> = -900_000_000...900_000_000
  static let longitudeE7Range: ClosedRange<Int32> = -1_800_000_000...1_800_000_000
}

enum RecordType: UInt8, CaseIterable {
  case fix = 1
  case pressure = 2
  case steps = 3
  case heartRate = 4
  case mark = 5

  var size: Int {
    switch self {
    case .fix: return 38
    case .pressure: return 9
    case .steps: return 9
    case .heartRate: return 10
    case .mark: return 6
    }
  }

  /// Last `t` of each stream, indexed by record type code.
  static func newClockArray() -> [Int64] {
    [Int64](repeating: 0, count: Int(allCases.map(\.rawValue).max() ?? 0) + 1)
  }
}

struct JournalFormatError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}
