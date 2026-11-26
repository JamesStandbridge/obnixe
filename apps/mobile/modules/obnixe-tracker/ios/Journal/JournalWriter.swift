import Foundation

/// One batch as written: the samples in arrival order, then at most one mark, which always closes its batch.
struct JournalBatch: Equatable {
  let sequence: Int
  let samples: [Sample]
  let mark: Mark?
}

struct ResumedJournal {
  let writer: JournalWriter
  let paused: Bool
  /// Only true for a journal reopened after its stop mark.
  let stopped: Bool
  /// Latest `t` of any record.
  let lastT: Int64
}

/**
 Append-only writer of the raw journal (annex C, `REC-080`). Samples accumulate in memory until `flush` writes them
 as one self-checked batch followed by `FileHandle.synchronize`. Every record it writes is one the strict reader
 accepts: `t` stays within `u32` and never goes back within its stream, coordinates stay within bounds, enums stay in
 range. Not thread-safe: the owner confines it to one queue.
 */
final class JournalWriter {
  let header: JournalHeader
  private let handle: FileHandle
  private var lastT: [Int64]
  private var pending = ByteSink(capacity: 4096)
  private var pendingSamples: [Sample] = []

  private(set) var nextSequence: Int

  var pendingBytes: Int { pending.count - JournalFormat.batchPrefixBytes }

  private init(handle: FileHandle, header: JournalHeader, nextSequence: Int, lastT: [Int64]) {
    self.handle = handle
    self.header = header
    self.nextSequence = nextSequence
    self.lastT = lastT
    pending.append([UInt8](repeating: 0, count: JournalFormat.batchPrefixBytes))
  }

  /// Buffers [sample] for the next batch; false when the strict reader would refuse it, in which case it is dropped.
  func append(_ sample: Sample) -> Bool {
    guard accepts(t: sample.t, of: sample.recordType) else { return false }
    if case .fix(let fix) = sample, !accepts(fix) { return false }
    encode(sample)
    lastT[Int(sample.recordType.rawValue)] = sample.t
    pendingSamples.append(sample)
    return true
  }

  /**
   Writes the pending samples, then [mark] if given, as one batch and synchronizes it to storage. A mark whose `t`
   would go back in time is moved to the last mark's instant rather than lost. Returns nil when there was nothing to
   write. On failure the file is cut back to its last complete batch and the pending samples are kept for the next
   attempt.
   */
  func flush(mark: Mark? = nil) throws -> JournalBatch? {
    if pendingSamples.isEmpty && mark == nil { return nil }
    let pendingEnd = pending.count
    let markType = Int(RecordType.mark.rawValue)
    let written = mark.map { Mark(t: min(max($0.t, lastT[markType], 0), JournalFormat.maxUInt32), kind: $0.kind) }
    if let written { encode(written) }
    pending.setU32(at: 0, UInt32(pending.count - JournalFormat.batchPrefixBytes))
    pending.setU32(at: 4, UInt32(nextSequence))
    pending.u32(pending.crc32(from: 0, count: pending.count))
    let start = try handle.offset()
    do {
      try handle.write(contentsOf: pending.bytes)
      try handle.synchronize()
    } catch {
      pending.truncate(to: pendingEnd)
      try? handle.truncate(atOffset: start)
      try? handle.seek(toOffset: start)
      throw error
    }
    if let written { lastT[markType] = written.t }
    let batch = JournalBatch(sequence: nextSequence, samples: pendingSamples, mark: written)
    nextSequence += 1
    pendingSamples.removeAll(keepingCapacity: true)
    pending.truncate(to: JournalFormat.batchPrefixBytes)
    return batch
  }

  func close() {
    try? handle.close()
  }

  private func accepts(t: Int64, of type: RecordType) -> Bool {
    (0...JournalFormat.maxUInt32).contains(t) && t >= lastT[Int(type.rawValue)]
  }

  private func accepts(_ fix: Fix) -> Bool {
    JournalFormat.latitudeE7Range.contains(fix.latitudeE7) && JournalFormat.longitudeE7Range.contains(fix.longitudeE7)
  }

  private func encode(_ sample: Sample) {
    pending.u8(sample.recordType.rawValue)
    pending.u32(UInt32(sample.t))
    switch sample {
    case .fix(let fix):
      pending.i32(fix.fixAgeMs)
      pending.i32(fix.latitudeE7)
      pending.i32(fix.longitudeE7)
      pending.i32(fix.altitudeEllipsoidMm ?? JournalFormat.absentInt32)
      pending.i32(fix.altitudeMslMm ?? JournalFormat.absentInt32)
      pending.u16(uint16(fix.horizontalAccuracyDm))
      pending.u16(uint16(fix.verticalAccuracyDm))
      pending.u16(uint16(fix.speedCmS))
      pending.u16(uint16(fix.speedAccuracyCmS))
      pending.u16(uint16(fix.bearingCentiDeg))
      pending.u16(uint16(fix.bearingAccuracyCentiDeg))
      pending.u8(fix.simulated ? JournalFormat.fixFlagSimulated : 0)
    case .pressure(let sample):
      pending.u32(UInt32(min(max(sample.pascals, 0), JournalFormat.maxUInt32)))
    case .steps(let sample):
      pending.u32(UInt32(min(max(sample.count, 0), JournalFormat.maxUInt32)))
    case .heartRate(let sample):
      pending.u16(UInt16(min(max(sample.bpm, 0), 0xFFFF)))
      pending.u8(sample.contact.rawValue)
      pending.u16(sample.rrInterval.map { UInt16(min(max($0, 1), 0xFFFF)) } ?? 0)
    case .cadence(let sample):
      pending.u16(UInt16(min(max(sample.perMinute, 0), JournalFormat.maxUInt16)))
    case .power(let sample):
      pending.u16(UInt16(min(max(sample.watts, 0), JournalFormat.maxUInt16)))
      pending.u16(uint16(sample.cadence))
    }
  }

  private func encode(_ mark: Mark) {
    pending.u8(RecordType.mark.rawValue)
    pending.u32(UInt32(mark.t))
    pending.u8(mark.kind.rawValue)
  }

  private func uint16(_ value: Int?) -> UInt16 {
    value.map { UInt16(min(max($0, 0), JournalFormat.maxUInt16)) } ?? JournalFormat.absentUInt16
  }

  /// Creates the journal file, which must not exist yet, and writes its header.
  static func create(at url: URL, header: JournalHeader) throws -> JournalWriter {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    do {
      try handle.write(contentsOf: header.encode())
      try handle.synchronize()
    } catch {
      try? handle.close()
      try? FileManager.default.removeItem(at: url)
      throw error
    }
    return JournalWriter(handle: handle, header: header, nextSequence: 0, lastT: RecordType.newClockArray())
  }

  /// Reopens a journal after an interruption, cutting any torn or invalid tail so new batches stay readable.
  /// A stopped journal is only reopened with `afterStop`, for a recording resumed from its stop summary.
  static func resume(at url: URL, afterStop: Bool = false) throws -> ResumedJournal {
    let tail = try JournalScanner.scan([UInt8](Data(contentsOf: url)))
    if tail.stopped && !afterStop { throw JournalFormatError("Journal already stopped") }
    let handle = try FileHandle(forWritingTo: url)
    do {
      try handle.truncate(atOffset: UInt64(tail.validLength))
      try handle.seek(toOffset: UInt64(tail.validLength))
      try handle.synchronize()
    } catch {
      try? handle.close()
      throw error
    }
    let writer = JournalWriter(handle: handle, header: tail.header, nextSequence: tail.nextSequence, lastT: tail.lastT)
    return ResumedJournal(writer: writer, paused: tail.paused, stopped: tail.stopped, lastT: tail.lastT.max() ?? 0)
  }
}

struct JournalTail {
  let header: JournalHeader
  let validLength: Int
  let nextSequence: Int
  /// Last `t` per record type code.
  let lastT: [Int64]
  let paused: Bool
  let stopped: Bool
}

/// Finds the end of the last batch the strict reader accepts, with the state needed to keep appending after it.
enum JournalScanner {
  static func scan(_ bytes: [UInt8]) throws -> JournalTail {
    var validLength = 0
    let header = try JournalHeader.decode(bytes, offset: &validLength)
    var lastT = RecordType.newClockArray()
    var sequence = 0
    var paused = false
    var stopped = false
    while true {
      let start = validLength
      guard bytes.count - start >= JournalFormat.batchPrefixBytes + JournalFormat.batchSuffixBytes else { break }
      let length = Int(bytes.u32(at: start))
      let end = start + JournalFormat.batchPrefixBytes + length
      guard length > 0, end + JournalFormat.batchSuffixBytes <= bytes.count else { break }
      guard Int(bytes.u32(at: start + 4)) == sequence else { break }
      guard CRC32.checksum(bytes[start..<end]) == bytes.u32(at: end) else { break }
      var batchT = lastT
      var batchPaused = paused
      var batchStopped = stopped
      var offset = start + JournalFormat.batchPrefixBytes
      var valid = true
      while valid && offset < end {
        guard let type = RecordType(rawValue: bytes[offset]), offset + type.size <= end else {
          valid = false
          break
        }
        let t = Int64(bytes.u32(at: offset + 1))
        var recordValid = true
        switch type {
        case .fix:
          recordValid = JournalFormat.latitudeE7Range.contains(bytes.i32(at: offset + 9)) &&
            JournalFormat.longitudeE7Range.contains(bytes.i32(at: offset + 13)) &&
            bytes[offset + 37] & ~JournalFormat.fixFlagSimulated == 0
        case .heartRate:
          recordValid = HeartRateContact(rawValue: bytes[offset + 7]) != nil
        case .mark:
          switch MarkKind(rawValue: bytes[offset + 5]) {
          case .pause: batchPaused = true
          case .resume: batchPaused = false
          case .stop: batchStopped = true
          case .start:
            batchStopped = false
            batchPaused = false
          case .lap: break
          case nil: recordValid = false
          }
        case .pressure, .steps, .power, .cadence:
          break
        }
        valid = recordValid && t >= batchT[Int(type.rawValue)]
        batchT[Int(type.rawValue)] = t
        offset += type.size
      }
      if !valid { break }
      lastT = batchT
      paused = batchPaused
      stopped = batchStopped
      sequence += 1
      validLength = end + JournalFormat.batchSuffixBytes
    }
    return JournalTail(header: header, validLength: validLength, nextSequence: sequence, lastT: lastT, paused: paused, stopped: stopped)
  }
}
