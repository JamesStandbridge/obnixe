package app.obnixe.tracker.journal

/** Byte layout of the raw journal `.ojr` (annex C, little-endian, IEEE CRC-32). */
object JournalFormat {
  val magic = byteArrayOf('O'.code.toByte(), 'J'.code.toByte(), 'R'.code.toByte(), 'N'.code.toByte())
  const val version = 1
  const val platformAndroid = 1

  /** `length u32` and `sequence u32` before the records, `crc32 u32` after them. */
  const val batchPrefixBytes = 8
  const val batchSuffixBytes = 4

  const val absentInt32 = Int.MIN_VALUE
  const val absentUInt16 = 0xFFFF
  const val maxUInt16 = 0xFFFE
  const val maxUInt32 = 0xFFFF_FFFFL

  const val fixFlagSimulated = 0x01

  const val maxLatitudeE7 = 900_000_000
  const val maxLongitudeE7 = 1_800_000_000
}

enum class RecordType(val code: Int, val size: Int) {
  FIX(1, 38),
  PRESSURE(2, 9),
  STEPS(3, 9),
  HEART_RATE(4, 10),
  MARK(5, 6);

  companion object {
    private val byCode = entries.associateBy { it.code }

    fun of(code: Int): RecordType? = byCode[code]

    /** Last `t` of each stream, indexed by record type code. */
    fun newClockArray() = LongArray(entries.maxOf { it.code } + 1)
  }
}
