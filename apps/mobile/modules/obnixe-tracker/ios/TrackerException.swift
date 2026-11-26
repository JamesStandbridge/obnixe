import ExpoModulesCore

/// Rejections of the module's promises; the codes are the `TrackerErrorCode` union of the TypeScript API.
enum TrackerException {
  static func alreadyRecording() -> Exception {
    make("ERR_TRACKER_RUNNING", "A recording is already running")
  }

  static func notRecording() -> Exception {
    make("ERR_TRACKER_NOT_RECORDING", "No recording is running")
  }

  static func locationPermission() -> Exception {
    make("ERR_TRACKER_LOCATION_PERMISSION", "Precise location permission is not granted")
  }

  static func bluetoothPermission() -> Exception {
    make("ERR_TRACKER_BLUETOOTH_PERMISSION", "Bluetooth permission is not granted")
  }

  static func bluetoothUnavailable() -> Exception {
    make("ERR_TRACKER_BLUETOOTH_UNAVAILABLE", "Bluetooth is off or missing")
  }

  static func invalidRequest(_ message: String) -> Exception {
    make("ERR_TRACKER_INVALID_REQUEST", message)
  }

  static func journal(_ cause: Error) -> Exception {
    make("ERR_TRACKER_JOURNAL", "Journal unavailable").causedBy(cause)
  }

  static func foregroundStart() -> Exception {
    make("ERR_TRACKER_FOREGROUND_START", "A recording can only start while the app is visible")
  }

  private static func make(_ code: String, _ message: String) -> Exception {
    Exception(name: "TrackerException", description: message, code: code)
  }
}
