package app.obnixe.tracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class NotificationProgressTest {
  private val warmUp = TrackerProgressSegment(100, false)
  private val work = TrackerProgressSegment(100, true)
  private val recovery = TrackerProgressSegment(100, false)
  private val coolDown = TrackerProgressSegment(100, false)

  private fun intervals(repetitions: Int): List<TrackerProgressSegment> =
    listOf(warmUp) + List(repetitions) { listOf(work, recovery) }.flatten() + listOf(coolDown)

  @Test
  fun `REC-074 a workout within the platform limit keeps one segment per step`() {
    val steps = intervals(4)
    assertSame(steps, fitProgressSegments(steps))
  }

  @Test
  fun `REC-074 each recovery joins its work step when the steps exceed the limit`() {
    val fitted = fitProgressSegments(intervals(8))
    assertEquals(listOf(warmUp) + List(8) { TrackerProgressSegment(200, true) } + listOf(coolDown), fitted)
  }

  @Test
  fun `REC-074 fitting keeps the summed length the progress value is counted on`() {
    for (repetitions in 1..30) {
      val steps = intervals(repetitions)
      val fitted = fitProgressSegments(steps)
      assertEquals(steps.sumOf { it.length }, fitted.sumOf { it.length })
      assertEquals(true, fitted.size <= maxProgressSegments)
    }
  }

  @Test
  fun `REC-074 repetitions beyond the limit are grouped and stay highlighted`() {
    val fitted = fitProgressSegments(intervals(12))
    assertEquals(maxProgressSegments, fitted.size)
    assertEquals(TrackerProgressSegment(100, false), fitted.first())
    assertEquals(TrackerProgressSegment(100, false), fitted.last())
    assertEquals(List(8) { true }, fitted.subList(1, 9).map { it.highlighted })
  }

  @Test
  fun `REC-074 neighbours alike are merged before a work step meets a rest`() {
    val fitted = fitProgressSegments(List(6) { work } + List(6) { recovery })
    assertEquals(List(5) { true } + List(5) { false }, fitted.map { it.highlighted })
  }

  @Test
  fun `REC-074 alternating segments without any alike pair are merged on the share of work`() {
    val steps = listOf(recovery, work, recovery, recovery, work, recovery, recovery)
    val fitted = fitProgressSegments(steps, limit = 3)
    assertEquals(listOf(TrackerProgressSegment(300, true), TrackerProgressSegment(300, true), TrackerProgressSegment(100, false)), fitted)
  }
}
