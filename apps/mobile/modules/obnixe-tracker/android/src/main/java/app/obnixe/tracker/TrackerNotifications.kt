package app.obnixe.tracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat

/** What the recording notification shows; built by the service from the live recording or its kept configuration. */
data class NotificationState(val sessionId: String, val content: TrackerNotificationContent, val paused: Boolean, val frozenTimerMs: Long?)

/**
 * Ongoing workout notification (`REC-071`): low importance, timer, Pause or Resume and Lap actions handled by the service
 * even while JavaScript sleeps, and a request for promotion to an Android 16 Live Update (`REC-074`) whose status chip
 * shows the timer. Tapping it opens the live screen.
 */
object TrackerNotifications {
  const val notificationId = 7432
  private const val channelId = "obnixe-tracker"
  private val workColor = 0xFFE5ED32.toInt()
  private val restColor = 0xFF828B94.toInt()

  fun build(context: Context, state: NotificationState): Notification {
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(channelId, "Enregistrement d'activité", NotificationManager.IMPORTANCE_LOW))
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("obnixe://record/${state.sessionId}")).setPackage(context.packageName)
    val content = state.content
    val builder = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(R.drawable.obnixe_tracker_notification)
      .setContentTitle(content.title)
      .setContentText(content.text)
      .setContentIntent(PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      .setCategory(NotificationCompat.CATEGORY_WORKOUT)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setRequestPromotedOngoing(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    val timerBaseAt = content.timerBaseAt
    if (state.paused) {
      builder.setShowWhen(false)
        .setSubText(state.frozenTimerMs?.let { "En pause · ${formatTimer(it)}" } ?: "En pause")
        .setShortCriticalText("Pause")
        .addAction(action(context, TrackerService.actionResume, R.drawable.obnixe_tracker_resume, "Reprendre"))
    } else {
      if (timerBaseAt != null) builder.setWhen(timerBaseAt).setUsesChronometer(true).setShowWhen(true) else builder.setShowWhen(false)
      builder.addAction(action(context, TrackerService.actionPause, R.drawable.obnixe_tracker_pause, "Pause"))
        .addAction(action(context, TrackerService.actionLap, R.drawable.obnixe_tracker_lap, if (content.progress == null) "Tour" else "Étape suivante"))
    }
    content.progress?.let { builder.setStyle(progressStyle(it)) }
    return builder.build()
  }

  /** `REC-074`: the steps of a guided workout as `ProgressStyle` segments, the work steps in the accent color. */
  private fun progressStyle(progress: TrackerNotificationProgress): NotificationCompat.ProgressStyle =
    NotificationCompat.ProgressStyle()
      .setProgressSegments(fitProgressSegments(progress.segments).map { NotificationCompat.ProgressStyle.Segment(it.length).setColor(if (it.highlighted) workColor else restColor) })
      .setProgress(progress.value)

  private fun action(context: Context, action: String, icon: Int, title: String): NotificationCompat.Action {
    val intent = Intent(context, TrackerService::class.java).setAction(action)
    val pending = PendingIntent.getService(context, action.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return NotificationCompat.Action.Builder(icon, title, pending).build()
  }

  private fun formatTimer(ms: Long): String {
    val seconds = ms / 1000
    val hours = seconds / 3600
    val minutes = seconds / 60 % 60
    return if (hours > 0) "%d:%02d:%02d".format(hours, minutes, seconds % 60) else "%d:%02d".format(minutes, seconds % 60)
  }
}
