package app.obnixe.tracker

import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import app.obnixe.tracker.bluetooth.BluetoothUnavailableException
import app.obnixe.tracker.bluetooth.SensorScanner
import app.obnixe.tracker.bluetooth.SensorService
import app.obnixe.tracker.journal.JournalBatch
import app.obnixe.tracker.journal.SamplePart
import app.obnixe.tracker.location.GpxFormatException
import app.obnixe.tracker.location.GpxReader
import app.obnixe.tracker.location.LocationMode
import app.obnixe.tracker.location.LocationSource
import app.obnixe.tracker.location.ReplayTrack
import expo.modules.kotlin.Promise
import java.io.File
import java.io.IOException
import org.xmlpull.v1.XmlPullParserException

enum class JournalMode { CREATE, CONTINUE }

/**
 * Joins the recording, owned by the process and kept alive by [TrackerService], to the JavaScript module, which may
 * come and go. Every recording, preparation and scan operation runs on one background thread; JavaScript events are
 * dropped while no module is attached, the journal keeping everything.
 */
internal object TrackerHub : Recording.Listener {
  @Volatile var module: ObnixeTrackerModule? = null
  @Volatile private var recording: Recording? = null
  @Volatile private var restoringSessionId: String? = null
  @Volatile private var preparation: LocationSource? = null
  private var lastStopped: StoppedRecording? = null
  private var scanner: SensorScanner? = null
  private lateinit var context: Context

  private val handler: Handler by lazy { Handler(HandlerThread("obnixe-tracker").apply { start() }.looper) }

  private fun confined(block: () -> Unit) {
    handler.post(block)
  }

  fun bind(context: Context) {
    if (!::context.isInitialized) this.context = context.applicationContext
  }

  fun status(): Map<String, Any?> {
    val sessionId = recording?.sessionId ?: restoringSessionId
    val state = when {
      sessionId != null -> "recording"
      preparation != null -> "preparing"
      else -> "idle"
    }
    return mapOf("state" to state, "sessionId" to sessionId)
  }

  /** Starts fixes in the foreground so the receiver is warm when the recording starts (`REC-012`). */
  fun prepare(promise: Promise) = confined {
    if (recording != null || preparation != null) return@confined promise.resolve(null)
    if (!TrackerPermissions.isGranted(context, TrackerPermission.LOCATION)) return@confined promise.reject(TrackerException.locationPermission())
    val clock = TrackerClock.start()
    val source = LocationSource.create(context, handler, clock, { fix -> module?.emitWarmupFix(fix) }, null)
    try {
      source.start(LocationMode(1_000, highAccuracy = true, maxUpdateDelayMs = 0))
    } catch (error: SecurityException) {
      return@confined promise.reject(TrackerException.locationPermission())
    }
    preparation = source
    promise.resolve(null)
  }

  fun cancelPreparation() = confined { stopPreparation() }

  fun start(config: RecordingConfig, mode: JournalMode, promise: Promise) = confined {
    if (recording != null || restoringSessionId != null) return@confined promise.reject(TrackerException.alreadyRecording())
    if (!TrackerPermissions.isGranted(context, TrackerPermission.LOCATION)) return@confined promise.reject(TrackerException.locationPermission())
    val replay = try {
      config.replay?.let { replay -> File(replay.gpxPath).inputStream().use { ReplayTrack(GpxReader.read(it), replay.speed) } }
    } catch (error: IOException) {
      return@confined promise.reject(TrackerException.invalidRequest("Replay file unreadable: ${error.message}"))
    } catch (error: XmlPullParserException) {
      return@confined promise.reject(TrackerException.invalidRequest("Replay file is not GPX: ${error.message}"))
    } catch (error: GpxFormatException) {
      return@confined promise.reject(TrackerException.invalidRequest("Replay file is not GPX: ${error.message}"))
    }
    stopPreparation()
    val recording = try {
      when (mode) {
        JournalMode.CREATE -> Recording.create(context, config, replay, handler, this)
        JournalMode.CONTINUE -> {
          val kept = RecordingStore.load(context)?.takeIf { it.config.sessionId == config.sessionId }
          Recording.open(context, config, kept?.stepBaseline, reopen = true, handler, this)
        }
      }
    } catch (error: IOException) {
      return@confined promise.reject(TrackerException.journal(error))
    }
    this.recording = recording
    try {
      TrackerService.start(context)
    } catch (error: IllegalStateException) {
      release(recording, delete = mode == JournalMode.CREATE)
      return@confined promise.reject(TrackerException.foregroundStart(error))
    }
    val sources = recording.startSources(screenInteractive = true)
    promise.resolve(mapOf("startedAt" to recording.startedAt.toDouble(), "sources" to sources.toBridge()))
  }

  fun mark(kind: MarkKind) = confined { recording?.mark(kind) }

  fun setPower(power: TrackerPower) = confined { recording?.setPower(power) }

  fun setNotification(content: TrackerNotificationContent) = confined { recording?.setNotification(content) }

  fun setScreenInteractive(interactive: Boolean) = confined { recording?.setScreenInteractive(interactive) }

  /** Stops the recording; for a recording that already stopped itself, answers with how it ended. */
  fun stop(promise: Promise) = confined {
    val recording = recording
    if (recording == null) {
      val stopped = lastStopped ?: return@confined promise.reject(TrackerException.notRecording())
      return@confined promise.resolve(stopped.toBridge())
    }
    val stopped = recording.stop()
    finish(stopped)
    promise.resolve(stopped.toBridge())
  }

  fun scanSensors(service: SensorService, timeoutMs: Long, promise: Promise) = confined {
    if (!TrackerPermissions.isGranted(context, TrackerPermission.BLUETOOTH)) return@confined promise.reject(TrackerException.bluetoothPermission())
    val scanner = scanner ?: SensorScanner(context, handler) { device -> module?.emitSensorDevice(device) }.also { scanner = it }
    try {
      scanner.start(service, timeoutMs) { promise.resolve(null) }
    } catch (error: BluetoothUnavailableException) {
      promise.reject(TrackerException.bluetoothUnavailable())
    }
  }

  fun stopScan() = confined { scanner?.stop() }

  /** What the service shows; reading the kept recording here marks it as being restored after a system restart. */
  fun notificationState(context: Context): NotificationState? {
    bind(context)
    recording?.let { return it.notificationState() }
    val kept = RecordingStore.load(context) ?: return null
    restoringSessionId = kept.config.sessionId
    return NotificationState(kept.config.sessionId, kept.config.notification, paused = false, frozenTimerMs = null)
  }

  fun usesBluetooth(context: Context): Boolean = (recording?.config ?: RecordingStore.load(context)?.config)?.bluetooth?.isNotEmpty() == true

  /** The service runs in the foreground: resumes the kept recording if the system restarted the process. */
  fun attach(context: Context, screenInteractive: Boolean) = confined {
    bind(context)
    val current = recording
    if (current != null) {
      current.setScreenInteractive(screenInteractive)
      return@confined
    }
    val kept = RecordingStore.load(context)
    if (kept == null) {
      restoringSessionId = null
      TrackerService.stop(context)
      return@confined
    }
    try {
      val restored = Recording.open(context, kept.config, kept.stepBaseline, reopen = false, handler, this)
      recording = restored
      restored.startSources(screenInteractive)
      refreshNotification(restored)
    } catch (error: IOException) {
      RecordingStore.clear(context)
      TrackerService.stop(context)
    } finally {
      restoringSessionId = null
    }
  }

  /** The service could not run in the foreground: the journal stays for the launch reconciliation (`REC-081`). */
  fun abandon(context: Context) = confined {
    bind(context)
    restoringSessionId = null
    val current = recording
    if (current == null) {
      RecordingStore.clear(context)
      return@confined
    }
    module?.emitIssue(current.sessionId, TrackerIssue.PERMISSION_LOST)
    release(current, delete = false)
  }

  override fun onPart(recording: Recording, part: SamplePart) {
    module?.emitPart(recording.sessionId, part)
  }

  override fun onBatch(recording: Recording, batch: JournalBatch) {
    module?.emitBatch(recording.sessionId, batch)
  }

  override fun onIssue(recording: Recording, issue: TrackerIssue) {
    module?.emitIssue(recording.sessionId, issue)
  }

  override fun onDisplayChanged(recording: Recording) {
    refreshNotification(recording)
  }

  override fun onSelfStopped(recording: Recording, stopped: StoppedRecording) {
    finish(stopped)
  }

  private fun finish(stopped: StoppedRecording) {
    recording = null
    lastStopped = stopped
    RecordingStore.clear(context)
    TrackerService.stop(context)
  }

  private fun release(recording: Recording, delete: Boolean) {
    recording.abandon(delete)
    this.recording = null
    RecordingStore.clear(context)
  }

  private fun stopPreparation() {
    preparation?.stop()
    preparation = null
  }

  @SuppressLint("MissingPermission")
  private fun refreshNotification(recording: Recording) {
    if (this.recording !== recording || !TrackerPermissions.isGranted(context, TrackerPermission.NOTIFICATIONS)) return
    context.getSystemService(NotificationManager::class.java)
      .notify(TrackerNotifications.notificationId, TrackerNotifications.build(context, recording.notificationState()))
  }
}
