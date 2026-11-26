package app.obnixe.tracker.location

import java.io.InputStream
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory

data class GpxPoint(val latitudeE7: Int, val longitudeE7: Int, val elevationMm: Int?, val timeMs: Long?)

/** Reads the track points (or route points) of a GPX file, in document order, for the replay source. */
object GpxReader {
  fun read(input: InputStream): List<GpxPoint> {
    val parser = XmlPullParserFactory.newInstance().apply { isNamespaceAware = true }.newPullParser()
    parser.setInput(input, null)
    val points = ArrayList<GpxPoint>()
    var latitude = 0.0
    var longitude = 0.0
    var elevation: Double? = null
    var time: Long? = null
    var pointDepth = -1
    var field: String? = null
    while (true) {
      when (parser.next()) {
        XmlPullParser.END_DOCUMENT -> return points
        XmlPullParser.START_TAG -> when (parser.name) {
          "trkpt", "rtept" -> {
            latitude = parser.getAttributeValue(null, "lat")?.toDoubleOrNull() ?: throw GpxFormatException("Point without latitude")
            longitude = parser.getAttributeValue(null, "lon")?.toDoubleOrNull() ?: throw GpxFormatException("Point without longitude")
            elevation = null
            time = null
            pointDepth = parser.depth
          }
          "ele", "time" -> field = if (pointDepth >= 0 && parser.depth == pointDepth + 1) parser.name else null
        }
        XmlPullParser.TEXT -> when (field) {
          "ele" -> elevation = parser.text.trim().toDoubleOrNull()
          "time" -> time = parseIsoInstant(parser.text.trim())
        }
        XmlPullParser.END_TAG -> when (parser.name) {
          "trkpt", "rtept" -> {
            points += GpxPoint(
              latitudeE7 = (latitude * 1e7).roundToLong().toInt(),
              longitudeE7 = (longitude * 1e7).roundToLong().toInt(),
              elevationMm = elevation?.let { (it * 1000).roundToInt() },
              timeMs = time,
            )
            pointDepth = -1
          }
          "ele", "time" -> field = null
        }
      }
    }
  }

  private val isoInstant = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$""")

  /** EpochMs of an ISO 8601 date-time as written in GPX (`2026-03-12T07:41:05.250Z`); null when malformed. */
  fun parseIsoInstant(value: String): Long? {
    val match = isoInstant.matchEntire(value) ?: return null
    val (year, month, day, hour, minute, second) = match.destructured
    val fraction = match.groupValues[7].takeIf { it.isNotEmpty() }?.let { (("0$it").toDouble() * 1000).roundToLong() } ?: 0L
    val zone = match.groupValues[8]
    val offsetMinutes = if (zone.isEmpty() || zone == "Z") 0 else {
      val digits = zone.substring(1).replace(":", "")
      val minutes = digits.substring(0, 2).toInt() * 60 + digits.substring(2, 4).toInt()
      if (zone[0] == '-') -minutes else minutes
    }
    val days = daysFromCivil(year.toInt(), month.toInt(), day.toInt())
    val seconds = days * 86_400 + hour.toLong() * 3600 + minute.toLong() * 60 + second.toLong() - offsetMinutes * 60L
    return seconds * 1000 + fraction
  }

  /** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm). */
  private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
    val y = (if (month <= 2) year - 1 else year).toLong()
    val era = Math.floorDiv(y, 400L)
    val yearOfEra = y - era * 400
    val dayOfYear = (153 * (if (month > 2) month - 3 else month + 9) + 2) / 5 + day - 1
    val dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
  }
}

class GpxFormatException(message: String) : IllegalArgumentException(message)
