package app.obnixe.tracker

import app.obnixe.tracker.journal.RecordType

/**
 * Journal records in the integer units of annex C; `t` is in milliseconds since the recording's time origin on the
 * monotonic time base (`GPS-012`). Mirrors `Sample` and `TrackerMark` of `packages/core/src/tracking/types.ts`.
 */
sealed interface JournalRecord {
  val t: Long
  val recordType: RecordType
}

sealed interface Sample : JournalRecord {
  fun toBridge(): Map<String, Any?>
}

data class Fix(
  override val t: Long,
  /** `t` minus the GNSS timestamp of the fix, both on the recording's time axis. */
  val fixAgeMs: Int,
  val latitudeE7: Int,
  val longitudeE7: Int,
  val altitudeEllipsoidMm: Int?,
  val altitudeMslMm: Int?,
  val horizontalAccuracyDm: Int?,
  val verticalAccuracyDm: Int?,
  val speedCmS: Int?,
  val speedAccuracyCmS: Int?,
  val bearingCentiDeg: Int?,
  val bearingAccuracyCentiDeg: Int?,
  val simulated: Boolean,
) : Sample {
  override val recordType get() = RecordType.FIX

  override fun toBridge(): Map<String, Any?> = mapOf(
    "type" to "fix",
    "t" to t.toDouble(),
    "fixAgeMs" to fixAgeMs,
    "latitudeE7" to latitudeE7,
    "longitudeE7" to longitudeE7,
    "altitudeEllipsoidMm" to altitudeEllipsoidMm,
    "altitudeMslMm" to altitudeMslMm,
    "horizontalAccuracyDm" to horizontalAccuracyDm,
    "verticalAccuracyDm" to verticalAccuracyDm,
    "speedCmS" to speedCmS,
    "speedAccuracyCmS" to speedAccuracyCmS,
    "bearingCentiDeg" to bearingCentiDeg,
    "bearingAccuracyCentiDeg" to bearingAccuracyCentiDeg,
    "simulated" to simulated,
  )
}

data class PressureSample(override val t: Long, val pascals: Long) : Sample {
  override val recordType get() = RecordType.PRESSURE

  override fun toBridge(): Map<String, Any?> = mapOf("type" to "pressure", "t" to t.toDouble(), "pascals" to pascals.toDouble())
}

data class StepSample(override val t: Long, /** Steps counted since the start of the recording. */ val count: Long) : Sample {
  override val recordType get() = RecordType.STEPS

  override fun toBridge(): Map<String, Any?> = mapOf("type" to "steps", "t" to t.toDouble(), "count" to count.toDouble())
}

enum class HeartRateContact(val code: Int, val wire: String) {
  ABSENT(0, "absent"),
  CONTACT(1, "contact"),
  UNSUPPORTED(2, "unsupported"),
}

data class HeartRateSample(
  override val t: Long,
  val bpm: Int,
  val contact: HeartRateContact,
  /** Last RR interval in 1/1024 s. */
  val rrInterval: Int?,
) : Sample {
  override val recordType get() = RecordType.HEART_RATE

  override fun toBridge(): Map<String, Any?> =
    mapOf("type" to "heart_rate", "t" to t.toDouble(), "bpm" to bpm, "contact" to contact.wire, "rrInterval" to rrInterval)
}

data class CadenceSample(override val t: Long, /** Pedal revolutions or steps per minute, as the sport's cadence. */ val perMinute: Int) : Sample {
  override val recordType get() = RecordType.CADENCE

  override fun toBridge(): Map<String, Any?> = mapOf("type" to "cadence", "t" to t.toDouble(), "perMinute" to perMinute)
}

data class PowerSample(override val t: Long, val watts: Int, /** Crank revolutions per minute from the power meter. */ val cadence: Int?) : Sample {
  override val recordType get() = RecordType.POWER

  override fun toBridge(): Map<String, Any?> = mapOf("type" to "power", "t" to t.toDouble(), "watts" to watts, "cadence" to cadence)
}

/** `EXTEND` adds a minute to the current time step of a guided workout. */
enum class MarkKind(val code: Int, val wire: String) {
  START(0, "start"),
  PAUSE(1, "pause"),
  RESUME(2, "resume"),
  LAP(3, "lap"),
  EXTEND(4, "extend"),
  STOP(5, "stop"),
}

data class Mark(override val t: Long, val kind: MarkKind) : JournalRecord {
  override val recordType get() = RecordType.MARK
}
