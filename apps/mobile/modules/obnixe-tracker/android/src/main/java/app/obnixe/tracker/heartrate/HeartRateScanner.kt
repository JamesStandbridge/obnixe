package app.obnixe.tracker.heartrate

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.ParcelUuid

data class HeartRateDevice(val id: String, val name: String, val rssi: Int) {
  fun toBridge(): Map<String, Any> = mapOf("id" to id, "name" to name, "rssi" to rssi)
}

class BluetoothUnavailableException : IllegalStateException("Bluetooth is off or missing")

/**
 * Scans for advertisers of the Heart Rate service, such as a Garmin watch broadcasting its heart rate. Each sighting is
 * reported, so the RSSI stays current. Callers hold `BLUETOOTH_SCAN` (Android 12+) or the fine location permission.
 */
@SuppressLint("MissingPermission")
class HeartRateScanner(private val context: Context, private val handler: Handler, private val onDevice: (HeartRateDevice) -> Unit) {
  private var callback: ScanCallback? = null
  private var onEnd: (() -> Unit)? = null
  private val timeout = Runnable { stop() }

  fun start(timeoutMs: Long, onEnd: () -> Unit) {
    stop()
    val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner ?: throw BluetoothUnavailableException()
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        val name = result.scanRecord?.deviceName ?: ""
        handler.post { onDevice(HeartRateDevice(result.device.address, name, result.rssi)) }
      }

      override fun onScanFailed(errorCode: Int) {
        handler.post { stop() }
      }
    }
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(HeartRateGatt.service)).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
    scanner.startScan(listOf(filter), settings, callback)
    this.callback = callback
    this.onEnd = onEnd
    handler.postDelayed(timeout, timeoutMs)
  }

  fun stop() {
    handler.removeCallbacks(timeout)
    val callback = callback ?: return
    this.callback = null
    context.getSystemService(BluetoothManager::class.java)?.adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner?.stopScan(callback)
    onEnd?.invoke()
    onEnd = null
  }
}
