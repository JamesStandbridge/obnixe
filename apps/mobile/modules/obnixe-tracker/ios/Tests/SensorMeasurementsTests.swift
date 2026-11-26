import XCTest
@testable import ObnixeTracker

final class SensorMeasurementsTests: XCTestCase {
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

  func testCscCrankDataFollowsTheWheelDataWhenBothArePresent() {
    XCTAssertEqual(CrankRevolutions(cscMeasurement: [0x02, 0x02, 0x01, 0xF0, 0xFF]), CrankRevolutions(revolutions: 0x0102, eventTime: 0xFFF0))
    XCTAssertEqual(CrankRevolutions(cscMeasurement: [0x03, 1, 2, 3, 4, 5, 6, 7, 0, 0x00, 0x04]), CrankRevolutions(revolutions: 7, eventTime: 1024))
    XCTAssertNil(CrankRevolutions(cscMeasurement: [0x01, 1, 2, 3, 4, 5, 6]))
    XCTAssertNil(CrankRevolutions(cscMeasurement: [0x03, 1, 2, 3, 4, 5, 6, 7, 0]))
  }

  func testCyclingPowerSkipsTheOptionalFieldsBeforeTheCrankDataAndReadsANegativePowerAsZero() {
    XCTAssertEqual(CyclingPowerMeasurement([0x00, 0x00, 0xFA, 0x00]), CyclingPowerMeasurement(watts: 250, crank: nil))
    let full: [UInt8] = [0x35, 0x00, 0x2C, 0x01, 50, 0x10, 0x00, 1, 2, 3, 4, 5, 6, 0x0A, 0x00, 0x00, 0x08]
    XCTAssertEqual(CyclingPowerMeasurement(full), CyclingPowerMeasurement(watts: 300, crank: CrankRevolutions(revolutions: 10, eventTime: 2048)))
    XCTAssertEqual(CyclingPowerMeasurement([0x00, 0x00, 0xF6, 0xFF]), CyclingPowerMeasurement(watts: 0, crank: nil))
    XCTAssertNil(CyclingPowerMeasurement([0x20, 0x00, 0xFA, 0x00, 0x0A]))
    XCTAssertNil(CyclingPowerMeasurement([0x00, 0x00, 0xFA]))
  }

  func testRscCadenceIsTheByteAfterTheSpeed() {
    XCTAssertEqual(rscCadence([0x00, 0x80, 0x03, 178]), 178)
    XCTAssertNil(rscCadence([0x00, 0x80, 0x03]))
  }

  func testCrankCadenceWrapsAt16BitsDropsImplausibleValuesAndReadsZeroAfterThreeSecondsWithoutARevolution() {
    let cadence = CrankCadence()
    let second: Int64 = 1_000_000_000
    let time = (64_000 + 2048) & 0xFFFF
    XCTAssertNil(cadence.push(receivedAtNs: 0, CrankRevolutions(revolutions: 65_534, eventTime: 64_000)))
    XCTAssertEqual(cadence.push(receivedAtNs: second, CrankRevolutions(revolutions: 1, eventTime: time)), 90)
    XCTAssertNil(cadence.push(receivedAtNs: 2 * second, CrankRevolutions(revolutions: 1, eventTime: time)))
    XCTAssertEqual(cadence.push(receivedAtNs: 4 * second, CrankRevolutions(revolutions: 1, eventTime: time)), 0)
    XCTAssertNil(cadence.push(receivedAtNs: 5 * second, CrankRevolutions(revolutions: 11, eventTime: (time + 1024) & 0xFFFF)))
  }
}
