package app.obnixe.tracker.journal

import app.obnixe.tracker.Fix
import app.obnixe.tracker.HeartRateSample
import app.obnixe.tracker.JournalRecord
import app.obnixe.tracker.Mark
import app.obnixe.tracker.MarkKind
import app.obnixe.tracker.PressureSample
import app.obnixe.tracker.Sample
import app.obnixe.tracker.StepSample
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.util.zip.CRC32

/** One batch as written: the samples in arrival order, then at most one mark, which always closes its batch. */
data class JournalBatch(val sequence: Long, val samples: List<Sample>, val mark: Mark?)

/** [lastT] is the latest `t` of any record; [stopped] is only true for a journal reopened after its stop mark. */
data class ResumedJournal(val writer: JournalWriter, val paused: Boolean, val stopped: Boolean, val lastT: Long, val lastStepCount: Long)

/**
 * Append-only writer of the raw journal (annex C, `REC-080`). Samples accumulate in memory until [flush] writes them
 * as one self-checked batch followed by `FileChannel.force`. Every record it writes is one the strict reader accepts:
 * `t` stays within `u32` and never goes back within its stream, coordinates stay within bounds, enums stay in range.
 * Not thread-safe: the owner confines it to one thread.
 */
class JournalWriter private constructor(
  private val file: RandomAccessFile,
  val header: JournalHeader,
  nextSequence: Long,
  private val lastT: LongArray,
) : Closeable {
  private val channel: FileChannel = file.channel
  private val pending = ByteSink(4096).apply { truncate(JournalFormat.batchPrefixBytes) }
  private val pendingSamples = ArrayList<Sample>()

  var nextSequence = nextSequence
    private set

  val pendingBytes get() = pending.size - JournalFormat.batchPrefixBytes

  /** Buffers [sample] for the next batch; false when the strict reader would refuse it, in which case it is dropped. */
  fun append(sample: Sample): Boolean {
    if (!acceptsTime(sample)) return false
    if (sample is Fix && !acceptsPosition(sample)) return false
    encode(sample)
    lastT[sample.recordType.code] = sample.t
    pendingSamples += sample
    return true
  }

  /**
   * Writes the pending samples, then [mark] if given, as one batch and forces it to storage. A mark whose `t` would go
   * back in time is moved to the last mark's instant rather than lost. Returns null when there was nothing to write.
   * On failure the file is cut back to its last complete batch and the pending samples are kept for the next attempt.
   */
  fun flush(mark: Mark? = null): JournalBatch? {
    if (pendingSamples.isEmpty() && mark == null) return null
    val pendingEnd = pending.size
    val written = mark?.let { Mark(maxOf(it.t, lastT[it.recordType.code], 0).coerceAtMost(JournalFormat.maxUInt32), it.kind) }
    if (written != null) encode(written)
    pending.setU32(0, (pending.size - JournalFormat.batchPrefixBytes).toLong())
    pending.setU32(4, nextSequence)
    pending.u32(pending.crc32(0, pending.size))
    val start = channel.position()
    try {
      val buffer = ByteBuffer.wrap(pending.array, 0, pending.size)
      while (buffer.hasRemaining()) channel.write(buffer)
      channel.force(false)
    } catch (error: IOException) {
      pending.truncate(pendingEnd)
      channel.truncate(start)
      channel.position(start)
      throw error
    }
    if (written != null) lastT[written.recordType.code] = written.t
    val batch = JournalBatch(nextSequence, pendingSamples.toList(), written)
    nextSequence += 1
    pendingSamples.clear()
    pending.truncate(JournalFormat.batchPrefixBytes)
    return batch
  }

  override fun close() {
    file.close()
  }

  private fun acceptsTime(record: JournalRecord): Boolean =
    record.t in 0..JournalFormat.maxUInt32 && record.t >= lastT[record.recordType.code]

  private fun acceptsPosition(fix: Fix): Boolean =
    fix.latitudeE7 in -JournalFormat.maxLatitudeE7..JournalFormat.maxLatitudeE7 &&
      fix.longitudeE7 in -JournalFormat.maxLongitudeE7..JournalFormat.maxLongitudeE7

  private fun encode(record: JournalRecord) {
    val sink = pending
    sink.u8(record.recordType.code)
    sink.u32(record.t)
    when (record) {
      is Fix -> {
        sink.i32(record.fixAgeMs)
        sink.i32(record.latitudeE7)
        sink.i32(record.longitudeE7)
        sink.i32(int32(record.altitudeEllipsoidMm))
        sink.i32(int32(record.altitudeMslMm))
        sink.u16(uint16(record.horizontalAccuracyDm))
        sink.u16(uint16(record.verticalAccuracyDm))
        sink.u16(uint16(record.speedCmS))
        sink.u16(uint16(record.speedAccuracyCmS))
        sink.u16(uint16(record.bearingCentiDeg))
        sink.u16(uint16(record.bearingAccuracyCentiDeg))
        sink.u8(if (record.simulated) JournalFormat.fixFlagSimulated else 0)
      }
      is PressureSample -> sink.u32(record.pascals.coerceIn(0, JournalFormat.maxUInt32))
      is StepSample -> sink.u32(record.count.coerceIn(0, JournalFormat.maxUInt32))
      is HeartRateSample -> {
        sink.u16(record.bpm.coerceIn(0, 0xFFFF))
        sink.u8(record.contact.code)
        sink.u16(record.rrInterval?.coerceIn(1, 0xFFFF) ?: 0)
      }
      is Mark -> sink.u8(record.kind.code)
    }
  }

  private fun int32(value: Int?): Int = value ?: JournalFormat.absentInt32

  private fun uint16(value: Int?): Int = value?.coerceIn(0, JournalFormat.maxUInt16) ?: JournalFormat.absentUInt16

  companion object {
    /** Creates the journal file, which must not exist yet, and writes its header. */
    fun create(path: File, header: JournalHeader): JournalWriter {
      path.parentFile?.mkdirs()
      if (!path.createNewFile()) throw IOException("Journal already exists: $path")
      val file = RandomAccessFile(path, "rw")
      try {
        val bytes = ByteBuffer.wrap(header.encode())
        while (bytes.hasRemaining()) file.channel.write(bytes)
        file.channel.force(true)
      } catch (error: IOException) {
        file.close()
        path.delete()
        throw error
      }
      return JournalWriter(file, header, 0, RecordType.newClockArray())
    }

    /**
     * Reopens a journal after a process restart, cutting any torn or invalid tail so new batches stay readable.
     * A stopped journal is only reopened when [afterStop] is set, for a recording resumed from its stop summary.
     */
    fun resume(path: File, afterStop: Boolean = false): ResumedJournal {
      val file = RandomAccessFile(path, "rw")
      try {
        val length = file.length()
        if (length > Int.MAX_VALUE) throw JournalFormatException("Journal too large")
        val bytes = ByteArray(length.toInt())
        file.readFully(bytes)
        val tail = JournalScanner.scan(bytes)
        if (tail.stopped && !afterStop) throw JournalFormatException("Journal already stopped")
        file.channel.truncate(tail.validLength.toLong())
        file.channel.position(tail.validLength.toLong())
        file.channel.force(true)
        return ResumedJournal(JournalWriter(file, tail.header, tail.nextSequence, tail.lastT), tail.paused, tail.stopped, tail.lastT.max(), tail.lastStepCount)
      } catch (error: IOException) {
        file.close()
        throw error
      }
    }
  }
}

internal data class JournalTail(
  val header: JournalHeader,
  val validLength: Int,
  val nextSequence: Long,
  /** Last `t` per record type code. */
  val lastT: LongArray,
  val paused: Boolean,
  val stopped: Boolean,
  val lastStepCount: Long,
)

/** Finds the end of the last batch the strict reader accepts, with the state needed to keep appending after it. */
internal object JournalScanner {
  private val markCodes = MarkKind.entries.associateBy { it.code }

  fun scan(bytes: ByteArray): JournalTail {
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    val header = JournalHeader.decode(buffer)
    val lastT = RecordType.newClockArray()
    var validLength = buffer.position()
    var sequence = 0L
    var paused = false
    var stopped = false
    var stepCount = 0L
    while (true) {
      val start = validLength
      if (bytes.size - start < JournalFormat.batchPrefixBytes + JournalFormat.batchSuffixBytes) break
      val length = buffer.getInt(start).toLong() and JournalFormat.maxUInt32
      val end = start + JournalFormat.batchPrefixBytes + length
      if (length == 0L || end + JournalFormat.batchSuffixBytes > bytes.size) break
      if ((buffer.getInt(start + 4).toLong() and JournalFormat.maxUInt32) != sequence) break
      val crc = CRC32().apply { update(bytes, start, (end - start).toInt()) }.value
      if (crc != buffer.getInt(end.toInt()).toLong() and JournalFormat.maxUInt32) break
      val batchT = lastT.copyOf()
      var batchPaused = paused
      var batchStopped = stopped
      var batchStepCount = stepCount
      var offset = start + JournalFormat.batchPrefixBytes
      var valid = true
      while (valid && offset < end) {
        val type = RecordType.of(bytes[offset].toInt() and 0xFF)
        if (type == null || offset + type.size > end) {
          valid = false
          break
        }
        val t = buffer.getInt(offset + 1).toLong() and JournalFormat.maxUInt32
        valid = t >= batchT[type.code] && when (type) {
          RecordType.FIX -> {
            val latitude = buffer.getInt(offset + 9)
            val longitude = buffer.getInt(offset + 13)
            val flags = bytes[offset + 37].toInt() and 0xFF
            latitude in -JournalFormat.maxLatitudeE7..JournalFormat.maxLatitudeE7 &&
              longitude in -JournalFormat.maxLongitudeE7..JournalFormat.maxLongitudeE7 &&
              flags and JournalFormat.fixFlagSimulated.inv() == 0
          }
          RecordType.HEART_RATE -> (bytes[offset + 7].toInt() and 0xFF) <= 2
          RecordType.MARK -> {
            val kind = markCodes[bytes[offset + 5].toInt() and 0xFF]
            when (kind) {
              MarkKind.PAUSE -> batchPaused = true
              MarkKind.RESUME -> batchPaused = false
              MarkKind.STOP -> batchStopped = true
              MarkKind.START -> {
                batchStopped = false
                batchPaused = false
              }
              MarkKind.LAP, null -> Unit
            }
            kind != null
          }
          RecordType.STEPS -> {
            batchStepCount = buffer.getInt(offset + 5).toLong() and JournalFormat.maxUInt32
            true
          }
          RecordType.PRESSURE -> true
        }
        batchT[type.code] = t
        offset += type.size
      }
      if (!valid) break
      batchT.copyInto(lastT)
      paused = batchPaused
      stopped = batchStopped
      stepCount = batchStepCount
      sequence += 1
      validLength = (end + JournalFormat.batchSuffixBytes).toInt()
    }
    return JournalTail(header, validLength, sequence, lastT, paused, stopped, stepCount)
  }
}
