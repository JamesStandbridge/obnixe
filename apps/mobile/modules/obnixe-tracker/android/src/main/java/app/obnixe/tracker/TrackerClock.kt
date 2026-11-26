package app.obnixe.tracker

import android.os.SystemClock
import kotlin.math.abs

/**
 * Monotonic time base of a recording (`GPS-012`): `t = (m - m0) * rate` in ms, where `m` is
 * `SystemClock.elapsedRealtimeNanos` (sleep included) and `t0` the EpochMs captured together with `m0`. `rate` is 1
 * except for the replay source, whose time runs `speed` times faster.
 */
class TrackerClock(
  val startedAt: Long,
  val originNs: Long,
  private val rate: Double = 1.0,
  /** True when the origin was moved because the phone rebooted since `m0` was read. */
  val reanchored: Boolean = false,
) {
  fun now(): Long = at(SystemClock.elapsedRealtimeNanos())

  /** `t` of an instant read on the `elapsedRealtimeNanos` base, such as `Location.elapsedRealtimeNanos`. */
  fun at(elapsedRealtimeNanos: Long): Long = Math.floorDiv(((elapsedRealtimeNanos - originNs) * rate).toLong(), 1_000_000L)

  companion object {
    private const val bootToleranceNs = 60_000_000_000L

    fun start(rate: Double = 1.0): TrackerClock {
      val originNs = SystemClock.elapsedRealtimeNanos()
      return TrackerClock(System.currentTimeMillis(), originNs, rate)
    }

    /**
     * The clock of a journal being continued. Within the boot that read `m0`, the monotonic and wall clocks advance
     * together and the origin is kept; after a reboot the monotonic clock restarted, so the origin is re-anchored on
     * the wall clock and `t` keeps counting from `t0` across the interruption.
     */
    fun continuing(startedAt: Long, originNs: Long): TrackerClock {
      val elapsed = SystemClock.elapsedRealtimeNanos()
      val expectedOrigin = elapsed - (System.currentTimeMillis() - startedAt) * 1_000_000L
      return if (abs(expectedOrigin - originNs) <= bootToleranceNs) {
        TrackerClock(startedAt, originNs)
      } else {
        TrackerClock(startedAt, expectedOrigin, reanchored = true)
      }
    }
  }
}
