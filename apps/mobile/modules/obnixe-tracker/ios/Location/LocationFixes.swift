import CoreLocation

extension CLLocation {
  /**
   Every field Core Location reports (`GPS-011`), in journal units, for a fix received at `t`; nil for an invalid fix
   or one before the clock's origin. A negative accuracy marks an invalid value; a zero vertical accuracy, absent
   altitudes.
   */
  func toFix(t: Int64, startedAt: Int64) -> Fix? {
    guard t >= 0, horizontalAccuracy >= 0 else { return nil }
    let hasAltitude = verticalAccuracy > 0
    return Fix(
      t: t,
      fixAgeMs: Int32(clamping: startedAt + t - Int64(roundedClamping: timestamp.timeIntervalSince1970 * 1000)),
      latitudeE7: Int32(roundedClamping: coordinate.latitude * 1e7),
      longitudeE7: Int32(roundedClamping: coordinate.longitude * 1e7),
      altitudeEllipsoidMm: hasAltitude ? Int32(roundedClamping: ellipsoidalAltitude * 1000) : nil,
      altitudeMslMm: hasAltitude ? Int32(roundedClamping: altitude * 1000) : nil,
      horizontalAccuracyDm: Int(roundedClamping: horizontalAccuracy * 10),
      verticalAccuracyDm: hasAltitude ? Int(roundedClamping: verticalAccuracy * 10) : nil,
      speedCmS: speed >= 0 ? Int(roundedClamping: speed * 100) : nil,
      speedAccuracyCmS: speedAccuracy >= 0 ? Int(roundedClamping: speedAccuracy * 100) : nil,
      bearingCentiDeg: course >= 0 ? Int(roundedClamping: course * 100) % 36_000 : nil,
      bearingAccuracyCentiDeg: courseAccuracy >= 0 ? Int(roundedClamping: courseAccuracy * 100) : nil,
      simulated: sourceInformation?.isSimulatedBySoftware ?? false
    )
  }
}
