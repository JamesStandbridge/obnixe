package app.obnixe.tracker

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service of type `location`, plus `connectedDevice` while a Bluetooth source is used, that keeps the
 * recording alive in the background. Started while the app is visible; restarted by the system after its process is
 * killed (`START_STICKY`), in which case it resumes the kept recording. Notification actions reach it directly.
 */
class TrackerService : Service() {
  companion object {
    const val actionPause = "app.obnixe.tracker.PAUSE"
    const val actionResume = "app.obnixe.tracker.RESUME"
    const val actionLap = "app.obnixe.tracker.LAP"

    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, TrackerService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, TrackerService::class.java))
    }
  }

  private val screenReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      TrackerHub.setScreenInteractive(intent.action == Intent.ACTION_SCREEN_ON)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
    }
    ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      actionPause -> TrackerHub.mark(MarkKind.PAUSE)
      actionResume -> TrackerHub.mark(MarkKind.RESUME)
      actionLap -> TrackerHub.mark(MarkKind.LAP)
    }
    val state = TrackerHub.notificationState(this)
    if (state == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      ServiceCompat.startForeground(this, TrackerNotifications.notificationId, TrackerNotifications.build(this, state), foregroundTypes())
    } catch (error: SecurityException) {
      return abandon()
    } catch (error: IllegalStateException) {
      return abandon()
    }
    TrackerHub.attach(this, getSystemService(PowerManager::class.java).isInteractive)
    return START_STICKY
  }

  /** The location permission was revoked or the system refused the start: the session is left to the launch reconciliation. */
  private fun abandon(): Int {
    TrackerHub.abandon(this)
    stopSelf()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    unregisterReceiver(screenReceiver)
    super.onDestroy()
  }

  private fun foregroundTypes(): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
    val bluetooth = TrackerHub.usesBluetooth(this) && TrackerPermissions.isGranted(this, TrackerPermission.BLUETOOTH)
    return ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION or if (bluetooth) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
  }
}
