package app.obnixe.tracker.location

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class GpxReaderTest {
  private fun read(xml: String) = GpxReader.read(xml.byteInputStream())

  @Test
  fun `track points keep their coordinates, elevation and time`() {
    val points = read(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
        <metadata><time>2020-01-01T00:00:00Z</time></metadata>
        <trk><trkseg>
          <trkpt lat="45.8326412" lon="6.8652087"><ele>1042.1</ele><time>2026-03-12T07:41:05Z</time></trkpt>
          <trkpt lat="-33.9" lon="-70.25"><extensions><time>2000-01-01T00:00:00Z</time></extensions></trkpt>
        </trkseg></trk>
      </gpx>
      """.trimIndent(),
    )
    assertEquals(
      listOf(
        GpxPoint(458_326_412, 68_652_087, 1_042_100, 1_773_301_265_000L),
        GpxPoint(-339_000_000, -702_500_000, null, null),
      ),
      points,
    )
  }

  @Test
  fun `route points are read when there is no track`() {
    val points = read("""<gpx><rte><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte></gpx>""")
    assertEquals(listOf(GpxPoint(10_000_000, 20_000_000, null, null), GpxPoint(30_000_000, 40_000_000, null, null)), points)
  }

  @Test
  fun `a point without coordinates is refused`() {
    assertThrows(GpxFormatException::class.java) { read("""<gpx><trk><trkseg><trkpt lat="1"/></trkseg></trk></gpx>""") }
  }

  @Test
  fun `ISO instants honour fractions and offsets`() {
    assertEquals(1_773_301_265_250L, GpxReader.parseIsoInstant("2026-03-12T07:41:05.250Z"))
    assertEquals(1_773_301_265_000L, GpxReader.parseIsoInstant("2026-03-12T09:41:05+02:00"))
    assertEquals(1_773_301_265_000L, GpxReader.parseIsoInstant("2026-03-12T02:41:05-0500"))
    assertEquals(951_782_400_000L, GpxReader.parseIsoInstant("2000-02-29T00:00:00"))
    assertEquals(-86_400_000L, GpxReader.parseIsoInstant("1969-12-31T00:00:00Z"))
    assertNull(GpxReader.parseIsoInstant("12 March 2026"))
  }

  @Test
  fun `replay offsets follow the recorded times and never go back`() {
    val points = listOf(
      GpxPoint(0, 0, null, 1_000_000L),
      GpxPoint(0, 0, null, 1_003_000L),
      GpxPoint(0, 0, null, 1_002_000L),
      GpxPoint(0, 0, null, null),
      GpxPoint(0, 0, null, 1_010_000L),
    )
    assertArrayEquals(longArrayOf(0, 3_000, 3_000, 4_000, 10_000), replayOffsets(points))
  }

  @Test
  fun `untimed tracks replay one point per second`() {
    assertArrayEquals(longArrayOf(0, 1_000, 2_000), replayOffsets(List(3) { GpxPoint(0, 0, null, null) }))
    assertArrayEquals(longArrayOf(), replayOffsets(emptyList()))
  }
}
