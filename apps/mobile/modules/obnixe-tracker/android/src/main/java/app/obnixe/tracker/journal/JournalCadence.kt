package app.obnixe.tracker.journal

/**
 * Decouples delivery from durability: a tick either sends the new samples to JavaScript as a part, or writes the
 * coming batch once [writeIntervalMs] passed since the last write (`PRF-051`, 720 `fsync` per hour at most). Every
 * other write (marks, screen off, critical power) restarts the interval, so a sample waits at most [writeIntervalMs]
 * in memory (`REC-080`).
 */
class JournalCadence(private val writeIntervalMs: Long, startedAtMs: Long) {
  private var lastWriteAtMs = startedAtMs

  fun writeDue(nowMs: Long): Boolean = nowMs - lastWriteAtMs >= writeIntervalMs

  fun wrote(nowMs: Long) {
    lastWriteAtMs = nowMs
  }

  /** Delay until the next tick: the next delivery, or the next write when it comes first. */
  fun nextTickDelayMs(nowMs: Long, deliveryIntervalMs: Long): Long =
    minOf(deliveryIntervalMs, maxOf(0L, lastWriteAtMs + writeIntervalMs - nowMs))
}
