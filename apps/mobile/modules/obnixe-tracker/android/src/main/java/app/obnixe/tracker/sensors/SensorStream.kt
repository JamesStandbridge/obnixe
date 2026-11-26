package app.obnixe.tracker.sensors

import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler

/**
 * One hardware sensor delivered on the recording's thread. `SensorEvent.timestamp` is on the `elapsedRealtimeNanos`
 * base, so samples join the fixes' time base; a report latency lets the sensor hub batch events while the CPU sleeps.
 */
class SensorStream(
  private val manager: SensorManager,
  private val sensor: Sensor,
  private val handler: Handler,
  private val onEvent: (SensorEvent) -> Unit,
) : SensorEventListener {
  fun start(): Boolean = manager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL, maxReportLatencyUs, handler)

  fun stop() {
    manager.unregisterListener(this)
  }

  override fun onSensorChanged(event: SensorEvent) {
    onEvent(event)
  }

  override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) = Unit

  private companion object {
    const val maxReportLatencyUs = 5_000_000
  }
}
