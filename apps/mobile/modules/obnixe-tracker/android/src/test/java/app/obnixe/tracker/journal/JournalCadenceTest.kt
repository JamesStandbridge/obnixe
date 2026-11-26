package app.obnixe.tracker.journal

import app.obnixe.tracker.CadenceSample
import app.obnixe.tracker.Fix
import app.obnixe.tracker.HeartRateContact
import app.obnixe.tracker.HeartRateSample
import app.obnixe.tracker.Mark
import app.obnixe.tracker.MarkKind
import app.obnixe.tracker.PowerSample
import app.obnixe.tracker.PressureSample
import app.obnixe.tracker.Sample
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class JournalCadenceTest {
  private lateinit var directory: File

  private val header = JournalHeader(
    sessionId = "3f2b8c1e-7a4d-4e9b-9c21-5d6e7f809a1b",
    startedAt = 1_795_000_000_123L,
    monotonicOriginNs = 98_765_432_101_234L,
    platform = JournalFormat.platformAndroid,
    device = "Google Pixel 9 Pro",
  )

  private fun fix(t: Long) = Fix(t, 250, 458_326_000 + t.toInt(), -68_652_000, 1_042_300, 1_090_100, 38, 52, 312, 40, 27_050, 1_200, false)

  @Before
  fun setUp() {
    directory = Files.createTempDirectory("cadence").toFile()
  }

  @After
  fun tearDown() {
    directory.deleteRecursively()
  }

  @Test
  fun `REC-080 waits at most the write interval and restarts it on every write`() {
    val cadence = JournalCadence(5_000, 0)
    assertFalse(cadence.writeDue(4_999))
    assertTrue(cadence.writeDue(5_000))
    assertEquals(1_000, cadence.nextTickDelayMs(1_000, 1_000))
    assertEquals(500, cadence.nextTickDelayMs(4_500, 1_000))
    assertEquals(5_000, cadence.nextTickDelayMs(0, 5_000))
    cadence.wrote(4_200)
    assertFalse(cadence.writeDue(9_000))
    assertTrue(cadence.writeDue(9_200))
    assertEquals(0, cadence.nextTickDelayMs(9_700, 1_000))
  }

  @Test
  fun `PRF-051 an hour with the screen on delivers every second and writes at most 720 batches`() {
    val writer = JournalWriter.create(File(directory, "session.ojr"), header)
    val cadence = JournalCadence(5_000, 0)
    val arrivedAt = HashMap<Sample, Long>()
    val delivered = ArrayList<Sample>()
    val batches = ArrayList<JournalBatch>()
    var maxDeliveryWaitMs = 0L
    var maxWriteWaitMs = 0L
    var now = 0L
    var nextSampleAt = 0L
    var nextTickAt = cadence.nextTickDelayMs(0, 1_000)
    val hourMs = 3_600_000L
    writer.use {
      while (now < hourMs) {
        now = minOf(nextSampleAt, nextTickAt)
        if (now == nextSampleAt) {
          for (sample in listOf(fix(now), PressureSample(now, 101_325), HeartRateSample(now, 150, HeartRateContact.CONTACT, null))) {
            assertTrue(writer.append(sample))
            arrivedAt[sample] = now
          }
          if (now == 1_800_000L + 300L) {
            val lap = checkNotNull(writer.flush(Mark(now, MarkKind.LAP)))
            cadence.wrote(now)
            batches += lap
            delivered += lap.lastPart().samples
          }
          nextSampleAt += 1_000 + (now / 1_000 % 3) * 100
        }
        if (now == nextTickAt) {
          val part: SamplePart?
          if (cadence.writeDue(now)) {
            val batch = writer.flush()
            cadence.wrote(now)
            part = batch?.lastPart()
            if (batch != null) {
              batches += batch
              batch.samples.forEach { maxWriteWaitMs = maxOf(maxWriteWaitMs, now - arrivedAt.getValue(it)) }
            }
          } else {
            part = writer.takePart()
          }
          part?.samples?.forEach { sample ->
            delivered += sample
            maxDeliveryWaitMs = maxOf(maxDeliveryWaitMs, now - arrivedAt.getValue(sample))
          }
          nextTickAt = now + cadence.nextTickDelayMs(now, 1_000)
        }
      }
    }
    assertTrue("${batches.size} batches", batches.size <= 720)
    assertTrue(batches.size >= 700)
    assertTrue("$maxDeliveryWaitMs ms before delivery", maxDeliveryWaitMs <= 1_000)
    assertTrue("$maxWriteWaitMs ms before storage", maxWriteWaitMs <= 5_000)
    assertEquals(batches.flatMap { it.samples }, delivered)
  }

  @Test
  fun `parts of a batch follow each other and the last one carries the rest`() {
    JournalWriter.create(File(directory, "session.ojr"), header).use { writer ->
      assertNull(writer.takePart())
      writer.append(fix(1_000))
      writer.append(PressureSample(1_000, 101_325))
      assertEquals(SamplePart(0, 0, listOf(fix(1_000), PressureSample(1_000, 101_325)), end = false), writer.takePart())
      assertNull(writer.takePart())
      writer.append(fix(2_000))
      assertEquals(SamplePart(0, 2, listOf(fix(2_000)), end = false), writer.takePart())
      writer.append(fix(3_000))
      val batch = checkNotNull(writer.flush(Mark(3_100, MarkKind.PAUSE)))
      assertEquals(3, batch.delivered)
      assertEquals(SamplePart(0, 3, listOf(fix(3_000)), end = true), batch.lastPart())
      writer.append(fix(4_000))
      assertEquals(SamplePart(1, 0, listOf(fix(4_000)), end = false), writer.takePart())
    }
  }

  @Test
  fun `power and cadence records go out in parts and reach storage with the next batch (PRF-051)`() {
    val file = File(directory, "session.ojr")
    JournalWriter.create(file, header).use { writer ->
      writer.append(PowerSample(1_000, 240, 88))
      writer.append(CadenceSample(1_050, 90))
      assertEquals(SamplePart(0, 0, listOf(PowerSample(1_000, 240, 88), CadenceSample(1_050, 90)), end = false), writer.takePart())
      val written = file.length()
      writer.append(PowerSample(1_250, 251, null))
      assertEquals(written, file.length())
      val batch = checkNotNull(writer.flush())
      assertEquals(SamplePart(0, 2, listOf(PowerSample(1_250, 251, null)), end = true), batch.lastPart())
    }
    assertEquals(1L, JournalScanner.scan(file.readBytes()).nextSequence)
  }
}
