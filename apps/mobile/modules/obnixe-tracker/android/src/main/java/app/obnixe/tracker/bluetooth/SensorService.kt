package app.obnixe.tracker.bluetooth

import app.obnixe.tracker.TrackerIssue
import expo.modules.kotlin.types.Enumerable
import java.util.Locale
import java.util.UUID

/** What a paired source measures; its loss is reported once per role (`SPT-007`, `SPT-008`). */
enum class SensorRole(val issue: TrackerIssue) {
  HEART_RATE(TrackerIssue.HEART_RATE_LOST),
  CADENCE(TrackerIssue.CADENCE_LOST),
  POWER(TrackerIssue.POWER_LOST),
}

/** The GATT services of the Bluetooth sources, each streaming one measurement characteristic. */
enum class SensorService(val value: String) : Enumerable {
  HEART_RATE("heart_rate"),
  CYCLING_SPEED_CADENCE("cycling_speed_cadence"),
  CYCLING_POWER("cycling_power"),
  RUNNING_SPEED_CADENCE("running_speed_cadence");

  val uuid: UUID
    get() = when (this) {
      HEART_RATE -> SensorGatt.uuid(0x180D)
      CYCLING_SPEED_CADENCE -> SensorGatt.uuid(0x1816)
      CYCLING_POWER -> SensorGatt.uuid(0x1818)
      RUNNING_SPEED_CADENCE -> SensorGatt.uuid(0x1814)
    }

  val measurement: UUID
    get() = when (this) {
      HEART_RATE -> SensorGatt.uuid(0x2A37)
      CYCLING_SPEED_CADENCE -> SensorGatt.uuid(0x2A5B)
      CYCLING_POWER -> SensorGatt.uuid(0x2A63)
      RUNNING_SPEED_CADENCE -> SensorGatt.uuid(0x2A53)
    }

  val role: SensorRole
    get() = when (this) {
      HEART_RATE -> SensorRole.HEART_RATE
      CYCLING_SPEED_CADENCE, RUNNING_SPEED_CADENCE -> SensorRole.CADENCE
      CYCLING_POWER -> SensorRole.POWER
    }

  companion object {
    fun of(value: String): SensorService? = entries.firstOrNull { it.value == value }
  }
}

object SensorGatt {
  val clientConfiguration: UUID = uuid(0x2902)

  fun uuid(short: Int): UUID = UUID.fromString("0000%04x-0000-1000-8000-00805f9b34fb".format(Locale.ROOT, short))
}
