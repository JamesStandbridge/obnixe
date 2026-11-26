package app.obnixe.tracker.bluetooth

import app.obnixe.tracker.HeartRateContact

data class HeartRateMeasurement(val bpm: Int, val contact: HeartRateContact, /** Last RR interval in 1/1024 s. */ val rrInterval: Int?)

/** Cumulative crank revolutions and the time of the last one in 1/1024 s, both wrapping at 16 bits. */
data class CrankRevolutions(val revolutions: Int, val eventTime: Int)

data class CyclingPowerMeasurement(val watts: Int, val crank: CrankRevolutions?)

/** Parses a Heart Rate Measurement characteristic value (`0x2A37`); null when it is too short for its own flags. */
fun parseHeartRateMeasurement(value: ByteArray): HeartRateMeasurement? {
  if (value.isEmpty()) return null
  val flags = value[0].toInt() and 0xFF
  val wide = flags and 0x01 != 0
  var offset = 1
  if (value.size < offset + if (wide) 2 else 1) return null
  val bpm = if (wide) uint16(value, offset) else value[offset].toInt() and 0xFF
  offset += if (wide) 2 else 1
  val contact = when {
    flags and 0x04 == 0 -> HeartRateContact.UNSUPPORTED
    flags and 0x02 != 0 -> HeartRateContact.CONTACT
    else -> HeartRateContact.ABSENT
  }
  if (flags and 0x08 != 0) offset += 2
  var rrInterval: Int? = null
  if (flags and 0x10 != 0) {
    while (offset + 2 <= value.size) {
      rrInterval = uint16(value, offset)
      offset += 2
    }
  }
  return HeartRateMeasurement(bpm, contact, rrInterval?.takeIf { it > 0 })
}

/** Crank data of a CSC Measurement (`0x2A5B`); null without it or when the value is too short for its flags. */
fun parseCscMeasurement(value: ByteArray): CrankRevolutions? {
  if (value.isEmpty()) return null
  val flags = value[0].toInt() and 0xFF
  val offset = 1 + if (flags and 0x01 != 0) 6 else 0
  if (flags and 0x02 == 0 || value.size < offset + 4) return null
  return CrankRevolutions(uint16(value, offset), uint16(value, offset + 2))
}

/** Parses a Cycling Power Measurement (`0x2A63`); a negative power reads as 0 W. Null when too short for its flags. */
fun parseCyclingPowerMeasurement(value: ByteArray): CyclingPowerMeasurement? {
  if (value.size < 4) return null
  val flags = uint16(value, 0)
  val watts = (value[2].toInt() and 0xFF) or (value[3].toInt() shl 8)
  var offset = 4
  if (flags and 0x01 != 0) offset += 1
  if (flags and 0x04 != 0) offset += 2
  if (flags and 0x10 != 0) offset += 6
  val crank = if (flags and 0x20 != 0) {
    if (value.size < offset + 4) return null
    CrankRevolutions(uint16(value, offset), uint16(value, offset + 2))
  } else {
    null
  }
  return CyclingPowerMeasurement(watts.coerceAtLeast(0), crank)
}

/** Instantaneous cadence of an RSC Measurement (`0x2A53`) in steps per minute; null when too short. */
fun parseRscCadence(value: ByteArray): Int? = if (value.size < 4) null else value[3].toInt() and 0xFF

/**
 * Turns successive crank revolution data into revolutions per minute. A notification without a new revolution reads
 * 0 rpm once [stoppedAfterNs] passed since the last one, and a first reading or an implausible cadence reads null.
 */
class CrankCadence {
  private var last: CrankRevolutions? = null
  private var lastEventNs = 0L

  fun push(receivedAtNs: Long, crank: CrankRevolutions): Int? {
    val previous = last
    if (previous == null) {
      last = crank
      lastEventNs = receivedAtNs
      return null
    }
    val revolutions = (crank.revolutions - previous.revolutions) and 0xFFFF
    val ticks = (crank.eventTime - previous.eventTime) and 0xFFFF
    if (revolutions == 0 || ticks == 0) return if (receivedAtNs - lastEventNs >= stoppedAfterNs) 0 else null
    last = crank
    lastEventNs = receivedAtNs
    val rpm = Math.round(revolutions * 60.0 * 1024.0 / ticks).toInt()
    return rpm.takeIf { it <= maxRpm }
  }

  private companion object {
    const val stoppedAfterNs = 3_000_000_000L
    const val maxRpm = 250
  }
}

private fun uint16(value: ByteArray, offset: Int): Int = (value[offset].toInt() and 0xFF) or ((value[offset + 1].toInt() and 0xFF) shl 8)
