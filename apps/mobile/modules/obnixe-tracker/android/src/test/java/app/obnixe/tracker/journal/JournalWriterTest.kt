package app.obnixe.tracker.journal

import app.obnixe.tracker.Fix
import app.obnixe.tracker.HeartRateContact
import app.obnixe.tracker.HeartRateSample
import app.obnixe.tracker.Mark
import app.obnixe.tracker.MarkKind
import app.obnixe.tracker.PressureSample
import app.obnixe.tracker.StepSample
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.util.zip.CRC32
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class JournalWriterTest {
  private lateinit var directory: File
  private lateinit var path: File

  private val header = JournalHeader(
    sessionId = "3f2b8c1e-7a4d-4e9b-9c21-5d6e7f809a1b",
    startedAt = 1_795_000_000_123L,
    monotonicOriginNs = 98_765_432_101_234L,
    platform = JournalFormat.platformAndroid,
    device = "Google Pixel 9 Pro",
  )

  private val fix = Fix(
    t = 1_000,
    fixAgeMs = 250,
    latitudeE7 = 458_326_000,
    longitudeE7 = -68_652_000,
    altitudeEllipsoidMm = 1_042_300,
    altitudeMslMm = 1_090_100,
    horizontalAccuracyDm = 38,
    verticalAccuracyDm = 52,
    speedCmS = 312,
    speedAccuracyCmS = 40,
    bearingCentiDeg = 27_050,
    bearingAccuracyCentiDeg = 1_200,
    simulated = false,
  )

  @Before
  fun setUp() {
    directory = Files.createTempDirectory("journal").toFile()
    path = File(directory, "session.ojr")
  }

  @After
  fun tearDown() {
    directory.deleteRecursively()
  }

  private fun le(bytes: ByteArray): ByteBuffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

  private fun crc(bytes: ByteArray, from: Int, to: Int): Int = CRC32().apply { update(bytes, from, to - from) }.value.toInt()

  private fun headerLength() = header.encode().size

  @Test
  fun `header follows annex C byte for byte`() {
    val bytes = header.encode()
    val buffer = le(bytes)
    assertEquals(4 + 1 + 16 + 8 + 8 + 1 + 1 + 18 + 4, bytes.size)
    assertArrayEquals("OJRN".toByteArray(), bytes.copyOfRange(0, 4))
    assertEquals(1, bytes[4].toInt())
    assertEquals(0x3f.toByte(), bytes[5])
    assertEquals(0x1b.toByte(), bytes[20])
    assertEquals(header.startedAt, buffer.getLong(21))
    assertEquals(header.monotonicOriginNs, buffer.getLong(29))
    assertEquals(1, bytes[37].toInt())
    assertEquals(18, bytes[38].toInt())
    assertEquals("Google Pixel 9 Pro", String(bytes, 39, 18, Charsets.UTF_8))
    assertEquals(crc(bytes, 0, 57), buffer.getInt(57))
    assertEquals(header, JournalHeader.decode(ByteBuffer.wrap(bytes)))
  }

  @Test
  fun `header decoding rejects a damaged header`() {
    val bytes = header.encode()
    bytes[25] = (bytes[25] + 1).toByte()
    assertThrows(JournalFormatException::class.java) { JournalHeader.decode(ByteBuffer.wrap(bytes)) }
  }

  @Test
  fun `long device names are cut at a character boundary`() {
    val device = "é".repeat(200)
    val bytes = header.copy(device = device).encode()
    assertEquals(254, bytes[38].toInt() and 0xFF)
    assertEquals("é".repeat(127), JournalHeader.decode(ByteBuffer.wrap(bytes)).device)
  }

  @Test
  fun `a batch is framed by its length, sequence and checksum`() {
    JournalWriter.create(path, header).use { writer ->
      assertTrue(writer.append(PressureSample(500, 101_325)))
      val batch = writer.flush(Mark(600, MarkKind.LAP))!!
      assertEquals(0L, batch.sequence)
      assertEquals(listOf(PressureSample(500, 101_325)), batch.samples)
      assertEquals(Mark(600, MarkKind.LAP), batch.mark)
    }
    val bytes = path.readBytes()
    val buffer = le(bytes)
    val start = headerLength()
    assertEquals(start + 8 + 9 + 6 + 4, bytes.size)
    assertEquals(15, buffer.getInt(start))
    assertEquals(0, buffer.getInt(start + 4))
    assertEquals(2, bytes[start + 8].toInt())
    assertEquals(500, buffer.getInt(start + 9))
    assertEquals(101_325, buffer.getInt(start + 13))
    assertEquals(5, bytes[start + 17].toInt())
    assertEquals(600, buffer.getInt(start + 18))
    assertEquals(3, bytes[start + 22].toInt())
    assertEquals(crc(bytes, start, start + 23), buffer.getInt(start + 23))
  }

  @Test
  fun `fix records hold every field at its offset`() {
    JournalWriter.create(path, header).use { writer ->
      writer.append(fix)
      writer.flush()
    }
    val bytes = path.readBytes()
    val at = headerLength() + 8
    val buffer = le(bytes)
    assertEquals(38, buffer.getInt(headerLength()))
    assertEquals(1, bytes[at].toInt())
    assertEquals(1_000, buffer.getInt(at + 1))
    assertEquals(250, buffer.getInt(at + 5))
    assertEquals(458_326_000, buffer.getInt(at + 9))
    assertEquals(-68_652_000, buffer.getInt(at + 13))
    assertEquals(1_042_300, buffer.getInt(at + 17))
    assertEquals(1_090_100, buffer.getInt(at + 21))
    assertEquals(38, buffer.getShort(at + 25).toInt())
    assertEquals(52, buffer.getShort(at + 27).toInt())
    assertEquals(312, buffer.getShort(at + 29).toInt())
    assertEquals(40, buffer.getShort(at + 31).toInt())
    assertEquals(27_050, buffer.getShort(at + 33).toInt() and 0xFFFF)
    assertEquals(1_200, buffer.getShort(at + 35).toInt())
    assertEquals(0, bytes[at + 37].toInt())
  }

  @Test
  fun `absent fix fields use the sentinels and present ones are clamped below them`() {
    JournalWriter.create(path, header).use { writer ->
      writer.append(
        fix.copy(
          altitudeEllipsoidMm = null,
          altitudeMslMm = null,
          horizontalAccuracyDm = 70_000,
          verticalAccuracyDm = null,
          speedCmS = 0xFFFF,
          speedAccuracyCmS = null,
          bearingCentiDeg = null,
          bearingAccuracyCentiDeg = -5,
          simulated = true,
        ),
      )
      writer.flush()
    }
    val bytes = path.readBytes()
    val at = headerLength() + 8
    val buffer = le(bytes)
    assertEquals(Int.MIN_VALUE, buffer.getInt(at + 17))
    assertEquals(Int.MIN_VALUE, buffer.getInt(at + 21))
    assertEquals(0xFFFE, buffer.getShort(at + 25).toInt() and 0xFFFF)
    assertEquals(0xFFFF, buffer.getShort(at + 27).toInt() and 0xFFFF)
    assertEquals(0xFFFE, buffer.getShort(at + 29).toInt() and 0xFFFF)
    assertEquals(0xFFFF, buffer.getShort(at + 31).toInt() and 0xFFFF)
    assertEquals(0xFFFF, buffer.getShort(at + 33).toInt() and 0xFFFF)
    assertEquals(0, buffer.getShort(at + 35).toInt())
    assertEquals(1, bytes[at + 37].toInt())
  }

  @Test
  fun `heart rate records encode contact and an absent RR interval as zero`() {
    JournalWriter.create(path, header).use { writer ->
      writer.append(HeartRateSample(100, 152, HeartRateContact.CONTACT, 402))
      writer.append(HeartRateSample(200, 151, HeartRateContact.UNSUPPORTED, null))
      writer.flush()
    }
    val bytes = path.readBytes()
    val at = headerLength() + 8
    val buffer = le(bytes)
    assertEquals(4, bytes[at].toInt())
    assertEquals(152, buffer.getShort(at + 5).toInt())
    assertEquals(1, bytes[at + 7].toInt())
    assertEquals(402, buffer.getShort(at + 8).toInt())
    assertEquals(2, bytes[at + 17].toInt())
    assertEquals(0, buffer.getShort(at + 18).toInt())
  }

  @Test
  fun `samples the strict reader would refuse are dropped`() {
    JournalWriter.create(path, header).use { writer ->
      assertTrue(writer.append(fix))
      assertFalse(writer.append(fix.copy(t = 999)))
      assertTrue(writer.append(PressureSample(10, 100_000)))
      assertTrue(writer.append(fix.copy(t = 1_000)))
      assertFalse(writer.append(fix.copy(t = 2_000, latitudeE7 = 900_000_001)))
      assertFalse(writer.append(fix.copy(t = 2_000, longitudeE7 = -1_800_000_001)))
      assertTrue(writer.append(fix.copy(t = 2_000, latitudeE7 = -900_000_000, longitudeE7 = 1_800_000_000)))
      assertFalse(writer.append(StepSample(-1, 3)))
      assertFalse(writer.append(StepSample(0x1_0000_0000L, 3)))
      assertEquals(4, writer.flush()!!.samples.size)
      assertFalse(writer.append(PressureSample(9, 100_000)))
    }
  }

  @Test
  fun `flushing nothing writes nothing and sequences count batches`() {
    JournalWriter.create(path, header).use { writer ->
      assertNull(writer.flush())
      assertEquals(0L, writer.flush(Mark(0, MarkKind.START))!!.sequence)
      writer.append(StepSample(1_000, 2))
      assertEquals(1L, writer.flush()!!.sequence)
      assertNull(writer.flush())
      assertEquals(2L, writer.nextSequence)
      assertEquals(0, writer.pendingBytes)
    }
    assertEquals(headerLength() + (8 + 6 + 4) + (8 + 9 + 4), path.length().toInt())
  }

  @Test
  fun `a mark never goes back in time`() {
    JournalWriter.create(path, header).use { writer ->
      writer.flush(Mark(5_000, MarkKind.PAUSE))
      assertEquals(Mark(5_000, MarkKind.RESUME), writer.flush(Mark(4_000, MarkKind.RESUME))!!.mark)
      assertEquals(Mark(5_000, MarkKind.LAP), writer.flush(Mark(-3, MarkKind.LAP))!!.mark)
    }
  }

  @Test
  fun `creating over an existing journal fails`() {
    JournalWriter.create(path, header).close()
    assertThrows(IOException::class.java) { JournalWriter.create(path, header) }
  }

  private fun writeSession(stop: Boolean): List<Int> {
    val ends = ArrayList<Int>()
    JournalWriter.create(path, header).use { writer ->
      ends += path.length().toInt()
      writer.flush(Mark(0, MarkKind.START))
      ends += path.length().toInt()
      writer.append(fix)
      writer.append(StepSample(1_200, 4))
      writer.flush()
      ends += path.length().toInt()
      writer.append(StepSample(2_200, 7))
      writer.flush(Mark(2_500, MarkKind.PAUSE))
      ends += path.length().toInt()
      if (stop) {
        writer.flush(Mark(2_600, MarkKind.STOP))
        ends += path.length().toInt()
      }
    }
    return ends
  }

  @Test
  fun `resuming cuts every torn tail back to the last complete batch`() {
    val ends = writeSession(stop = false)
    val complete = path.readBytes()
    for (length in ends.first()..complete.size) {
      path.writeBytes(complete.copyOf(length))
      val batches = ends.count { it <= length } - 1
      val resumed = JournalWriter.resume(path)
      resumed.writer.use { writer ->
        assertEquals(batches.toLong(), writer.nextSequence)
        assertEquals(header, writer.header)
        assertEquals(ends[batches].toLong(), path.length())
        assertEquals(batches >= 3, resumed.paused)
        assertEquals(if (batches >= 3) 7L else if (batches == 2) 4L else 0L, resumed.lastStepCount)
        writer.append(StepSample(3_000, 9))
        assertEquals(batches.toLong(), writer.flush()!!.sequence)
      }
      assertEquals(batches + 1L, JournalScanner.scan(path.readBytes()).nextSequence)
    }
  }

  @Test
  fun `resuming refuses a damaged header and a stopped journal`() {
    writeSession(stop = true)
    assertThrows(JournalFormatException::class.java) { JournalWriter.resume(path) }
    path.writeBytes(path.readBytes().copyOf(20))
    assertThrows(JournalFormatException::class.java) { JournalWriter.resume(path) }
  }

  @Test
  fun `scanning stops at a batch whose checksum does not match`() {
    val ends = writeSession(stop = false)
    val bytes = path.readBytes()
    bytes[ends[2] + 10] = (bytes[ends[2] + 10] + 1).toByte()
    val tail = JournalScanner.scan(bytes)
    assertEquals(ends[2], tail.validLength)
    assertEquals(2L, tail.nextSequence)
    assertFalse(tail.paused)
  }

  @Test
  fun `scanning stops at a batch the strict reader refuses despite a valid checksum`() {
    val ends = writeSession(stop = false)
    val bytes = path.readBytes()
    val markKind = ends[3] - 5
    bytes[markKind] = 4
    val buffer = le(bytes)
    buffer.putInt(ends[3] - 4, crc(bytes, ends[2], ends[3] - 4))
    val tail = JournalScanner.scan(bytes)
    assertEquals(ends[2], tail.validLength)
    assertEquals(4L, tail.lastStepCount)
  }
}
