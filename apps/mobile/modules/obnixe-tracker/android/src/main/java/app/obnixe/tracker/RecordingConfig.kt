package app.obnixe.tracker

import android.content.Context
import app.obnixe.tracker.bluetooth.SensorService
import expo.modules.kotlin.types.Enumerable
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** `saver` and `critical` are the battery modes of `NRG-001`: a fix every 5 s, then every 10 s. */
enum class TrackerPower(val value: String) : Enumerable {
  NORMAL("normal"),
  SAVER("saver"),
  CRITICAL("critical"),
}

data class TrackerProgressSegment(val length: Int, val highlighted: Boolean)

/** A segmented progress bar (`REC-074`), `value` counted on the summed segment lengths. */
data class TrackerNotificationProgress(val segments: List<TrackerProgressSegment>, val value: Int)

data class TrackerNotificationContent(
  val title: String,
  val text: String,
  /** EpochMs at which the notification timer read zero; null hides the timer. */
  val timerBaseAt: Long?,
  /** The steps of a guided workout; null for a free recording. */
  val progress: TrackerNotificationProgress?,
)

data class ReplaySource(val gpxPath: String, val speed: Double)

/** A paired source: the service it streams and its Bluetooth address. */
data class BluetoothSensor(val service: SensorService, val address: String) {
  companion object {
    /** The form `BluetoothAdapter.checkBluetoothAddress` accepts: six upper-case hex pairs. */
    private val addressPattern = Regex("[0-9A-F]{2}(:[0-9A-F]{2}){5}")

    /** Valid addresses and at most one source per role; one device may serve several roles. */
    fun isValidSelection(sensors: List<BluetoothSensor>): Boolean =
      sensors.all { addressPattern.matches(it.address) } && sensors.distinctBy { it.service.role }.size == sensors.size
  }
}

data class RecordingConfig(
  val sessionId: String,
  val journalPath: String,
  val power: TrackerPower,
  val barometer: Boolean,
  val pedometer: Boolean,
  /** At most one source per role; a device serving two roles appears once per service. */
  val bluetooth: List<BluetoothSensor>,
  /** Batch interval while the screen is on. */
  val batchIntervalMs: Long,
  /** Batch interval while the screen is off; location updates are batched by the provider up to it. */
  val backgroundBatchIntervalMs: Long,
  val notification: TrackerNotificationContent,
  val replay: ReplaySource?,
)

data class StoredRecording(val config: RecordingConfig, val stepBaseline: Long?)

/**
 * The live recording's configuration, kept in shared preferences so that a service restarted by the system
 * (`START_STICKY`) resumes the same journal. Replays are not kept: they are development runs.
 */
object RecordingStore {
  private const val preferences = "obnixe-tracker"
  private const val key = "recording"

  fun save(context: Context, recording: StoredRecording) {
    if (recording.config.replay != null) return
    val config = recording.config
    val json = JSONObject()
      .put("sessionId", config.sessionId)
      .put("journalPath", config.journalPath)
      .put("power", config.power.value)
      .put("barometer", config.barometer)
      .put("pedometer", config.pedometer)
      .put("bluetooth", JSONArray(config.bluetooth.map { JSONObject().put("service", it.service.value).put("address", it.address) }))
      .put("batchIntervalMs", config.batchIntervalMs)
      .put("backgroundBatchIntervalMs", config.backgroundBatchIntervalMs)
      .put("title", config.notification.title)
      .put("text", config.notification.text)
      .put("timerBaseAt", config.notification.timerBaseAt ?: JSONObject.NULL)
      .put("progress", config.notification.progress?.let(::progressJson) ?: JSONObject.NULL)
      .put("stepBaseline", recording.stepBaseline ?: JSONObject.NULL)
    store(context).edit().putString(key, json.toString()).commit()
  }

  fun load(context: Context): StoredRecording? {
    val raw = store(context).getString(key, null) ?: return null
    return try {
      val json = JSONObject(raw)
      val config = RecordingConfig(
        sessionId = json.getString("sessionId"),
        journalPath = json.getString("journalPath"),
        power = TrackerPower.entries.firstOrNull { it.value == json.getString("power") } ?: TrackerPower.NORMAL,
        barometer = json.getBoolean("barometer"),
        pedometer = json.getBoolean("pedometer"),
        bluetooth = json.getJSONArray("bluetooth").let { sensors ->
          List(sensors.length()) { index ->
            val sensor = sensors.getJSONObject(index)
            BluetoothSensor(SensorService.of(sensor.getString("service")) ?: throw JSONException("Unknown sensor service"), sensor.getString("address"))
          }
        },
        batchIntervalMs = json.getLong("batchIntervalMs"),
        backgroundBatchIntervalMs = json.getLong("backgroundBatchIntervalMs"),
        notification = TrackerNotificationContent(
          json.getString("title"),
          json.getString("text"),
          json.optNullableLong("timerBaseAt"),
          if (json.isNull("progress")) null else progressOf(json.getJSONObject("progress")),
        ),
        replay = null,
      )
      StoredRecording(config, json.optNullableLong("stepBaseline"))
    } catch (error: JSONException) {
      clear(context)
      null
    }
  }

  fun clear(context: Context) {
    store(context).edit().remove(key).commit()
  }

  private fun progressJson(progress: TrackerNotificationProgress): JSONObject {
    val segments = JSONArray()
    progress.segments.forEach { segments.put(JSONObject().put("length", it.length).put("highlighted", it.highlighted)) }
    return JSONObject().put("segments", segments).put("value", progress.value)
  }

  private fun progressOf(json: JSONObject): TrackerNotificationProgress {
    val segments = json.getJSONArray("segments")
    return TrackerNotificationProgress(
      (0 until segments.length()).map { index -> segments.getJSONObject(index).let { TrackerProgressSegment(it.getInt("length"), it.getBoolean("highlighted")) } },
      json.getInt("value"),
    )
  }

  private fun store(context: Context) = context.getSharedPreferences(preferences, Context.MODE_PRIVATE)

  private fun JSONObject.optNullableLong(name: String): Long? = if (isNull(name)) null else getLong(name)
}
