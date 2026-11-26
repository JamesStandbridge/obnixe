package app.obnixe.tracker.heartrate

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattConnectionSettings
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.SystemClock

/**
 * Keeps a GATT link to one Heart Rate source and streams its measurements (`SPT-007`). After a loss it retries direct
 * connections, which reconnect within seconds once the source is back, then falls back to the controller's
 * low-duty background connection after [directRetryWindowNs] so a source that stays away costs little battery.
 * Callers hold `BLUETOOTH_CONNECT` (Android 12+); every callback runs on [handler]'s thread.
 */
@SuppressLint("MissingPermission")
class HeartRateLink(private val context: Context, private val address: String, private val handler: Handler, private val listener: Listener) {
  interface Listener {
    /** [elapsedRealtimeNanos] is the instant the notification reached the phone. */
    fun onMeasurement(elapsedRealtimeNanos: Long, measurement: HeartRateMeasurement)

    fun onLost()
  }

  private enum class State { CONNECTING, STREAMING, LOST }

  private var gatt: BluetoothGatt? = null
  private var state = State.CONNECTING
  private var lostAtNs = 0L
  private var stopped = false
  private val reconnect = Runnable { connect() }

  fun start() {
    connect()
  }

  fun stop() {
    stopped = true
    handler.removeCallbacks(reconnect)
    gatt?.close()
    gatt = null
  }

  private fun connect() {
    if (stopped) return
    val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    if (adapter == null || !adapter.isEnabled) {
      onFailure()
      return
    }
    val background = state == State.LOST && SystemClock.elapsedRealtimeNanos() - lostAtNs > directRetryWindowNs
    val device = adapter.getRemoteDevice(address)
    gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.CINNAMON_BUN) {
      val settings = BluetoothGattConnectionSettings.Builder().setAutoConnectEnabled(background).setTransport(BluetoothDevice.TRANSPORT_LE).build()
      device.connectGatt(settings, handler::post, callback)
    } else {
      @Suppress("DEPRECATION")
      device.connectGatt(context, background, callback, BluetoothDevice.TRANSPORT_LE)
    }
  }

  private fun onFailure() {
    gatt?.close()
    gatt = null
    if (state != State.LOST) {
      state = State.LOST
      lostAtNs = SystemClock.elapsedRealtimeNanos()
      listener.onLost()
    }
    if (!stopped) handler.postDelayed(reconnect, retryDelayMs)
  }

  private fun enableNotifications(gatt: BluetoothGatt) {
    val characteristic = gatt.getService(HeartRateGatt.service)?.getCharacteristic(HeartRateGatt.measurement)
    val descriptor = characteristic?.getDescriptor(HeartRateGatt.clientConfiguration)
    if (descriptor == null || !gatt.setCharacteristicNotification(characteristic, true)) {
      gatt.disconnect()
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
    } else {
      @Suppress("DEPRECATION")
      descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
      @Suppress("DEPRECATION")
      gatt.writeDescriptor(descriptor)
    }
  }

  private fun onValue(value: ByteArray) {
    val receivedAt = SystemClock.elapsedRealtimeNanos()
    val measurement = parseHeartRateMeasurement(value) ?: return
    handler.post { if (!stopped) listener.onMeasurement(receivedAt, measurement) }
  }

  private val callback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      handler.post {
        if (stopped || gatt !== this@HeartRateLink.gatt) return@post
        if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
          gatt.discoverServices()
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
          onFailure()
        }
      }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      handler.post {
        if (stopped || gatt !== this@HeartRateLink.gatt) return@post
        if (status == BluetoothGatt.GATT_SUCCESS) enableNotifications(gatt) else gatt.disconnect()
      }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      handler.post {
        if (stopped || gatt !== this@HeartRateLink.gatt) return@post
        if (status == BluetoothGatt.GATT_SUCCESS) state = State.STREAMING else gatt.disconnect()
      }
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      if (characteristic.uuid == HeartRateGatt.measurement) onValue(value)
    }

    @Deprecated("Called instead of the value overload before Android 13")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      @Suppress("DEPRECATION")
      if (characteristic.uuid == HeartRateGatt.measurement) onValue(characteristic.value ?: return)
    }
  }

  private companion object {
    const val retryDelayMs = 2_000L
    const val directRetryWindowNs = 60_000_000_000L
  }
}
