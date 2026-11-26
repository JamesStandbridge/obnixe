package app.obnixe.tracker.location

import android.location.Location
import android.os.Build
import app.obnixe.tracker.Fix
import app.obnixe.tracker.TrackerClock
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Every field the platform reports (`GPS-011`), in journal units; null for a fix taken before the clock's origin. */
fun Location.toFix(clock: TrackerClock): Fix? {
  val t = clock.at(elapsedRealtimeNanos)
  if (t < 0) return null
  val extended = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
  return Fix(
    t = t,
    fixAgeMs = (clock.startedAt + t - time).coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt(),
    latitudeE7 = (latitude * 1e7).roundToLong().toInt(),
    longitudeE7 = (longitude * 1e7).roundToLong().toInt(),
    altitudeEllipsoidMm = if (hasAltitude()) (altitude * 1000).roundToInt() else null,
    altitudeMslMm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && hasMslAltitude()) (mslAltitudeMeters * 1000).roundToInt() else null,
    horizontalAccuracyDm = if (hasAccuracy()) (accuracy * 10).roundToInt() else null,
    verticalAccuracyDm = if (extended && hasVerticalAccuracy()) (verticalAccuracyMeters * 10).roundToInt() else null,
    speedCmS = if (hasSpeed()) (speed * 100).roundToInt() else null,
    speedAccuracyCmS = if (extended && hasSpeedAccuracy()) (speedAccuracyMetersPerSecond * 100).roundToInt() else null,
    bearingCentiDeg = if (hasBearing()) (bearing * 100).roundToInt() % 36_000 else null,
    bearingAccuracyCentiDeg = if (extended && hasBearingAccuracy()) (bearingAccuracyDegrees * 100).roundToInt() else null,
    simulated = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) isMock else @Suppress("DEPRECATION") isFromMockProvider,
  )
}
