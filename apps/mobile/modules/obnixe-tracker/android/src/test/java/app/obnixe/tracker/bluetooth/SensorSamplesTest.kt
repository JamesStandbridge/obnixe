package app.obnixe.tracker.bluetooth

import app.obnixe.tracker.CadenceSample
import app.obnixe.tracker.HeartRateContact
import app.obnixe.tracker.HeartRateSample
import app.obnixe.tracker.PowerSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SensorSamplesTest {
  private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

  private val second = 1_000_000_000L

  private fun csc(revolutions: Int, eventTime: Int) = bytes(0x02, revolutions and 0xFF, revolutions shr 8, eventTime and 0xFF, eventTime shr 8)

  private fun power(watts: Int, revolutions: Int, eventTime: Int) =
    bytes(0x20, 0x00, watts and 0xFF, watts shr 8, revolutions and 0xFF, revolutions shr 8, eventTime and 0xFF, eventTime shr 8)

  @Test
  fun `heart rate and footpod notifications become samples at the given instant`() {
    val samples = SensorSamples()
    assertEquals(HeartRateSample(1_200, 152, HeartRateContact.CONTACT, null), samples.sampleOf(SensorService.HEART_RATE, 1_200, 0, bytes(0x06, 152)))
    assertEquals(CadenceSample(1_300, 178), samples.sampleOf(SensorService.RUNNING_SPEED_CADENCE, 1_300, 0, bytes(0x00, 0x80, 0x03, 178)))
    assertNull(samples.sampleOf(SensorService.HEART_RATE, 1_400, 0, bytes(0x01, 0x40)))
    assertNull(samples.sampleOf(SensorService.RUNNING_SPEED_CADENCE, 1_500, 0, bytes(0x00, 0x80)))
  }

  @Test
  fun `a crank sensor gives its cadence from the second revolution reading`() {
    val samples = SensorSamples()
    assertNull(samples.sampleOf(SensorService.CYCLING_SPEED_CADENCE, 0, 0, csc(100, 1024)))
    assertEquals(CadenceSample(1_000, 90), samples.sampleOf(SensorService.CYCLING_SPEED_CADENCE, 1_000, second, csc(103, 3072)))
    assertNull(samples.sampleOf(SensorService.CYCLING_SPEED_CADENCE, 1_100, second, bytes(0x01, 1, 2, 3, 4, 5, 6)))
  }

  @Test
  fun `a power meter keeps its watts without crank data and follows its crank apart from the cadence sensor`() {
    val samples = SensorSamples()
    assertEquals(PowerSample(500, 250, null), samples.sampleOf(SensorService.CYCLING_POWER, 500, 0, bytes(0x00, 0x00, 0xFA, 0x00)))
    assertNull(samples.sampleOf(SensorService.CYCLING_SPEED_CADENCE, 600, 0, csc(10, 1024)))
    assertEquals(PowerSample(700, 240, null), samples.sampleOf(SensorService.CYCLING_POWER, 700, 0, power(240, 500, 2048)))
    assertEquals(PowerSample(1_700, 260, 60), samples.sampleOf(SensorService.CYCLING_POWER, 1_700, second, power(260, 501, 3072)))
    assertEquals(CadenceSample(1_800, 90), samples.sampleOf(SensorService.CYCLING_SPEED_CADENCE, 1_800, second, csc(13, 3072)))
    assertNull(samples.sampleOf(SensorService.CYCLING_POWER, 1_900, second, bytes(0x00, 0x00, 0xFA)))
  }
}
