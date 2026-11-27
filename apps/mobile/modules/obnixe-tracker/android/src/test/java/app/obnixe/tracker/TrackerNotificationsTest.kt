package app.obnixe.tracker

import android.app.Notification
import android.content.Context
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class TrackerNotificationsTest {
  private val context: Context = RuntimeEnvironment.getApplication()

  private val intervals = TrackerNotificationProgress(
    listOf(TrackerProgressSegment(100, false)) + List(8) { listOf(TrackerProgressSegment(100, true), TrackerProgressSegment(100, false)) }.flatten() +
      listOf(TrackerProgressSegment(100, false)),
    250,
  )

  @Before
  fun declareScheme() {
    val info = checkNotNull(shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).applicationInfo)
    info.metaData = Bundle().apply { putString("app.obnixe.tracker.SCHEME", "obnixe-dev") }
  }

  private fun build(progress: TrackerNotificationProgress?, paused: Boolean): Notification =
    build(TrackerNotificationContent("Course · 1,20 km", "Étape 3/18 · Travail · reste 240 m", 1_000L, progress), paused)

  private fun build(content: TrackerNotificationContent, paused: Boolean, frozenTimerMs: Long? = 61_000L): Notification =
    TrackerNotifications.build(context, NotificationState("session", content, paused, frozenTimerMs))

  /** The Android 16 QPR1 rule of `Notification.hasPromotableCharacteristics`, read from the built notification. */
  private fun assertPromotable(notification: Notification) {
    assertTrue(notification.extras.getBoolean(Notification.EXTRA_REQUEST_PROMOTED_ONGOING))
    assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
    assertFalse(notification.extras.getCharSequence(Notification.EXTRA_TITLE).isNullOrEmpty())
    assertFalse(notification.extras.getBoolean(Notification.EXTRA_COLORIZED))
    assertTrue(notification.flags and Notification.FLAG_GROUP_SUMMARY == 0)
    assertNull(notification.contentView)
    assertNull(notification.bigContentView)
    assertNull(notification.headsUpContentView)
    val template = notification.extras.getString(Notification.EXTRA_TEMPLATE)
    assertTrue(template == null || template == Notification.ProgressStyle::class.java.name)
  }

  @Test
  fun `REC-074 the free recording notification asks for promotion and keeps every promotable characteristic`() {
    assertPromotable(build(null, paused = false))
    assertPromotable(build(null, paused = true))
  }

  @Test
  fun `REC-074 the stopwatch notification without location keeps every promotable characteristic and its chip`() {
    val running = build(TrackerNotificationContent("Course · chronomètre", "", 1_000L, null), paused = false)
    assertPromotable(running)
    assertTrue(running.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
    assertEquals(1_000L, running.`when`)
    val paused = build(TrackerNotificationContent("Course · chronomètre", "En pause", null, null), paused = true)
    assertPromotable(paused)
    assertEquals("Pause", paused.shortCriticalText)
  }

  @Test
  fun `REC-071 the paused notification says En pause once`() {
    val subText = { text: String, frozenTimerMs: Long? ->
      build(TrackerNotificationContent("Course · chronomètre", text, null, null), paused = true, frozenTimerMs = frozenTimerMs).extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()
    }
    assertNull(subText("En pause", null))
    assertEquals("En pause", subText("Allure 5:23 /km", null))
    assertEquals("En pause · 1:01", subText("En pause", 61_000L))
  }

  @Test
  fun `REC-074 the guided notification asks for promotion with the platform ProgressStyle`() {
    val notification = build(intervals, paused = false)
    assertPromotable(notification)
    assertEquals(Notification.ProgressStyle::class.java.name, notification.extras.getString(Notification.EXTRA_TEMPLATE))
    assertPromotable(build(intervals, paused = true))
  }

  @Test
  fun `REC-074 the guided notification draws one colored segment per repetition within the platform limit`() {
    val style = Notification.Builder.recoverBuilder(context, build(intervals, paused = false)).style as Notification.ProgressStyle
    assertEquals(10, style.progressSegments.size)
    assertEquals(listOf(100) + List(8) { 200 } + listOf(100), style.progressSegments.map { it.length })
    assertEquals(listOf(0xFF828B94.toInt()) + List(8) { 0xFFE5ED32.toInt() } + listOf(0xFF828B94.toInt()), style.progressSegments.map { it.color })
    assertEquals(250, style.progress)
    assertTrue(style.isStyledByProgress)
    assertTrue(style.progressPoints.isEmpty())
  }

  @Test
  fun `REC-071 the notification opens the live screen through the scheme of this build`() {
    val open = shadowOf(build(null, paused = false).contentIntent).savedIntent
    assertEquals("obnixe-dev://record/session", open.dataString)
    assertEquals(context.packageName, open.`package`)
  }
}
