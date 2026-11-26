package app.obnixe.tracker

/** Android 16 replaces a `ProgressStyle` of more than 10 segments with a single segment of the default color. */
const val maxProgressSegments = 10

/**
 * `REC-074`: fits the steps of a guided workout to the segments `ProgressStyle` draws, keeping the summed length so the
 * progress value still applies. Over the limit, each recovery joins the work step before it, one segment per repetition;
 * still over, the shortest pair of neighbours alike is merged, then the shortest pair, highlighted when work makes at
 * least half of it.
 */
fun fitProgressSegments(segments: List<TrackerProgressSegment>, limit: Int = maxProgressSegments): List<TrackerProgressSegment> {
  if (segments.size <= limit) return segments
  val fitted = mutableListOf<TrackerProgressSegment>()
  var joinable = false
  for (segment in segments) {
    if (joinable && !segment.highlighted) {
      val work = fitted.removeAt(fitted.lastIndex)
      fitted.add(TrackerProgressSegment(work.length + segment.length, true))
      joinable = false
    } else {
      fitted.add(segment)
      joinable = segment.highlighted
    }
  }
  while (fitted.size > limit) {
    val pairs = (1 until fitted.size).toList()
    val alike = pairs.filter { fitted[it - 1].highlighted == fitted[it].highlighted }
    val index = alike.ifEmpty { pairs }.minBy { fitted[it - 1].length + fitted[it].length }
    val first = fitted[index - 1]
    val second = fitted[index]
    val length = first.length + second.length
    val work = listOf(first, second).filter { it.highlighted }.sumOf { it.length }
    fitted[index - 1] = TrackerProgressSegment(length, 2 * work >= length)
    fitted.removeAt(index)
  }
  return fitted
}
