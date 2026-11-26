package app.obnixe.tracker.bluetooth

import app.obnixe.tracker.BluetoothSensor
import app.obnixe.tracker.TrackerIssue
import app.obnixe.tracker.TrackerSources
import app.obnixe.tracker.location.LocationSourceKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SensorServiceTest {
  @Test
  fun `each service streams its standard measurement and measures one role`() {
    assertEquals("0000180d-0000-1000-8000-00805f9b34fb", SensorService.HEART_RATE.uuid.toString())
    assertEquals("00001816-0000-1000-8000-00805f9b34fb", SensorService.CYCLING_SPEED_CADENCE.uuid.toString())
    assertEquals("00001818-0000-1000-8000-00805f9b34fb", SensorService.CYCLING_POWER.uuid.toString())
    assertEquals("00001814-0000-1000-8000-00805f9b34fb", SensorService.RUNNING_SPEED_CADENCE.uuid.toString())
    assertEquals(
      listOf("00002a37", "00002a5b", "00002a63", "00002a53"),
      SensorService.entries.map { it.measurement.toString().substring(0, 8) },
    )
    assertEquals("00002902-0000-1000-8000-00805f9b34fb", SensorGatt.clientConfiguration.toString())
    assertEquals(
      listOf(SensorRole.HEART_RATE, SensorRole.CADENCE, SensorRole.POWER, SensorRole.CADENCE),
      SensorService.entries.map { it.role },
    )
    assertEquals(listOf(TrackerIssue.HEART_RATE_LOST, TrackerIssue.CADENCE_LOST, TrackerIssue.POWER_LOST), SensorRole.entries.map { it.issue })
  }

  @Test
  fun `services read back from the wire values of the bridge`() {
    for (service in SensorService.entries) assertEquals(service, SensorService.of(service.value))
    assertEquals(listOf("heart_rate", "cycling_speed_cadence", "cycling_power", "running_speed_cadence"), SensorService.entries.map { it.value })
    assertNull(SensorService.of("speed"))
  }

  @Test
  fun `a selection takes valid addresses and one source per role, a device serving two roles included`() {
    val stryd = "D0:5F:11:22:33:44"
    assertTrue(BluetoothSensor.isValidSelection(emptyList()))
    assertTrue(
      BluetoothSensor.isValidSelection(
        listOf(BluetoothSensor(SensorService.HEART_RATE, "C4:7D:2A:10:9E:01"), BluetoothSensor(SensorService.RUNNING_SPEED_CADENCE, stryd), BluetoothSensor(SensorService.CYCLING_POWER, stryd)),
      ),
    )
    assertFalse(BluetoothSensor.isValidSelection(listOf(BluetoothSensor(SensorService.CYCLING_SPEED_CADENCE, stryd), BluetoothSensor(SensorService.RUNNING_SPEED_CADENCE, "D0:5F:11:22:33:45"))))
    assertFalse(BluetoothSensor.isValidSelection(listOf(BluetoothSensor(SensorService.HEART_RATE, "c4:7d:2a:10:9e:01"))))
    assertFalse(BluetoothSensor.isValidSelection(listOf(BluetoothSensor(SensorService.HEART_RATE, "C4:7D:2A:10:9E"))))
    assertFalse(BluetoothSensor.isValidSelection(listOf(BluetoothSensor(SensorService.HEART_RATE, "1F2E8A4C-0000-4000-8000-00805F9B34FB"))))
  }

  @Test
  fun `the started sources tell each connected role`() {
    val sources = TrackerSources(LocationSourceKind.FUSED, barometer = true, pedometer = false, bluetooth = setOf(SensorRole.POWER, SensorRole.CADENCE))
    assertEquals(
      mapOf("location" to "fused", "barometer" to true, "pedometer" to false, "heartRate" to false, "cadence" to true, "power" to true),
      sources.toBridge(),
    )
  }
}
