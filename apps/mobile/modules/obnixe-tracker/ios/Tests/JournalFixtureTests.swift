import Foundation
import XCTest
@testable import ObnixeTracker

/**
 Writes the journal fixture of `packages/core/test/fixtures/journal`, which the TypeScript reader test reads back
 against the expected JSON. `OBNIXE_UPDATE_FIXTURES=1` regenerates both files instead of comparing them.
 */
final class JournalFixtureTests: XCTestCase {
  private let header = JournalHeader(
    sessionId: "019abc12-3456-7def-8123-456789abcd02",
    startedAt: 1_795_678_200_000,
    monotonicOriginNs: 412_345_678_901_234,
    platform: JournalFormat.platformIOS,
    device: "Apple iPhone17,1"
  )

  private let fix = Fix(
    t: 1_000,
    fixAgeMs: 180,
    latitudeE7: 458_326_412,
    longitudeE7: 68_652_087,
    altitudeEllipsoidMm: 1_092_400,
    altitudeMslMm: 1_042_100,
    horizontalAccuracyDm: 36,
    verticalAccuracyDm: 51,
    speedCmS: 298,
    speedAccuracyCmS: 42,
    bearingCentiDeg: 27_050,
    bearingAccuracyCentiDeg: 1_150,
    simulated: false
  )

  private struct Step {
    let samples: [Sample]
    let mark: Mark?
  }

  private var steps: [Step] {
    var second = fix
    second.t = 2_000
    second.fixAgeMs = -4
    second.latitudeE7 = 458_326_610
    second.longitudeE7 = 68_652_301
    second.speedCmS = 0xFFFE
    let bounds = Fix(
      t: 10_000,
      fixAgeMs: 0,
      latitudeE7: -900_000_000,
      longitudeE7: 1_800_000_000,
      altitudeEllipsoidMm: -430_500,
      altitudeMslMm: nil,
      horizontalAccuracyDm: 50,
      verticalAccuracyDm: nil,
      speedCmS: nil,
      speedAccuracyCmS: nil,
      bearingCentiDeg: nil,
      bearingAccuracyCentiDeg: nil,
      simulated: true
    )
    return [
      Step(samples: [], mark: Mark(t: 0, kind: .start)),
      Step(
        samples: [
          .fix(fix),
          .pressure(PressureSample(t: 1_020, pascals: 89_412)),
          .steps(StepSample(t: 1_100, count: 2)),
          .heartRate(HeartRateSample(t: 1_150, bpm: 142, contact: .contact, rrInterval: 433)),
          .fix(second),
          .heartRate(HeartRateSample(t: 2_150, bpm: 143, contact: .absent, rrInterval: nil)),
        ],
        mark: nil
      ),
      Step(
        samples: [.steps(StepSample(t: 2_900, count: 5)), .heartRate(HeartRateSample(t: 3_000, bpm: 141, contact: .unsupported, rrInterval: 1_024))],
        mark: Mark(t: 3_100, kind: .pause)
      ),
      Step(samples: [.pressure(PressureSample(t: 9_000, pascals: 89_430))], mark: Mark(t: 9_200, kind: .resume)),
      Step(samples: [.fix(bounds), .steps(StepSample(t: 10_100, count: 19))], mark: Mark(t: 10_500, kind: .lap)),
      Step(samples: [.pressure(PressureSample(t: 11_000, pascals: 89_401))], mark: Mark(t: 11_000, kind: .stop)),
    ]
  }

  private let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../../../packages/core/test/fixtures/journal")
    .standardizedFileURL

  func testWriterOutputMatchesTheCommittedFixture() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("ios-v1.ojr")
    let writer = try JournalWriter.create(at: url, header: header)
    let batches = try steps.map { step in
      for sample in step.samples { XCTAssertTrue(writer.append(sample)) }
      return try XCTUnwrap(try writer.flush(mark: step.mark))
    }
    writer.close()
    let bytes = try Data(contentsOf: url)
    let expected = expectedJson(batches, length: bytes.count)
    let fixtureBytes = fixtures.appendingPathComponent("ios-v1.ojr")
    let fixtureJson = fixtures.appendingPathComponent("ios-v1.json")
    if ProcessInfo.processInfo.environment["OBNIXE_UPDATE_FIXTURES"] == "1" {
      try FileManager.default.createDirectory(at: fixtures, withIntermediateDirectories: true)
      try bytes.write(to: fixtureBytes)
      try Data(expected.utf8).write(to: fixtureJson)
    }
    XCTAssertEqual(try Data(contentsOf: fixtureBytes), bytes)
    XCTAssertEqual(try String(contentsOf: fixtureJson, encoding: .utf8), expected)
  }

  /// What `readJournal` of `packages/core` returns for the fixture, with the `Int64` origin as a decimal string.
  private func expectedJson(_ batches: [JournalBatch], length: Int) -> String {
    Json.encode([
      "header": [
        "sessionId": header.sessionId,
        "startedAt": Int(header.startedAt),
        "monotonicOriginNs": String(header.monotonicOriginNs),
        "platform": "ios",
        "device": header.device,
      ] as [String: Any?],
      "samples": batches.flatMap { batch in batch.samples.map(\.bridge) },
      "marks": batches.compactMap { batch in batch.mark.map { ["kind": $0.kind.wire, "t": Int($0.t)] as [String: Any?] } },
      "lastSequence": batches.last?.sequence,
      "validLength": length,
    ] as [String: Any?])
  }
}

/// Minimal JSON encoder for the fixture, formatted like `JSON.stringify(value, null, 2)` with sorted keys.
private enum Json {
  static func encode(_ value: Any?) -> String {
    encode(value, indent: "") + "\n"
  }

  private static func encode(_ value: Any?, indent: String) -> String {
    guard let value else { return "null" }
    switch value {
    case let string as String:
      return quoted(string)
    case let bool as Bool:
      return bool ? "true" : "false"
    case let int as Int:
      return String(int)
    case let double as Double:
      return double.truncatingRemainder(dividingBy: 1) == 0 ? String(Int64(double)) : String(double)
    case let object as [String: Any?]:
      return entries(object.keys.sorted().map { key in { inner in quoted(key) + ": " + encode(object[key] ?? nil, indent: inner) } }, indent, "{", "}")
    case let array as [Any?]:
      return entries(array.map { item in { inner in encode(item, indent: inner) } }, indent, "[", "]")
    default:
      preconditionFailure("Unsupported JSON value: \(value)")
    }
  }

  private static func entries(_ items: [(String) -> String], _ indent: String, _ open: String, _ close: String) -> String {
    if items.isEmpty { return open + close }
    let inner = indent + "  "
    return open + "\n" + items.map { inner + $0(inner) }.joined(separator: ",\n") + "\n" + indent + close
  }

  private static func quoted(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
      default: out.unicodeScalars.append(scalar)
      }
    }
    return out + "\""
  }
}
