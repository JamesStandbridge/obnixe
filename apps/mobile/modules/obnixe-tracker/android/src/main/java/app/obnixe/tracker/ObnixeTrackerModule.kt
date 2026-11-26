package app.obnixe.tracker

import android.net.Uri
import app.obnixe.tracker.bluetooth.SensorDevice
import app.obnixe.tracker.bluetooth.SensorService
import app.obnixe.tracker.journal.JournalBatch
import app.obnixe.tracker.journal.JournalHeader
import app.obnixe.tracker.journal.SamplePart
import expo.modules.interfaces.permissions.Permissions
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.Enumerable

class ObnixeTrackerModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val permissions: Permissions
    get() = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()

  override fun definition() = ModuleDefinition {
    Name("ObnixeTracker")

    Events("onSamples", "onMark", "onIssue", "onSensorDevice", "onWarmupFix")

    OnCreate {
      TrackerHub.bind(context)
      TrackerHub.module = this@ObnixeTrackerModule
    }

    OnDestroy {
      if (TrackerHub.module === this@ObnixeTrackerModule) TrackerHub.module = null
    }

    OnActivityEntersBackground {
      TrackerHub.cancelPreparation()
    }

    Function("status") {
      TrackerHub.status()
    }

    AsyncFunction("getPermission") { permission: TrackerPermission, promise: Promise ->
      permissions.getPermissions(listener(permission, promise), *TrackerPermissions.manifestPermissions(permission))
    }

    AsyncFunction("requestPermission") { permission: TrackerPermission, promise: Promise ->
      permissions.askForPermissions(listener(permission, promise), *TrackerPermissions.manifestPermissions(permission))
    }

    AsyncFunction("prepare") { promise: Promise ->
      TrackerHub.prepare(promise)
    }

    Function("cancelPreparation") {
      TrackerHub.cancelPreparation()
    }

    AsyncFunction("start") { request: StartRequestRecord, promise: Promise ->
      val config = request.toConfig() ?: return@AsyncFunction promise.reject(TrackerException.invalidRequest("Invalid start request"))
      TrackerHub.start(config, request.journal.mode, promise)
    }

    Function("mark") { kind: ControlMark ->
      TrackerHub.mark(kind.kind)
    }

    Function("setPower") { power: TrackerPower ->
      TrackerHub.setPower(power)
    }

    Function("setNotification") { notification: NotificationRecord ->
      TrackerHub.setNotification(notification.toContent())
    }

    AsyncFunction("scanSensors") { service: SensorService, timeoutMs: Double, promise: Promise ->
      TrackerHub.scanSensors(service, timeoutMs.toLong().coerceIn(1_000, 60_000), promise)
    }

    Function("stopScan") {
      TrackerHub.stopScan()
    }

    AsyncFunction("stop") { promise: Promise ->
      TrackerHub.stop(promise)
    }
  }

  internal fun emitPart(sessionId: String, part: SamplePart) {
    sendEvent(
      "onSamples",
      mapOf(
        "sessionId" to sessionId,
        "sequence" to part.sequence.toDouble(),
        "offset" to part.offset.toDouble(),
        "samples" to part.samples.map(Sample::toBridge),
        "end" to part.end,
      ),
    )
  }

  internal fun emitBatch(sessionId: String, batch: JournalBatch) {
    emitPart(sessionId, batch.lastPart())
    val mark = batch.mark ?: return
    sendEvent("onMark", mapOf("sessionId" to sessionId, "sequence" to batch.sequence.toDouble(), "kind" to mark.kind.wire, "t" to mark.t.toDouble()))
  }

  internal fun emitIssue(sessionId: String, issue: TrackerIssue) {
    sendEvent("onIssue", mapOf("sessionId" to sessionId, "kind" to issue.wire))
  }

  internal fun emitSensorDevice(device: SensorDevice) {
    sendEvent("onSensorDevice", device.toBridge())
  }

  internal fun emitWarmupFix(fix: Fix) {
    sendEvent("onWarmupFix", fix.toBridge())
  }

  private fun listener(permission: TrackerPermission, promise: Promise) =
    PermissionsResponseListener { responses -> promise.resolve(TrackerPermissions.status(permission, responses)) }
}

enum class ControlMark(val value: String) : Enumerable {
  PAUSE("pause"),
  RESUME("resume"),
  LAP("lap"),
  EXTEND("extend");

  val kind: MarkKind
    get() = when (this) {
      PAUSE -> MarkKind.PAUSE
      RESUME -> MarkKind.RESUME
      LAP -> MarkKind.LAP
      EXTEND -> MarkKind.EXTEND
    }
}

enum class JournalModeArgument(val value: String) : Enumerable {
  CREATE("create"),
  CONTINUE("continue");

  val mode: JournalMode
    get() = when (this) {
      CREATE -> JournalMode.CREATE
      CONTINUE -> JournalMode.CONTINUE
    }
}

class ProgressSegmentRecord : Record {
  @Field val length: Double = 0.0
  @Field val highlighted: Boolean = false
}

class ProgressRecord : Record {
  @Field val segments: List<ProgressSegmentRecord> = emptyList()
  @Field val value: Double = 0.0

  fun toProgress() = TrackerNotificationProgress(segments.map { TrackerProgressSegment(it.length.toInt(), it.highlighted) }, value.toInt())
}

class NotificationRecord : Record {
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val timerBaseAt: Double? = null
  @Field val progress: ProgressRecord? = null

  fun toContent() = TrackerNotificationContent(title, text, timerBaseAt?.toLong(), progress?.toProgress())
}

class BluetoothSensorRecord : Record {
  @Field val service: SensorService = SensorService.HEART_RATE
  @Field val id: String = ""
}

class SensorsRecord : Record {
  @Field val location: Boolean = true
  @Field val barometer: Boolean = false
  @Field val pedometer: Boolean = false
  @Field val bluetooth: List<BluetoothSensorRecord> = emptyList()
}

class ReplayRecord : Record {
  @Field val gpxPath: String = ""
  @Field val speed: Double = 1.0
}

class StartRequestRecord : Record {
  @Field val sessionId: String = ""
  @Field val journalPath: String = ""
  @Field val journal: JournalModeArgument = JournalModeArgument.CREATE
  @Field val power: TrackerPower = TrackerPower.NORMAL
  @Field val sensors: SensorsRecord = SensorsRecord()
  @Field val deliveryIntervalMs: Double = 5_000.0
  @Field val backgroundDeliveryIntervalMs: Double = 5_000.0
  @Field val notification: NotificationRecord = NotificationRecord()
  @Field val replay: ReplayRecord? = null

  /** The validated configuration, or null when a field is out of its contract. */
  fun toConfig(): RecordingConfig? {
    val bluetooth = sensors.bluetooth.map { BluetoothSensor(it.service, it.id) }
    val replay = replay
    val valid = JournalHeader.isSessionId(sessionId) &&
      journalPath.isNotEmpty() &&
      (deliveryIntervalMs == 1_000.0 || deliveryIntervalMs == 5_000.0) &&
      (backgroundDeliveryIntervalMs == 1_000.0 || backgroundDeliveryIntervalMs == 5_000.0) &&
      BluetoothSensor.isValidSelection(bluetooth) &&
      (sensors.location || (bluetooth.isNotEmpty() && replay == null)) &&
      (replay == null || replay.speed in 1.0..50.0)
    if (!valid) return null
    return RecordingConfig(
      sessionId = sessionId.lowercase(),
      journalPath = filePath(journalPath),
      power = power,
      location = sensors.location,
      barometer = sensors.barometer,
      pedometer = sensors.pedometer,
      bluetooth = bluetooth,
      deliveryIntervalMs = deliveryIntervalMs.toLong(),
      backgroundDeliveryIntervalMs = backgroundDeliveryIntervalMs.toLong(),
      notification = notification.toContent(),
      replay = replay?.let { ReplaySource(filePath(it.gpxPath), it.speed) },
    )
  }

  private fun filePath(value: String): String = if (value.startsWith("file:")) Uri.parse(value).path ?: value else value
}
