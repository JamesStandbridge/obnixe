package app.obnixe.tracker.journal

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

class JournalFormatException(message: String) : IOException(message)

data class JournalHeader(
  /** Canonical lowercase UUID of the session. */
  val sessionId: String,
  /** `t0`: EpochMs of the time origin. */
  val startedAt: Long,
  /** `m0`: monotonic clock reading, in ns, taken together with `t0`. */
  val monotonicOriginNs: Long,
  val platform: Int,
  val device: String,
) {
  fun encode(): ByteArray {
    val device = truncatedUtf8(device, 255)
    val sink = ByteSink(64 + device.size)
    sink.bytes(JournalFormat.magic)
    sink.u8(JournalFormat.version)
    sink.bytes(uuidBytes(sessionId))
    sink.i64(startedAt)
    sink.i64(monotonicOriginNs)
    sink.u8(platform)
    sink.u8(device.size)
    sink.bytes(device)
    sink.u32(sink.crc32(0, sink.size))
    return sink.toByteArray()
  }

  companion object {
    /** Reads the header at the buffer's position and leaves the position right after it. */
    fun decode(buffer: ByteBuffer): JournalHeader {
      val start = buffer.position()
      val view = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
      fun need(bytes: Int) {
        if (view.remaining() < bytes) throw JournalFormatException("Truncated journal header")
      }
      need(4 + 1 + 16 + 8 + 8 + 1 + 1)
      val magic = ByteArray(4).also(view::get)
      if (!magic.contentEquals(JournalFormat.magic)) throw JournalFormatException("Not a raw journal")
      val version = view.get().toInt() and 0xFF
      if (version != JournalFormat.version) throw JournalFormatException("Unsupported journal version $version")
      val session = ByteArray(16).also(view::get)
      val startedAt = view.long
      val monotonicOriginNs = view.long
      val platform = view.get().toInt() and 0xFF
      val deviceLength = view.get().toInt() and 0xFF
      need(deviceLength + 4)
      val device = ByteArray(deviceLength).also(view::get)
      val end = view.position()
      val crc = CRC32().apply { update(buffer.array(), buffer.arrayOffset() + start, end - start) }.value
      if (crc != view.int.toLong() and JournalFormat.maxUInt32) throw JournalFormatException("Journal header checksum mismatch")
      buffer.position(view.position())
      return JournalHeader(uuidString(session), startedAt, monotonicOriginNs, platform, String(device, Charsets.UTF_8))
    }

    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun isSessionId(value: String): Boolean = uuidPattern.matches(value)

    private fun uuidBytes(sessionId: String): ByteArray {
      require(isSessionId(sessionId)) { "Session id must be a UUID: $sessionId" }
      val hex = sessionId.replace("-", "")
      return ByteArray(16) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }

    private fun uuidString(bytes: ByteArray): String {
      val hex = bytes.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
      return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }

    private fun truncatedUtf8(value: String, maxBytes: Int): ByteArray {
      val bytes = value.toByteArray(Charsets.UTF_8)
      if (bytes.size <= maxBytes) return bytes
      var end = maxBytes
      while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end -= 1
      return bytes.copyOf(end)
    }
  }
}
