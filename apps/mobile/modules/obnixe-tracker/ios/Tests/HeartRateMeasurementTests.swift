import XCTest
@testable import ObnixeTracker

final class HeartRateMeasurementTests: XCTestCase {
  private func assertMeasurement(_ value: [UInt8], _ bpm: Int, _ contact: HeartRateContact, _ rrInterval: Int?, line: UInt = #line) {
    let measurement = HeartRateMeasurement(value)
    XCTAssertEqual(measurement?.bpm, bpm, line: line)
    XCTAssertEqual(measurement?.contact, contact, line: line)
    XCTAssertEqual(measurement?.rrInterval, rrInterval, line: line)
  }

  func testAnEightBitValueWithoutContactSupport() {
    assertMeasurement([0x00, 72], 72, .unsupported, nil)
  }

  func testASixteenBitValueWithContactDetected() {
    assertMeasurement([0x07, 0x2D, 0x01], 301, .contact, nil)
  }

  func testContactSupportedButNotDetected() {
    XCTAssertEqual(HeartRateMeasurement([0x04, 60])?.contact, .absent)
  }

  func testEnergyExpendedIsSkippedAndTheLastRRIntervalIsKept() {
    assertMeasurement([0x1E, 150, 0x10, 0x00, 0x90, 0x01, 0xA0, 0x01], 150, .contact, 416)
  }

  func testAZeroRRIntervalCountsAsAbsent() {
    assertMeasurement([0x10, 90, 0x00, 0x00], 90, .unsupported, nil)
  }

  func testValuesShorterThanTheirFlagsAnnounceAreRefused() {
    XCTAssertNil(HeartRateMeasurement([]))
    XCTAssertNil(HeartRateMeasurement([0x00]))
    XCTAssertNil(HeartRateMeasurement([0x01, 0x40]))
  }
}
