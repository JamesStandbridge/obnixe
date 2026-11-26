package app.obnixe.tracker.heartrate

import app.obnixe.tracker.HeartRateContact
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HeartRateMeasurementTest {
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
  fun `values shorter than their flags announce are refused`() {
    assertNull(parseHeartRateMeasurement(bytes()))
    assertNull(parseHeartRateMeasurement(bytes(0x00)))
    assertNull(parseHeartRateMeasurement(bytes(0x01, 0x40)))
  }
}
