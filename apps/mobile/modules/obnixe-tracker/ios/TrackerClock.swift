import Foundation

/**
 Monotonic time base of a recording (`GPS-012`): `t = (m - m0) * rate` in ms, where `m` is
 `clock_gettime_nsec_np(CLOCK_MONOTONIC)` (sleep included) and `t0` the EpochMs captured together with `m0`. `rate`
 is 1 except for the replay source, whose time runs `speed` times faster.
 */
struct TrackerClock {
  let startedAt: Int64
  let originNs: Int64
  var rate = 1.0

  func now() -> Int64 {
    at(monotonicNs: Self.monotonicNs())
  }

  /// `t` of an instant read on the `CLOCK_MONOTONIC` base.
  func at(monotonicNs: Int64) -> Int64 {
    Int64((Double(monotonicNs - originNs) * rate / 1_000_000).rounded(.down))
  }

  /// `t` of a wall-clock instant, such as the timestamp of a fix or a pedometer period.
  func at(date: Date) -> Int64 {
    now() - Int64(roundedClamping: Date().timeIntervalSince(date) * 1000 * rate)
  }

  static func monotonicNs() -> Int64 {
    Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC))
  }

  static func wallMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
  }

  private static let bootToleranceNs: Int64 = 60_000_000_000

  static func start(rate: Double = 1) -> TrackerClock {
    let originNs = monotonicNs()
    return TrackerClock(startedAt: wallMs(), originNs: originNs, rate: rate)
  }

  /**
   The clock of a journal being continued. Within the boot that read `m0`, the monotonic and wall clocks advance
   together and the origin is kept; after a reboot the monotonic clock restarted, so the origin is re-anchored on the
   wall clock and `t` keeps counting from `t0` across the interruption.
   */
  static func continuing(startedAt: Int64, originNs: Int64) -> TrackerClock {
    let monotonic = monotonicNs()
    let expectedOrigin = monotonic - (wallMs() - startedAt) * 1_000_000
    if abs(expectedOrigin - originNs) <= bootToleranceNs {
      return TrackerClock(startedAt: startedAt, originNs: originNs)
    }
    return TrackerClock(startedAt: startedAt, originNs: expectedOrigin)
  }
}
