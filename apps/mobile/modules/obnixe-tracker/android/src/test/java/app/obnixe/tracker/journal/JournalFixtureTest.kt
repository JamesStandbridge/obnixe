package app.obnixe.tracker.journal

import app.obnixe.tracker.Fix
import app.obnixe.tracker.HeartRateContact
import app.obnixe.tracker.HeartRateSample
import app.obnixe.tracker.Mark
import app.obnixe.tracker.MarkKind
import app.obnixe.tracker.PressureSample
import app.obnixe.tracker.Sample
import app.obnixe.tracker.StepSample
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Writes the journal fixture of `packages/core/test/fixtures/journal`, which the TypeScript reader test reads back
 * against the expected JSON. `OBNIXE_UPDATE_FIXTURES=1` regenerates both files instead of comparing them.
 */
class JournalFixtureTest {
  private val header = JournalHeader(
    sessionId = "019abc12-3456-7def-8123-456789abcdef",
    startedAt = 1_795_678_200_000L,
    monotonicOriginNs = 987_654_321_012_345_678L,
    platform = JournalFormat.platformAndroid,
    device = "Google Pixel 9 Pro · Android 16",
  )

  private val fix = Fix(
    t = 1_000,
    fixAgeMs = 180,
    latitudeE7 = 458_326_412,
    longitudeE7 = 68_652_087,
    altitudeEllipsoidMm = 1_092_400,
    altitudeMslMm = 1_042_100,
    horizontalAccuracyDm = 36,
    verticalAccuracyDm = 51,
    speedCmS = 298,
    speedAccuracyCmS = 42,
    bearingCentiDeg = 27_050,
    bearingAccuracyCentiDeg = 1_150,
    simulated = false,
  )

  private class Step(val samples: List<Sample>, val mark: Mark?)

  private val steps = listOf(
    Step(emptyList(), Mark(0, MarkKind.START)),
    Step(
      listOf(
        fix,
        PressureSample(1_020, 89_412),
        StepSample(1_100, 2),
        HeartRateSample(1_150, 142, HeartRateContact.CONTACT, 433),
        fix.copy(t = 2_000, fixAgeMs = -4, latitudeE7 = 458_326_610, longitudeE7 = 68_652_301, speedCmS = 0xFFFE),
        HeartRateSample(2_150, 143, HeartRateContact.ABSENT, null),
      ),
      null,
    ),
    Step(listOf(StepSample(2_900, 5), HeartRateSample(3_000, 141, HeartRateContact.UNSUPPORTED, 1_024)), Mark(3_100, MarkKind.PAUSE)),
    Step(listOf(PressureSample(9_000, 89_430)), Mark(9_200, MarkKind.RESUME)),
    Step(
      listOf(
        Fix(
          t = 10_000,
          fixAgeMs = 0,
          latitudeE7 = -900_000_000,
          longitudeE7 = 1_800_000_000,
          altitudeEllipsoidMm = -430_500,
          altitudeMslMm = null,
          horizontalAccuracyDm = 50,
          verticalAccuracyDm = null,
          speedCmS = null,
          speedAccuracyCmS = null,
          bearingCentiDeg = null,
          bearingAccuracyCentiDeg = null,
          simulated = true,
        ),
        StepSample(10_100, 19),
      ),
      Mark(10_500, MarkKind.LAP),
    ),
    Step(listOf(PressureSample(11_000, 89_401)), Mark(11_000, MarkKind.STOP)),
  )

  @Test
  fun `writer output matches the committed fixture`() {
    val directory = Files.createTempDirectory("fixture").toFile()
    try {
      val path = File(directory, "android-v1.ojr")
      val batches = JournalWriter.create(path, header).use { writer ->
        steps.map { step ->
          step.samples.forEach { check(writer.append(it)) }
          checkNotNull(writer.flush(step.mark))
        }
      }
      val bytes = path.readBytes()
      val expected = expectedJson(batches, bytes.size)
      val fixtures = File(checkNotNull(System.getProperty("obnixe.journalFixtures")))
      val fixtureBytes = File(fixtures, "android-v1.ojr")
      val fixtureJson = File(fixtures, "android-v1.json")
      if (System.getProperty("obnixe.updateFixtures") == "1") {
        fixtures.mkdirs()
        fixtureBytes.writeBytes(bytes)
        fixtureJson.writeText(expected)
      }
      assertArrayEquals(fixtureBytes.readBytes(), bytes)
      assertEquals(fixtureJson.readText(), expected)
    } finally {
      directory.deleteRecursively()
    }
  }

  /** What `readJournal` of `packages/core` returns for the fixture, with the `bigint` origin as a decimal string. */
  private fun expectedJson(batches: List<JournalBatch>, length: Int): String = Json.encode(
    mapOf(
      "header" to mapOf(
        "sessionId" to header.sessionId,
        "startedAt" to header.startedAt,
        "monotonicOriginNs" to header.monotonicOriginNs.toString(),
        "platform" to "android",
        "device" to header.device,
      ),
      "samples" to batches.flatMap { batch -> batch.samples.map(Sample::toBridge) },
      "marks" to batches.mapNotNull { batch -> batch.mark?.let { mapOf("kind" to it.kind.wire, "t" to it.t) } },
      "lastSequence" to batches.last().sequence,
      "validLength" to length,
    ),
  )
}

/** Minimal JSON encoder for the fixture, formatted like `JSON.stringify(value, null, 2)`. */
private object Json {
  fun encode(value: Any?): String = StringBuilder().also { write(it, value, "") }.append('\n').toString()

  private fun write(out: StringBuilder, value: Any?, indent: String) {
    when (value) {
      null -> out.append("null")
      is String -> string(out, value)
      is Boolean -> out.append(value)
      is Double -> if (value % 1.0 == 0.0) out.append(value.toLong()) else out.append(value)
      is Number -> out.append(value.toLong())
      is Map<*, *> -> entries(out, value.entries.toList(), indent, '{', '}') { entry, inner ->
        string(out, entry.key as String)
        out.append(": ")
        write(out, entry.value, inner)
      }
      is List<*> -> entries(out, value, indent, '[', ']') { item, inner -> write(out, item, inner) }
      else -> error("Unsupported JSON value: $value")
    }
  }

  private fun <T> entries(out: StringBuilder, items: List<T>, indent: String, open: Char, close: Char, item: (T, String) -> Unit) {
    if (items.isEmpty()) {
      out.append(open).append(close)
      return
    }
    val inner = "$indent  "
    out.append(open)
    items.forEachIndexed { index, value ->
      out.append(if (index == 0) "\n" else ",\n").append(inner)
      item(value, inner)
    }
    out.append('\n').append(indent).append(close)
  }

  private fun string(out: StringBuilder, value: String) {
    out.append('"')
    for (char in value) {
      when {
        char == '"' -> out.append("\\\"")
        char == '\\' -> out.append("\\\\")
        char < ' ' -> out.append("\\u%04x".format(char.code))
        else -> out.append(char)
      }
    }
    out.append('"')
  }
}
