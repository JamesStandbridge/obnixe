package app.obnixe.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.obnixe.tunnel.Tunnel
import go.Seq

/** Keeps the process, and so the tunnel and the JavaScript that answers it, alive while remote access is on. */
class RemoteService : Service() {
  companion object {
    private const val extraAuthtoken = "authtoken"
    private const val channelId = "obnixe-remote"
    private const val notificationId = 7431

    fun start(context: Context, authtoken: String) {
      val intent = Intent(context, RemoteService::class.java).putExtra(extraAuthtoken, authtoken)
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, RemoteService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val authtoken = intent?.getStringExtra(extraAuthtoken)
    if (authtoken == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, notificationId, notification(), type)
    Seq.setContext(applicationContext)
    Tunnel.start(authtoken, RemoteHub)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    Tunnel.stop()
    super.onDestroy()
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(channelId, "Accès agent à distance", NotificationManager.IMPORTANCE_LOW))
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val open = launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    return NotificationCompat.Builder(this, channelId)
      .setSmallIcon(R.drawable.obnixe_remote_notification)
      .setContentTitle("Accès agent à distance actif")
      .setContentText("Ton téléphone répond aux agents que tu as autorisés")
      .setContentIntent(open)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }
}
