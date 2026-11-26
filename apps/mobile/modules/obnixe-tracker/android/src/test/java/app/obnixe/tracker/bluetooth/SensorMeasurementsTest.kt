package app.obnixe.tracker.bluetooth

import app.obnixe.tracker.HeartRateContact
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SensorMeasurementsTest {
  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

  @Test
  fun `an 8 bit value without contact support`() {
    assertEquals(HeartRateMeasurement(72, HeartRateContact.UNSUPPORTED, null), parseHeartRateMeasurement(bytes(0x00, 72)))
  }

  @Test
  fun `a 16 bit value with contact detected`() {
    assertEquals(HeartRateMeasurement(301, HeartRateContact.CONTACT, null), parseHeartRateMeasurement(bytes(0x07, 0x2D, 0x01)))
  }

  @Test
  fun `contact supported but not detected`() {
    assertEquals(HeartRateContact.ABSENT, parseHeartRateMeasurement(bytes(0x04, 60))?.contact)
  }

  @Test
  fun `energy expended is skipped and the last RR interval is kept`() {
    val value = bytes(0x1E, 150, 0x10, 0x00, 0x90, 0x01, 0xA0, 0x01)
    assertEquals(HeartRateMeasurement(150, HeartRateContact.CONTACT, 416), parseHeartRateMeasurement(value))
  }

  @Test
  fun `a zero RR interval counts as absent`() {
    assertEquals(HeartRateMeasurement(90, HeartRateContact.UNSUPPORTED, null), parseHeartRateMeasurement(bytes(0x10, 90, 0x00, 0x00)))
  }

  @Test
  fun `heart rate values shorter than their flags announce are refused`() {
    assertNull(parseHeartRateMeasurement(bytes()))
    assertNull(parseHeartRateMeasurement(bytes(0x00)))
    assertNull(parseHeartRateMeasurement(bytes(0x01, 0x40)))
  }

  @Test
  fun `CSC crank data follows the wheel data when both are present`() {
    assertEquals(CrankRevolutions(0x0102, 0xFFF0), parseCscMeasurement(bytes(0x02, 0x02, 0x01, 0xF0, 0xFF)))
    assertEquals(CrankRevolutions(7, 1024), parseCscMeasurement(bytes(0x03, 1, 2, 3, 4, 5, 6, 7, 0, 0x00, 0x04)))
    assertNull(parseCscMeasurement(bytes(0x01, 1, 2, 3, 4, 5, 6)))
    assertNull(parseCscMeasurement(bytes(0x03, 1, 2, 3, 4, 5, 6, 7, 0)))
  }

  @Test
  fun `cycling power skips the optional fields before the crank data and reads a negative power as zero`() {
    assertEquals(CyclingPowerMeasurement(250, null), parseCyclingPowerMeasurement(bytes(0x00, 0x00, 0xFA, 0x00)))
    val full = bytes(0x35, 0x00, 0x2C, 0x01, 50, 0x10, 0x00, 1, 2, 3, 4, 5, 6, 0x0A, 0x00, 0x00, 0x08)
    assertEquals(CyclingPowerMeasurement(300, CrankRevolutions(10, 2048)), parseCyclingPowerMeasurement(full))
    assertEquals(CyclingPowerMeasurement(0, null), parseCyclingPowerMeasurement(bytes(0x00, 0x00, 0xF6, 0xFF)))
    assertNull(parseCyclingPowerMeasurement(bytes(0x20, 0x00, 0xFA, 0x00, 0x0A)))
    assertNull(parseCyclingPowerMeasurement(bytes(0x00, 0x00, 0xFA)))
  }

  @Test
  fun `RSC cadence is the byte after the speed`() {
    assertEquals(178, parseRscCadence(bytes(0x00, 0x80, 0x03, 178)))
    assertNull(parseRscCadence(bytes(0x00, 0x80, 0x03)))
  }

  @Test
  fun `crank cadence wraps at 16 bits, drops implausible values and reads zero after three seconds without a revolution`() {
    val cadence = CrankCadence()
    val second = 1_000_000_000L
    assertNull(cadence.push(0, CrankRevolutions(65_534, 64_000)))
    assertEquals(90, cadence.push(second, CrankRevolutions(1, (64_000 + 2048) and 0xFFFF)))
    assertNull(cadence.push(2 * second, CrankRevolutions(1, (64_000 + 2048) and 0xFFFF)))
    assertEquals(0, cadence.push(4 * second, CrankRevolutions(1, (64_000 + 2048) and 0xFFFF)))
    assertNull(cadence.push(5 * second, CrankRevolutions(11, (64_000 + 2048 + 1024) and 0xFFFF)))
  }
}
