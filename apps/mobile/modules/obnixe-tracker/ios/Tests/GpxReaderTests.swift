import Foundation
import XCTest
@testable import ObnixeTracker

final class GpxReaderTests: XCTestCase {
  private func read(_ xml: String) throws -> [GpxPoint] {
    try GpxReader.read(Data(xml.utf8))
  }

  func testTrackPointsKeepTheirCoordinatesElevationAndTime() throws {
    let points = try read(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
        <metadata><time>2020-01-01T00:00:00Z</time></metadata>
        <trk><trkseg>
          <trkpt lat="45.8326412" lon="6.8652087"><ele>1042.1</ele><time>2026-03-12T07:41:05Z</time></trkpt>
          <trkpt lat="-33.9" lon="-70.25"><extensions><time>2000-01-01T00:00:00Z</time></extensions></trkpt>
        </trkseg></trk>
      </gpx>
      """
    )
    XCTAssertEqual(
      points,
      [
        GpxPoint(latitudeE7: 458_326_412, longitudeE7: 68_652_087, elevationMm: 1_042_100, timeMs: 1_773_301_265_000),
        GpxPoint(latitudeE7: -339_000_000, longitudeE7: -702_500_000, elevationMm: nil, timeMs: nil),
      ]
    )
  }

  func testRoutePointsAreReadWhenThereIsNoTrack() throws {
    XCTAssertEqual(
      try read(#"<gpx><rte><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte></gpx>"#),
      [
        GpxPoint(latitudeE7: 10_000_000, longitudeE7: 20_000_000, elevationMm: nil, timeMs: nil),
        GpxPoint(latitudeE7: 30_000_000, longitudeE7: 40_000_000, elevationMm: nil, timeMs: nil),
      ]
    )
  }

  func testAPointWithoutCoordinatesIsRefused() {
    XCTAssertThrowsError(try read(#"<gpx><trk><trkseg><trkpt lat="1"/></trkseg></trk></gpx>"#)) { error in
      XCTAssertTrue(error is GpxFormatError)
    }
  }

  func testIsoInstantsHonourFractionsAndOffsets() {
    XCTAssertEqual(GpxReader.parseIsoInstant("2026-03-12T07:41:05.250Z"), 1_773_301_265_250)
    XCTAssertEqual(GpxReader.parseIsoInstant("2026-03-12T09:41:05+02:00"), 1_773_301_265_000)
    XCTAssertEqual(GpxReader.parseIsoInstant("2026-03-12T02:41:05-0500"), 1_773_301_265_000)
    XCTAssertEqual(GpxReader.parseIsoInstant("2000-02-29T00:00:00"), 951_782_400_000)
    XCTAssertEqual(GpxReader.parseIsoInstant("1969-12-31T00:00:00Z"), -86_400_000)
    XCTAssertNil(GpxReader.parseIsoInstant("12 March 2026"))
  }

  func testReplayOffsetsFollowTheRecordedTimesAndNeverGoBack() {
    let points = [1_000_000, 1_003_000, 1_002_000, nil, 1_010_000].map { time in
      GpxPoint(latitudeE7: 0, longitudeE7: 0, elevationMm: nil, timeMs: time.map(Int64.init))
    }
    XCTAssertEqual(replayOffsets(points), [0, 3_000, 3_000, 4_000, 10_000])
  }

  func testUntimedTracksReplayOnePointPerSecond() {
    let point = GpxPoint(latitudeE7: 0, longitudeE7: 0, elevationMm: nil, timeMs: nil)
    XCTAssertEqual(replayOffsets([point, point, point]), [0, 1_000, 2_000])
    XCTAssertEqual(replayOffsets([]), [])
  }
}
