package app.obnixe.tracker.location

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import app.obnixe.tracker.Fix
import app.obnixe.tracker.TrackerClock
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

enum class LocationSourceKind(val wire: String) {
  FUSED("fused"),
  GPS("gps"),
  REPLAY("replay"),
}

/** Fix cadence asked of a source; `maxUpdateDelayMs` lets the platform batch deliveries while the screen is off. */
data class LocationMode(val intervalMs: Long, val highAccuracy: Boolean, val maxUpdateDelayMs: Long)

fun interface FixSink {
  fun onFix(fix: Fix)
}

/** Callers hold the fine location permission; calling [start] again replaces the current mode. */
interface LocationSource {
  val kind: LocationSourceKind

  fun start(mode: LocationMode)

  fun stop()

  companion object {
    fun create(context: Context, handler: Handler, clock: TrackerClock, sink: FixSink, replay: ReplayTrack?): LocationSource = when {
      replay != null -> ReplayLocationSource(replay, handler, clock, sink)
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS ->
        FusedLocationSource(context, handler.looper, clock, sink)
      else -> PlatformLocationSource(context, handler.looper, clock, sink)
    }
  }
}

@SuppressLint("MissingPermission")
private class FusedLocationSource(context: Context, private val looper: Looper, private val clock: TrackerClock, private val sink: FixSink) :
  LocationSource {
  override val kind = LocationSourceKind.FUSED
  private val client = LocationServices.getFusedLocationProviderClient(context)
  private val callback = object : LocationCallback() {
    override fun onLocationResult(result: LocationResult) {
      for (location in result.locations) location.toFix(clock)?.let(sink::onFix)
    }
  }

  override fun start(mode: LocationMode) {
    val priority = if (mode.highAccuracy) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY
    val request = LocationRequest.Builder(priority, mode.intervalMs)
      .setMinUpdateIntervalMillis(mode.intervalMs)
      .setMaxUpdateDelayMillis(mode.maxUpdateDelayMs)
      .setWaitForAccurateLocation(false)
      .build()
    client.requestLocationUpdates(request, callback, looper)
  }

  override fun stop() {
    client.removeLocationUpdates(callback)
  }
}

/** `LocationManager` GPS provider, for phones without Google Play services. */
@SuppressLint("MissingPermission")
private class PlatformLocationSource(context: Context, private val looper: Looper, private val clock: TrackerClock, private val sink: FixSink) :
  LocationSource {
  override val kind = LocationSourceKind.GPS
  private val manager = context.getSystemService(LocationManager::class.java)
  private val listener = LocationListenerCompat { location: Location -> location.toFix(clock)?.let(sink::onFix) }

  override fun start(mode: LocationMode) {
    val quality = if (mode.highAccuracy) LocationRequestCompat.QUALITY_HIGH_ACCURACY else LocationRequestCompat.QUALITY_BALANCED_POWER_ACCURACY
    val request = LocationRequestCompat.Builder(mode.intervalMs)
      .setMinUpdateIntervalMillis(mode.intervalMs)
      .setMaxUpdateDelayMillis(mode.maxUpdateDelayMs)
      .setQuality(quality)
      .build()
    LocationManagerCompat.requestLocationUpdates(manager, LocationManager.GPS_PROVIDER, request, listener, looper)
  }

  override fun stop() {
    LocationManagerCompat.removeUpdates(manager, listener)
  }
}

/** A GPX track and the speed factor (1 to 50) at which it is replayed. */
data class ReplayTrack(val points: List<GpxPoint>, val speed: Double)

/**
 * Replays a GPX track as simulated fixes (`DEC-08`). The recording's clock runs `speed` times faster, so each fix keeps
 * the GPX time offset as its `t` and the replayed track keeps its real paces. GPX has no accuracy, Doppler speed nor
 * bearing: accuracy is reported as 5 m and the other fields as absent.
 */
private class ReplayLocationSource(private val track: ReplayTrack, private val handler: Handler, private val clock: TrackerClock, private val sink: FixSink) :
  LocationSource {
  override val kind = LocationSourceKind.REPLAY
  private val offsets = replayOffsets(track.points)
  private var next = 0
  private var startT = 0L
  private var startUptime = 0L
  private var running = false
  private val emit = object : Runnable {
    override fun run() {
      val elapsed = ((SystemClock.uptimeMillis() - startUptime) * track.speed).toLong()
      while (next < offsets.size && offsets[next] <= elapsed) {
        val point = track.points[next]
        sink.onFix(
          Fix(
            t = startT + offsets[next],
            fixAgeMs = 0,
            latitudeE7 = point.latitudeE7,
            longitudeE7 = point.longitudeE7,
            altitudeEllipsoidMm = null,
            altitudeMslMm = point.elevationMm,
            horizontalAccuracyDm = replayAccuracyDm,
            verticalAccuracyDm = point.elevationMm?.let { replayAccuracyDm * 2 },
            speedCmS = null,
            speedAccuracyCmS = null,
            bearingCentiDeg = null,
            bearingAccuracyCentiDeg = null,
            simulated = true,
          ),
        )
        next += 1
      }
      if (next < offsets.size) handler.postAtTime(this, startUptime + (offsets[next] / track.speed).toLong())
    }
  }

  override fun start(mode: LocationMode) {
    if (running) return
    running = true
    startT = clock.now()
    startUptime = SystemClock.uptimeMillis()
    handler.post(emit)
  }

  override fun stop() {
    running = false
    handler.removeCallbacks(emit)
  }

  private companion object {
    const val replayAccuracyDm = 50
  }
}

/** Offsets in ms from the first point, never decreasing; points without a time are spaced by 1 s. */
internal fun replayOffsets(points: List<GpxPoint>): LongArray {
  val offsets = LongArray(points.size)
  val origin = points.firstOrNull()?.timeMs
  for (index in 1 until points.size) {
    val time = points[index].timeMs
    val offset = if (origin != null && time != null) time - origin else offsets[index - 1] + 1000
    offsets[index] = maxOf(offset, offsets[index - 1])
  }
  return offsets
}
