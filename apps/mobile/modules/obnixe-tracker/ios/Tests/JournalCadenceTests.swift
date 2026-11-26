import Foundation
import XCTest
@testable import ObnixeTracker

final class JournalCadenceTests: XCTestCase {
  private var directory: URL!

  private let header = JournalHeader(
    sessionId: "3f2b8c1e-7a4d-4e9b-9c21-5d6e7f809a1b",
    startedAt: 1_795_000_000_123,
    monotonicOriginNs: 98_765_432_101_234,
    platform: JournalFormat.platformIOS,
    device: "Apple iPhone17,1"
  )

  private func fix(_ t: Int64) -> Sample {
    .fix(Fix(t: t, fixAgeMs: 250, latitudeE7: 458_326_000 + Int32(t / 1_000), longitudeE7: -68_652_000, altitudeEllipsoidMm: 1_042_300, altitudeMslMm: 1_090_100, horizontalAccuracyDm: 38, verticalAccuracyDm: 52, speedCmS: 312, speedAccuracyCmS: 40, bearingCentiDeg: 27_050, bearingAccuracyCentiDeg: 1_200, simulated: false))
  }

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try FileManager.default.removeItem(at: directory)
  }

  func testWaitsForTheWriteIntervalAndRestartsItOnEveryWrite() {
    var cadence = JournalCadence(writeIntervalMs: 5_000, startedAtMs: 0)
    XCTAssertFalse(cadence.writeDue(nowMs: 4_999))
    XCTAssertTrue(cadence.writeDue(nowMs: 5_000))
    XCTAssertEqual(cadence.nextTickDelayMs(nowMs: 4_500, deliveryIntervalMs: 1_000), 500)
    XCTAssertEqual(cadence.nextTickDelayMs(nowMs: 0, deliveryIntervalMs: 5_000), 5_000)
    cadence.wrote(nowMs: 4_200)
    XCTAssertFalse(cadence.writeDue(nowMs: 9_000))
    XCTAssertEqual(cadence.nextTickDelayMs(nowMs: 9_700, deliveryIntervalMs: 1_000), 0)
  }

  func testAnHourInTheForegroundDeliversEverySecondAndWritesAtMost720Batches() throws {
    let writer = try JournalWriter.create(at: directory.appendingPathComponent("session.ojr"), header: header)
    defer { writer.close() }
    var cadence = JournalCadence(writeIntervalMs: 5_000, startedAtMs: 0)
    var delivered: [Sample] = []
    var written: [Sample] = []
    var batches = 0
    var maxDeliveryWaitMs: Int64 = 0
    var maxWriteWaitMs: Int64 = 0
    var nextSampleAt: Int64 = 0
    var nextTickAt = cadence.nextTickDelayMs(nowMs: 0, deliveryIntervalMs: 1_000)
    var now: Int64 = 0
    while now < 3_600_000 {
      now = min(nextSampleAt, nextTickAt)
      if now == nextSampleAt {
        for sample in [fix(now), .pressure(PressureSample(t: now, pascals: 101_325)), .heartRate(HeartRateSample(t: now, bpm: 150, contact: .contact, rrInterval: nil))] {
          XCTAssertTrue(writer.append(sample))
        }
        nextSampleAt += 1_000 + (now / 1_000 % 3) * 100
      }
      if now == nextTickAt {
        var part: SamplePart?
        if cadence.writeDue(nowMs: now) {
          let batch = try writer.flush()
          cadence.wrote(nowMs: now)
          if let batch {
            batches += 1
            written += batch.samples
            maxWriteWaitMs = max(maxWriteWaitMs, batch.samples.map { now - $0.t }.max() ?? 0)
            part = batch.lastPart
          }
        } else {
          part = writer.takePart()
        }
        for sample in part?.samples ?? [] {
          delivered.append(sample)
          maxDeliveryWaitMs = max(maxDeliveryWaitMs, now - sample.t)
        }
        nextTickAt = now + cadence.nextTickDelayMs(nowMs: now, deliveryIntervalMs: 1_000)
      }
    }
    XCTAssertLessThanOrEqual(batches, 720)
    XCTAssertGreaterThanOrEqual(batches, 700)
    XCTAssertLessThanOrEqual(maxDeliveryWaitMs, 1_000)
    XCTAssertLessThanOrEqual(maxWriteWaitMs, 5_000)
    XCTAssertEqual(delivered, written)
  }

  func testPartsOfABatchFollowEachOtherAndTheLastOneCarriesTheRest() throws {
    let writer = try JournalWriter.create(at: directory.appendingPathComponent("session.ojr"), header: header)
    defer { writer.close() }
    XCTAssertNil(writer.takePart())
    XCTAssertTrue(writer.append(fix(1_000)))
    XCTAssertTrue(writer.append(fix(2_000)))
    XCTAssertEqual(writer.takePart(), SamplePart(sequence: 0, offset: 0, samples: [fix(1_000), fix(2_000)], end: false))
    XCTAssertNil(writer.takePart())
    XCTAssertTrue(writer.append(fix(3_000)))
    let batch = try XCTUnwrap(try writer.flush(mark: Mark(t: 3_100, kind: .pause)))
    XCTAssertEqual(batch.delivered, 2)
    XCTAssertEqual(batch.lastPart, SamplePart(sequence: 0, offset: 2, samples: [fix(3_000)], end: true))
    XCTAssertTrue(writer.append(fix(4_000)))
    XCTAssertEqual(writer.takePart(), SamplePart(sequence: 1, offset: 0, samples: [fix(4_000)], end: false))
  }
}
