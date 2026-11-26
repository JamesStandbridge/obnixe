package app.obnixe.tracker.heartrate

import app.obnixe.tracker.HeartRateContact
import java.util.UUID

object HeartRateGatt {
  val service: UUID = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
  val measurement: UUID = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")
  val clientConfiguration: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
}

data class HeartRateMeasurement(val bpm: Int, val contact: HeartRateContact, /** Last RR interval in 1/1024 s. */ val rrInterval: Int?)

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

private fun uint16(value: ByteArray, offset: Int): Int = (value[offset].toInt() and 0xFF) or ((value[offset + 1].toInt() and 0xFF) shl 8)
