package app.obnixe.tracker.journal

import java.util.zip.CRC32

/** Growable little-endian byte buffer. */
internal class ByteSink(initialCapacity: Int) {
  var array = ByteArray(initialCapacity)
    private set
  var size = 0
    private set

  private fun reserve(bytes: Int) {
    if (size + bytes <= array.size) return
    array = array.copyOf(maxOf(array.size * 2, size + bytes))
  }

  fun u8(value: Int) {
    reserve(1)
    array[size++] = value.toByte()
  }

  fun u16(value: Int) {
    reserve(2)
    array[size++] = value.toByte()
    array[size++] = (value ushr 8).toByte()
  }

  fun i32(value: Int) {
    reserve(4)
    array[size++] = value.toByte()
    array[size++] = (value ushr 8).toByte()
    array[size++] = (value ushr 16).toByte()
    array[size++] = (value ushr 24).toByte()
  }

  fun u32(value: Long) = i32(value.toInt())

  fun i64(value: Long) {
    i32(value.toInt())
    i32((value ushr 32).toInt())
  }

  fun bytes(value: ByteArray) {
    reserve(value.size)
    value.copyInto(array, size)
    size += value.size
  }

  fun setU32(offset: Int, value: Long) {
    val end = size
    size = offset
    u32(value)
    size = end
  }

  fun crc32(offset: Int, length: Int): Long = CRC32().apply { update(array, offset, length) }.value

  fun truncate(length: Int) {
    size = length
  }

  fun toByteArray(): ByteArray = array.copyOf(size)
}
