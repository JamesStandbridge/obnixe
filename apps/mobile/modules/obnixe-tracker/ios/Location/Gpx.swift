import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

struct GpxPoint: Equatable {
  let latitudeE7: Int32
  let longitudeE7: Int32
  let elevationMm: Int32?
  let timeMs: Int64?
}

struct GpxFormatError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

/// Reads the track points (or route points) of a GPX file, in document order, for the replay source.
enum GpxReader {
  static func read(_ data: Data) throws -> [GpxPoint] {
    let parser = XMLParser(data: data)
    let collector = PointCollector()
    parser.shouldProcessNamespaces = true
    parser.delegate = collector
    let parsed = parser.parse()
    if let error = collector.error { throw error }
    guard parsed else { throw GpxFormatError(parser.parserError.map { "Malformed GPX: \($0.localizedDescription)" } ?? "Malformed GPX") }
    return collector.points
  }

  private static let isoInstant = #/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/#

  /// EpochMs of an ISO 8601 date-time as written in GPX (`2026-03-12T07:41:05.250Z`); nil when malformed.
  static func parseIsoInstant(_ value: String) -> Int64? {
    guard let match = value.wholeMatch(of: isoInstant) else { return nil }
    let (_, year, month, day, hour, minute, second, fraction, zone) = match.output
    let fractionMs = fraction.flatMap { Double("0\($0)") }.map { Int64(roundedClamping: $0 * 1000) } ?? 0
    var offsetMinutes: Int64 = 0
    if let zone, zone != "Z" {
      let digits = zone.dropFirst().filter { $0 != ":" }
      let minutes = Int64(digits.prefix(2))! * 60 + Int64(digits.suffix(2))!
      offsetMinutes = zone.first == "-" ? -minutes : minutes
    }
    let days = daysFromCivil(year: Int64(year)!, month: Int64(month)!, day: Int64(day)!)
    let seconds = days * 86_400 + Int64(hour)! * 3600 + Int64(minute)! * 60 + Int64(second)! - offsetMinutes * 60
    return seconds * 1000 + fractionMs
  }

  /// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
  private static func daysFromCivil(year: Int64, month: Int64, day: Int64) -> Int64 {
    let y = month <= 2 ? year - 1 : year
    let era = (y >= 0 ? y : y - 399) / 400
    let yearOfEra = y - era * 400
    let dayOfYear = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1
    let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
  }
}

/// Replay offsets in ms from the first point, never decreasing; points without a time are spaced by 1 s.
func replayOffsets(_ points: [GpxPoint]) -> [Int64] {
  var offsets = [Int64](repeating: 0, count: points.count)
  let origin = points.first?.timeMs
  for index in points.indices.dropFirst() {
    let offset = origin.flatMap { origin in points[index].timeMs.map { $0 - origin } } ?? offsets[index - 1] + 1000
    offsets[index] = max(offset, offsets[index - 1])
  }
  return offsets
}

private final class PointCollector: NSObject, XMLParserDelegate {
  private(set) var points: [GpxPoint] = []
  private(set) var error: GpxFormatError?
  private var latitudeE7: Int32 = 0
  private var longitudeE7: Int32 = 0
  private var elevationMm: Int32?
  private var timeMs: Int64?
  private var depth = 0
  private var pointDepth = -1
  private var field: String?
  private var text = ""

  func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
    depth += 1
    switch elementName {
    case "trkpt", "rtept":
      guard let latitude = attributes["lat"].flatMap(Double.init), latitude.isFinite else { return fail(parser, "Point without latitude") }
      guard let longitude = attributes["lon"].flatMap(Double.init), longitude.isFinite else { return fail(parser, "Point without longitude") }
      latitudeE7 = Int32(roundedClamping: latitude * 1e7)
      longitudeE7 = Int32(roundedClamping: longitude * 1e7)
      elevationMm = nil
      timeMs = nil
      pointDepth = depth
    case "ele", "time":
      field = pointDepth >= 0 && depth == pointDepth + 1 ? elementName : nil
      text = ""
    default:
      break
    }
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) {
    if field != nil { text += string }
  }

  func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
    switch elementName {
    case "ele" where field == "ele":
      elevationMm = Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
        .flatMap { $0.isFinite ? Int32(roundedClamping: $0 * 1000) : nil }
      field = nil
    case "time" where field == "time":
      timeMs = GpxReader.parseIsoInstant(text.trimmingCharacters(in: .whitespacesAndNewlines))
      field = nil
    case "trkpt", "rtept":
      points.append(GpxPoint(latitudeE7: latitudeE7, longitudeE7: longitudeE7, elevationMm: elevationMm, timeMs: timeMs))
      pointDepth = -1
    default:
      break
    }
    depth -= 1
  }

  private func fail(_ parser: XMLParser, _ message: String) {
    error = GpxFormatError(message)
    parser.abortParsing()
  }
}
