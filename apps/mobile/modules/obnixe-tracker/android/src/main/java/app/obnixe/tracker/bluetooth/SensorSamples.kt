package app.obnixe.tracker.bluetooth

import app.obnixe.tracker.CadenceSample
import app.obnixe.tracker.HeartRateSample
import app.obnixe.tracker.PowerSample
import app.obnixe.tracker.Sample

/**
 * Turns the notifications of one recording's sources into journal samples (`SPT-007`, `SPT-008`). The crank data of a
 * cadence sensor and of a power meter are followed apart, each needing its previous reading.
 */
class SensorSamples {
  private val sensorCrank = CrankCadence()
  private val powerCrank = CrankCadence()

  /** Null for a value too short for its flags, and for crank cadence data that does not yet give a cadence. */
  fun sampleOf(service: SensorService, t: Long, receivedAtNs: Long, value: ByteArray): Sample? = when (service) {
    SensorService.HEART_RATE -> parseHeartRateMeasurement(value)?.let { HeartRateSample(t, it.bpm, it.contact, it.rrInterval) }
    SensorService.CYCLING_SPEED_CADENCE -> parseCscMeasurement(value)?.let { sensorCrank.push(receivedAtNs, it) }?.let { CadenceSample(t, it) }
    SensorService.RUNNING_SPEED_CADENCE -> parseRscCadence(value)?.let { CadenceSample(t, it) }
    SensorService.CYCLING_POWER -> parseCyclingPowerMeasurement(value)?.let { power ->
      PowerSample(t, power.watts, power.crank?.let { powerCrank.push(receivedAtNs, it) })
    }
  }
}
