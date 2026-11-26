import Foundation
import XCTest
@testable import ObnixeTracker

final class JournalWriterTests: XCTestCase {
  private var directory: URL!
  private var url: URL!

  private let header = JournalHeader(
    sessionId: "3f2b8c1e-7a4d-4e9b-9c21-5d6e7f809a1b",
    startedAt: 1_795_000_000_123,
    monotonicOriginNs: 98_765_432_101_234,
    platform: JournalFormat.platformIOS,
    device: "Apple iPhone17,1"
  )

  private let fix = Fix(
    t: 1_000,
    fixAgeMs: 250,
    latitudeE7: 458_326_000,
    longitudeE7: -68_652_000,
    altitudeEllipsoidMm: 1_042_300,
    altitudeMslMm: 1_090_100,
    horizontalAccuracyDm: 38,
    verticalAccuracyDm: 52,
    speedCmS: 312,
    speedAccuracyCmS: 40,
    bearingCentiDeg: 27_050,
    bearingAccuracyCentiDeg: 1_200,
    simulated: false
  )

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    url = directory.appendingPathComponent("session.ojr")
  }

  override func tearDownWithError() throws {
    try FileManager.default.removeItem(at: directory)
  }

  private func bytes() throws -> [UInt8] {
    [UInt8](try Data(contentsOf: url))
  }

  private func write(_ bytes: [UInt8]) throws {
    try Data(bytes).write(to: url)
  }

  private func crc(_ bytes: [UInt8], _ from: Int, _ to: Int) -> UInt32 {
    CRC32.checksum(bytes[from..<to])
  }

  private var headerLength: Int { header.encode().count }

  private func withWriter(_ body: (JournalWriter) throws -> Void) throws {
    let writer = try JournalWriter.create(at: url, header: header)
    defer { writer.close() }
    try body(writer)
  }

  private func fix(_ change: (inout Fix) -> Void) -> Sample {
    var copy = fix
    change(&copy)
    return .fix(copy)
  }

  func testHeaderFollowsAnnexCByteForByte() throws {
    let bytes = header.encode()
    XCTAssertEqual(bytes.count, 4 + 1 + 16 + 8 + 8 + 1 + 1 + 16 + 4)
    XCTAssertEqual(Array(bytes[0..<4]), Array("OJRN".utf8))
    XCTAssertEqual(bytes[4], 1)
    XCTAssertEqual(bytes[5], 0x3F)
    XCTAssertEqual(bytes[20], 0x1B)
    XCTAssertEqual(bytes.i64(at: 21), header.startedAt)
    XCTAssertEqual(bytes.i64(at: 29), header.monotonicOriginNs)
    XCTAssertEqual(bytes[37], 2)
    XCTAssertEqual(bytes[38], 16)
    XCTAssertEqual(String(decoding: bytes[39..<55], as: UTF8.self), "Apple iPhone17,1")
    XCTAssertEqual(bytes.u32(at: 55), crc(bytes, 0, 55))
    var offset = 0
    XCTAssertEqual(try JournalHeader.decode(bytes, offset: &offset), header)
    XCTAssertEqual(offset, bytes.count)
  }

  func testHeaderDecodingRejectsADamagedHeader() {
    var bytes = header.encode()
    bytes[25] &+= 1
    var offset = 0
    XCTAssertThrowsError(try JournalHeader.decode(bytes, offset: &offset))
  }

  func testLongDeviceNamesAreCutAtACharacterBoundary() throws {
    var long = header
    long.device = String(repeating: "é", count: 200)
    let bytes = long.encode()
    XCTAssertEqual(bytes[38], 254)
    var offset = 0
    XCTAssertEqual(try JournalHeader.decode(bytes, offset: &offset).device, String(repeating: "é", count: 127))
  }

  func testUppercaseSessionIdsAreStoredLowercase() throws {
    var upper = header
    upper.sessionId = header.sessionId.uppercased()
    var offset = 0
    XCTAssertEqual(try JournalHeader.decode(upper.encode(), offset: &offset).sessionId, header.sessionId)
    XCTAssertTrue(JournalHeader.isSessionId(upper.sessionId))
    XCTAssertFalse(JournalHeader.isSessionId("3f2b8c1e7a4d4e9b9c215d6e7f809a1b"))
  }

  func testABatchIsFramedByItsLengthSequenceAndChecksum() throws {
    try withWriter { writer in
      XCTAssertTrue(writer.append(.pressure(PressureSample(t: 500, pascals: 101_325))))
      let batch = try XCTUnwrap(try writer.flush(mark: Mark(t: 600, kind: .lap)))
      XCTAssertEqual(batch, JournalBatch(sequence: 0, samples: [.pressure(PressureSample(t: 500, pascals: 101_325))], mark: Mark(t: 600, kind: .lap)))
    }
    let bytes = try bytes()
    let start = headerLength
    XCTAssertEqual(bytes.count, start + 8 + 9 + 6 + 4)
    XCTAssertEqual(bytes.u32(at: start), 15)
    XCTAssertEqual(bytes.u32(at: start + 4), 0)
    XCTAssertEqual(bytes[start + 8], 2)
    XCTAssertEqual(bytes.u32(at: start + 9), 500)
    XCTAssertEqual(bytes.u32(at: start + 13), 101_325)
    XCTAssertEqual(bytes[start + 17], 5)
    XCTAssertEqual(bytes.u32(at: start + 18), 600)
    XCTAssertEqual(bytes[start + 22], 3)
    XCTAssertEqual(bytes.u32(at: start + 23), crc(bytes, start, start + 23))
  }

  func testFixRecordsHoldEveryFieldAtItsOffset() throws {
    try withWriter { writer in
      XCTAssertTrue(writer.append(.fix(fix)))
      _ = try writer.flush()
    }
    let bytes = try bytes()
    let at = headerLength + 8
    XCTAssertEqual(bytes.u32(at: headerLength), 38)
    XCTAssertEqual(bytes[at], 1)
    XCTAssertEqual(bytes.u32(at: at + 1), 1_000)
    XCTAssertEqual(bytes.i32(at: at + 5), 250)
    XCTAssertEqual(bytes.i32(at: at + 9), 458_326_000)
    XCTAssertEqual(bytes.i32(at: at + 13), -68_652_000)
    XCTAssertEqual(bytes.i32(at: at + 17), 1_042_300)
    XCTAssertEqual(bytes.i32(at: at + 21), 1_090_100)
    XCTAssertEqual(bytes.u16(at: at + 25), 38)
    XCTAssertEqual(bytes.u16(at: at + 27), 52)
    XCTAssertEqual(bytes.u16(at: at + 29), 312)
    XCTAssertEqual(bytes.u16(at: at + 31), 40)
    XCTAssertEqual(bytes.u16(at: at + 33), 27_050)
    XCTAssertEqual(bytes.u16(at: at + 35), 1_200)
    XCTAssertEqual(bytes[at + 37], 0)
  }

  func testAbsentFixFieldsUseTheSentinelsAndPresentOnesAreClampedBelowThem() throws {
    try withWriter { writer in
      XCTAssertTrue(writer.append(fix {
        $0.altitudeEllipsoidMm = nil
        $0.altitudeMslMm = nil
        $0.horizontalAccuracyDm = 70_000
        $0.verticalAccuracyDm = nil
        $0.speedCmS = 0xFFFF
        $0.speedAccuracyCmS = nil
        $0.bearingCentiDeg = nil
        $0.bearingAccuracyCentiDeg = -5
        $0.simulated = true
      }))
      _ = try writer.flush()
    }
    let bytes = try bytes()
    let at = headerLength + 8
    XCTAssertEqual(bytes.i32(at: at + 17), Int32.min)
    XCTAssertEqual(bytes.i32(at: at + 21), Int32.min)
    XCTAssertEqual(bytes.u16(at: at + 25), 0xFFFE)
    XCTAssertEqual(bytes.u16(at: at + 27), 0xFFFF)
    XCTAssertEqual(bytes.u16(at: at + 29), 0xFFFE)
    XCTAssertEqual(bytes.u16(at: at + 31), 0xFFFF)
    XCTAssertEqual(bytes.u16(at: at + 33), 0xFFFF)
    XCTAssertEqual(bytes.u16(at: at + 35), 0)
    XCTAssertEqual(bytes[at + 37], 1)
  }

  func testHeartRateRecordsEncodeContactAndAnAbsentRRIntervalAsZero() throws {
    try withWriter { writer in
      XCTAssertTrue(writer.append(.heartRate(HeartRateSample(t: 100, bpm: 152, contact: .contact, rrInterval: 402))))
      XCTAssertTrue(writer.append(.heartRate(HeartRateSample(t: 200, bpm: 151, contact: .unsupported, rrInterval: nil))))
      _ = try writer.flush()
    }
    let bytes = try bytes()
    let at = headerLength + 8
    XCTAssertEqual(bytes[at], 4)
    XCTAssertEqual(bytes.u16(at: at + 5), 152)
    XCTAssertEqual(bytes[at + 7], 1)
    XCTAssertEqual(bytes.u16(at: at + 8), 402)
    XCTAssertEqual(bytes[at + 17], 2)
    XCTAssertEqual(bytes.u16(at: at + 18), 0)
  }

  func testSamplesTheStrictReaderWouldRefuseAreDropped() throws {
    try withWriter { writer in
      XCTAssertTrue(writer.append(.fix(fix)))
      XCTAssertFalse(writer.append(fix { $0.t = 999 }))
      XCTAssertTrue(writer.append(.pressure(PressureSample(t: 10, pascals: 100_000))))
      XCTAssertTrue(writer.append(fix { $0.t = 1_000 }))
      XCTAssertFalse(writer.append(fix { $0.t = 2_000; $0.latitudeE7 = 900_000_001 }))
      XCTAssertFalse(writer.append(fix { $0.t = 2_000; $0.longitudeE7 = -1_800_000_001 }))
      XCTAssertTrue(writer.append(fix { $0.t = 2_000; $0.latitudeE7 = -900_000_000; $0.longitudeE7 = 1_800_000_000 }))
      XCTAssertFalse(writer.append(.steps(StepSample(t: -1, count: 3))))
      XCTAssertFalse(writer.append(.steps(StepSample(t: 0x1_0000_0000, count: 3))))
      XCTAssertEqual(try writer.flush()?.samples.count, 4)
      XCTAssertFalse(writer.append(.pressure(PressureSample(t: 9, pascals: 100_000))))
    }
  }

  func testFlushingNothingWritesNothingAndSequencesCountBatches() throws {
    try withWriter { writer in
      XCTAssertNil(try writer.flush())
      XCTAssertEqual(try writer.flush(mark: Mark(t: 0, kind: .start))?.sequence, 0)
      XCTAssertTrue(writer.append(.steps(StepSample(t: 1_000, count: 2))))
      XCTAssertEqual(try writer.flush()?.sequence, 1)
      XCTAssertNil(try writer.flush())
      XCTAssertEqual(writer.nextSequence, 2)
      XCTAssertEqual(writer.pendingBytes, 0)
    }
    XCTAssertEqual(try bytes().count, headerLength + (8 + 6 + 4) + (8 + 9 + 4))
  }

  func testAMarkNeverGoesBackInTime() throws {
    try withWriter { writer in
      _ = try writer.flush(mark: Mark(t: 5_000, kind: .pause))
      XCTAssertEqual(try writer.flush(mark: Mark(t: 4_000, kind: .resume))?.mark, Mark(t: 5_000, kind: .resume))
      XCTAssertEqual(try writer.flush(mark: Mark(t: -3, kind: .lap))?.mark, Mark(t: 5_000, kind: .lap))
    }
  }

  func testCreatingOverAnExistingJournalFails() throws {
    try JournalWriter.create(at: url, header: header).close()
    XCTAssertThrowsError(try JournalWriter.create(at: url, header: header))
  }

  private func writeSession(stop: Bool) throws -> [Int] {
    var ends: [Int] = []
    try withWriter { writer in
      ends.append(try bytes().count)
      _ = try writer.flush(mark: Mark(t: 0, kind: .start))
      ends.append(try bytes().count)
      _ = writer.append(.fix(fix))
      _ = writer.append(.steps(StepSample(t: 1_200, count: 4)))
      _ = try writer.flush()
      ends.append(try bytes().count)
      _ = writer.append(.steps(StepSample(t: 2_200, count: 7)))
      _ = try writer.flush(mark: Mark(t: 2_500, kind: .pause))
      ends.append(try bytes().count)
      if stop {
        _ = try writer.flush(mark: Mark(t: 2_600, kind: .stop))
        ends.append(try bytes().count)
      }
    }
    return ends
  }

  func testResumingCutsEveryTornTailBackToTheLastCompleteBatch() throws {
    let ends = try writeSession(stop: false)
    let complete = try bytes()
    for length in ends[0]...complete.count {
      try write(Array(complete[..<length]))
      let batches = ends.filter { $0 <= length }.count - 1
      let resumed = try JournalWriter.resume(at: url)
      XCTAssertEqual(resumed.writer.nextSequence, batches)
      XCTAssertEqual(resumed.writer.header, header)
      XCTAssertEqual(try bytes().count, ends[batches])
      XCTAssertEqual(resumed.paused, batches >= 3)
      XCTAssertTrue(resumed.writer.append(.steps(StepSample(t: 3_000, count: 9))))
      XCTAssertEqual(try resumed.writer.flush()?.sequence, batches)
      resumed.writer.close()
      XCTAssertEqual(try JournalScanner.scan(try bytes()).nextSequence, batches + 1)
    }
  }

  func testResumingRefusesADamagedHeaderAndAStoppedJournal() throws {
    _ = try writeSession(stop: true)
    XCTAssertThrowsError(try JournalWriter.resume(at: url))
    try write(Array(try bytes()[..<20]))
    XCTAssertThrowsError(try JournalWriter.resume(at: url))
  }

  func testScanningStopsAtABatchWhoseChecksumDoesNotMatch() throws {
    let ends = try writeSession(stop: false)
    var bytes = try bytes()
    bytes[ends[2] + 10] &+= 1
    let tail = try JournalScanner.scan(bytes)
    XCTAssertEqual(tail.validLength, ends[2])
    XCTAssertEqual(tail.nextSequence, 2)
    XCTAssertFalse(tail.paused)
  }

  func testScanningStopsAtABatchTheStrictReaderRefusesDespiteAValidChecksum() throws {
    let ends = try writeSession(stop: false)
    var bytes = try bytes()
    bytes[ends[3] - 5] = 4
    var sink = ByteSink(capacity: bytes.count)
    sink.append(bytes)
    sink.setU32(at: ends[3] - 4, crc(bytes, ends[2], ends[3] - 4))
    let tail = try JournalScanner.scan(sink.bytes)
    XCTAssertEqual(tail.validLength, ends[2])
    XCTAssertEqual(tail.nextSequence, 2)
    XCTAssertFalse(tail.paused)
  }
}
