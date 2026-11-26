import Foundation

/**
 Decouples delivery from durability: a tick either sends the new samples to JavaScript as a part, or writes the
 coming batch once `writeIntervalMs` passed since the last write (`PRF-051`, 720 `fsync` per hour at most). Every
 other write (marks, background, critical power) restarts the interval, so a sample waits at most `writeIntervalMs`
 in memory (`REC-080`).
 */
struct JournalCadence {
  private let writeIntervalMs: Int64
  private var lastWriteAtMs: Int64

  init(writeIntervalMs: Int64, startedAtMs: Int64) {
    self.writeIntervalMs = writeIntervalMs
    lastWriteAtMs = startedAtMs
  }

  func writeDue(nowMs: Int64) -> Bool {
    nowMs - lastWriteAtMs >= writeIntervalMs
  }

  mutating func wrote(nowMs: Int64) {
    lastWriteAtMs = nowMs
  }

  /// Delay until the next tick: the next delivery, or the next write when it comes first.
  func nextTickDelayMs(nowMs: Int64, deliveryIntervalMs: Int64) -> Int64 {
    min(deliveryIntervalMs, max(0, lastWriteAtMs + writeIntervalMs - nowMs))
  }
}
