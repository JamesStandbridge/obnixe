package app.obnixe.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.PowerManager
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import app.obnixe.tracker.heartrate.HeartRateLink
import app.obnixe.tracker.heartrate.HeartRateMeasurement
import app.obnixe.tracker.journal.JournalBatch
import app.obnixe.tracker.journal.JournalFormat
import app.obnixe.tracker.journal.JournalFormatException
import app.obnixe.tracker.journal.JournalHeader
import app.obnixe.tracker.journal.JournalWriter
import app.obnixe.tracker.location.LocationMode
import app.obnixe.tracker.location.LocationSource
import app.obnixe.tracker.location.LocationSourceKind
import app.obnixe.tracker.location.ReplayTrack
import app.obnixe.tracker.sensors.SensorStream
import java.io.File
import java.io.IOException
import kotlin.math.roundToLong

enum class TrackerIssue(val wire: String) {
  PERMISSION_LOST("permission_lost"),
  PROVIDER_DISABLED("provider_disabled"),
  STORAGE_LOW("storage_low"),
  STORAGE_FULL("storage_full"),
  HEART_RATE_LOST("heart_rate_lost"),
}

data class TrackerSources(val location: LocationSourceKind, val barometer: Boolean, val pedometer: Boolean, val heartRate: Boolean) {
  fun toBridge(): Map<String, Any> = mapOf("location" to location.wire, "barometer" to barometer, "pedometer" to pedometer, "heartRate" to heartRate)
}

data class StoppedRecording(val sessionId: String, val endedAt: Long, val lastSequence: Long) {
  fun toBridge(): Map<String, Any> = mapOf("sessionId" to sessionId, "endedAt" to endedAt.toDouble(), "lastSequence" to lastSequence.toDouble())
}

/**
 * One recording: its sources, its journal and its pause state. Samples reach the journal before JavaScript sees them
 * (`REC-080`); batches close every `batchIntervalMs` while the screen is on and every 5 s while it is off
 * (`PRF-003`, `PRF-051`), and immediately on a mark. Confined to [handler]'s thread.
 */
class Recording private constructor(
  private val context: Context,
  config: RecordingConfig,
  private val journal: JournalWriter,
  private val clock: TrackerClock,
  private val replay: ReplayTrack?,
  private val handler: Handler,
  private val listener: Listener,
  paused: Boolean,
  private var stepBaseline: Long?,
  private var lastStepCount: Long,
) {
  interface Listener {
    fun onBatch(recording: Recording, batch: JournalBatch)

    fun onIssue(recording: Recording, issue: TrackerIssue)

    /** The pause state or the notification content changed. */
    fun onDisplayChanged(recording: Recording)

    /** The recording stopped itself (storage full); the owner releases it. */
    fun onSelfStopped(recording: Recording, stopped: StoppedRecording)
  }

  @Volatile var config = config
    private set

  @Volatile var paused = paused
    private set

  /** Timer value frozen by a pause, restored on resume so the notification stays right while JavaScript sleeps. */
  @Volatile var frozenTimerMs: Long? = null
    private set

  val sessionId get() = config.sessionId
  val startedAt get() = clock.startedAt

  fun notificationState() = NotificationState(sessionId, config.notification, paused, frozenTimerMs)

  private var screenInteractive = true
  private var location: LocationSource? = null
  private var barometer: SensorStream? = null
  private var steps: SensorStream? = null
  private var heartRate: HeartRateLink? = null
  private var stopped = false
  private var receiverRegistered = false
  private var storageLowReported = false
  private val flushTick = Runnable { tick() }
  private val writeLock = context.getSystemService(PowerManager::class.java)
    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "obnixe:journal")
    .apply { setReferenceCounted(false) }
  private val providerReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val manager = context.getSystemService(LocationManager::class.java)
      if (!LocationManagerCompat.isLocationEnabled(manager)) listener.onIssue(this@Recording, TrackerIssue.PROVIDER_DISABLED)
    }
  }

  /** Starts every available source the configuration asks for and reports which ones run. */
  fun startSources(screenInteractive: Boolean): TrackerSources {
    this.screenInteractive = screenInteractive
    val location = LocationSource.create(context, handler, clock, ::onSample, replay)
    this.location = location
    startLocation()
    ContextCompat.registerReceiver(context, providerReceiver, IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION), null, handler, ContextCompat.RECEIVER_NOT_EXPORTED)
    receiverRegistered = true
    val sensors = context.getSystemService(SensorManager::class.java)
    val live = replay == null
    if (live && config.barometer) {
      barometer = sensors.getDefaultSensor(Sensor.TYPE_PRESSURE)?.let { sensor ->
        SensorStream(sensors, sensor, handler) { event -> onSample(PressureSample(clock.at(event.timestamp), (event.values[0] * 100.0).roundToLong())) }
      }?.takeIf { it.start() }
    }
    if (live && config.pedometer && TrackerPermissions.isGranted(context, TrackerPermission.ACTIVITY)) {
      steps = sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)?.let { sensor ->
        SensorStream(sensors, sensor, handler) { event -> onStepCounter(clock.at(event.timestamp), event.values[0].toLong()) }
      }?.takeIf { it.start() }
    }
    val heartRateDevice = config.heartRateDevice
    if (heartRateDevice != null && (live || replay?.speed == 1.0) && TrackerPermissions.isGranted(context, TrackerPermission.BLUETOOTH)) {
      heartRate = HeartRateLink(context, heartRateDevice, handler, heartRateListener).also { it.start() }
    }
    scheduleTick()
    return TrackerSources(location.kind, barometer != null, steps != null, heartRate != null)
  }

  /** Writes a pause, resume or lap mark; false when the pause state makes it meaningless (lap or pause while paused). */
  fun mark(kind: MarkKind): Boolean {
    if (stopped) return false
    val accepted = when (kind) {
      MarkKind.PAUSE, MarkKind.LAP -> !paused
      MarkKind.RESUME -> paused
      MarkKind.START, MarkKind.STOP -> false
    }
    if (!accepted) return false
    if (kind == MarkKind.PAUSE || kind == MarkKind.RESUME) {
      paused = kind == MarkKind.PAUSE
      updateTimer()
      startLocation()
      listener.onDisplayChanged(this)
    }
    flush(Mark(clock.now(), kind))
    return true
  }

  fun setPower(power: TrackerPower) {
    if (stopped || power == config.power) return
    config = config.copy(power = power)
    persist()
    startLocation()
    if (power == TrackerPower.CRITICAL) flush()
  }

  fun setNotification(notification: TrackerNotificationContent) {
    if (stopped) return
    config = config.copy(notification = notification)
    persist()
    listener.onDisplayChanged(this)
  }

  fun setScreenInteractive(interactive: Boolean) {
    if (stopped || interactive == screenInteractive) return
    screenInteractive = interactive
    startLocation()
    flush()
    scheduleTick()
  }

  /** Stops the sources, writes the stop mark and closes the journal. */
  fun stop(): StoppedRecording {
    val endT = clock.now()
    release()
    val batch = try {
      journal.flush(Mark(endT, MarkKind.STOP))
    } catch (error: IOException) {
      null
    }
    journal.close()
    batch?.let { listener.onBatch(this, it) }
    val endedT = batch?.mark?.t ?: endT
    return StoppedRecording(sessionId, startedAt + endedT, batch?.sequence ?: (journal.nextSequence - 1))
  }

  /** Releases everything without a stop mark, for a recording whose service could not run; [delete] drops the journal. */
  fun abandon(delete: Boolean) {
    release()
    journal.close()
    if (delete) File(config.journalPath).delete()
  }

  private fun release() {
    stopped = true
    handler.removeCallbacks(flushTick)
    location?.stop()
    barometer?.stop()
    steps?.stop()
    heartRate?.stop()
    if (receiverRegistered) context.unregisterReceiver(providerReceiver)
    receiverRegistered = false
  }

  private fun onSample(sample: Sample) {
    if (stopped || !journal.append(sample)) return
    if (journal.pendingBytes >= maxPendingBytes) flush()
  }

  /** `TYPE_STEP_COUNTER` counts since boot; the baseline keeps the journal's count cumulative across restarts. */
  private fun onStepCounter(t: Long, total: Long) {
    val baseline = stepBaseline?.takeIf { it <= total } ?: (total - lastStepCount).also {
      stepBaseline = it
      persist()
    }
    lastStepCount = total - baseline
    onSample(StepSample(t, lastStepCount))
  }

  private val heartRateListener = object : HeartRateLink.Listener {
    override fun onMeasurement(elapsedRealtimeNanos: Long, measurement: HeartRateMeasurement) {
      onSample(HeartRateSample(clock.at(elapsedRealtimeNanos), measurement.bpm, measurement.contact, measurement.rrInterval))
    }

    override fun onLost() {
      listener.onIssue(this@Recording, TrackerIssue.HEART_RATE_LOST)
    }
  }

  private fun startLocation() {
    val location = location ?: return
    val intervalMs = when (config.power) {
      TrackerPower.NORMAL -> if (paused) pausedIntervalMs else normalIntervalMs
      TrackerPower.SAVER -> saverIntervalMs
      TrackerPower.CRITICAL -> criticalIntervalMs
    }
    val batched = !screenInteractive && intervalMs < RecordingConfig.screenOffBatchIntervalMs
    try {
      location.start(LocationMode(intervalMs, config.power == TrackerPower.NORMAL, if (batched) RecordingConfig.screenOffBatchIntervalMs else 0))
    } catch (error: SecurityException) {
      listener.onIssue(this, TrackerIssue.PERMISSION_LOST)
    }
  }

  private fun updateTimer() {
    val now = System.currentTimeMillis()
    val base = config.notification.timerBaseAt
    if (paused) {
      frozenTimerMs = base?.let { now - it }
    } else {
      val frozen = frozenTimerMs ?: return
      config = config.copy(notification = config.notification.copy(timerBaseAt = now - frozen))
      frozenTimerMs = null
      persist()
    }
  }

  private fun tick() {
    flush()
    scheduleTick()
  }

  private fun scheduleTick() {
    handler.removeCallbacks(flushTick)
    if (!stopped) handler.postDelayed(flushTick, if (screenInteractive) config.batchIntervalMs else RecordingConfig.screenOffBatchIntervalMs)
  }

  private fun flush(mark: Mark? = null) {
    writeLock.acquire(writeLockTimeoutMs)
    val batch = try {
      journal.flush(mark)
    } catch (error: IOException) {
      selfStop()
      return
    } finally {
      writeLock.release()
    } ?: return
    listener.onBatch(this, batch)
    checkStorage()
  }

  private fun checkStorage() {
    val free = File(config.journalPath).usableSpace
    when {
      free < storageFullBytes -> selfStop()
      free < storageLowBytes && !storageLowReported -> {
        storageLowReported = true
        listener.onIssue(this, TrackerIssue.STORAGE_LOW)
      }
    }
  }

  private fun selfStop() {
    if (stopped) return
    listener.onIssue(this, TrackerIssue.STORAGE_FULL)
    listener.onSelfStopped(this, stop())
  }

  private fun persist() {
    RecordingStore.save(context, StoredRecording(config, stepBaseline))
  }

  companion object {
    private const val normalIntervalMs = 1_000L
    private const val pausedIntervalMs = 5_000L
    private const val saverIntervalMs = 5_000L
    private const val criticalIntervalMs = 10_000L
    private const val maxPendingBytes = 64 * 1024
    private const val writeLockTimeoutMs = 2_000L
    private const val storageLowBytes = 50L * 1024 * 1024
    private const val storageFullBytes = 10L * 1024 * 1024

    /** Creates the journal, writes the start mark at `t = 0` and keeps the configuration for a system restart. */
    fun create(context: Context, config: RecordingConfig, replay: ReplayTrack?, handler: Handler, listener: Listener): Recording {
      val clock = TrackerClock.start(replay?.speed ?: 1.0)
      val header = JournalHeader(config.sessionId, clock.startedAt, clock.originNs, JournalFormat.platformAndroid, deviceName())
      val path = File(config.journalPath)
      val journal = JournalWriter.create(path, header)
      val start = try {
        checkNotNull(journal.flush(Mark(0, MarkKind.START)))
      } catch (error: IOException) {
        journal.close()
        path.delete()
        throw error
      }
      val recording = Recording(context, config, journal, clock, replay, handler, listener, paused = false, stepBaseline = null, lastStepCount = 0)
      listener.onBatch(recording, start)
      recording.persist()
      return recording
    }

    /**
     * Continues the journal of the kept recording after the system restarted the service, with its pause state, or,
     * with [reopen], of a session the app resumes after an interruption or from its stop summary: a stop mark at the
     * last record (unless the journal already ends with one) and a start mark now turn the gap into a pause (`REC-081`).
     * [stepBaseline] is the step counter reading at the start of this boot, if known.
     */
    fun open(context: Context, config: RecordingConfig, stepBaseline: Long?, reopen: Boolean, handler: Handler, listener: Listener): Recording {
      val resumed = JournalWriter.resume(File(config.journalPath), afterStop = reopen)
      val header = resumed.writer.header
      if (header.sessionId != config.sessionId) {
        resumed.writer.close()
        throw JournalFormatException("Journal belongs to session ${header.sessionId}")
      }
      val clock = TrackerClock.continuing(header.startedAt, header.monotonicOriginNs)
      val baseline = if (clock.reanchored) null else stepBaseline
      val batches = if (reopen) {
        try {
          listOfNotNull(
            if (resumed.stopped) null else resumed.writer.flush(Mark(resumed.lastT, MarkKind.STOP)),
            resumed.writer.flush(Mark(clock.now(), MarkKind.START)),
          )
        } catch (error: IOException) {
          resumed.writer.close()
          throw error
        }
      } else {
        emptyList()
      }
      val recording = Recording(context, config, resumed.writer, clock, null, handler, listener, resumed.paused && !reopen, baseline, resumed.lastStepCount)
      batches.forEach { listener.onBatch(recording, it) }
      recording.persist()
      return recording
    }

    private fun deviceName(): String {
      val model = Build.MODEL ?: ""
      val manufacturer = Build.MANUFACTURER ?: ""
      return if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model".trim()
    }
  }
}
