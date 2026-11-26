package app.obnixe.tracker

import expo.modules.kotlin.exception.CodedException

/** Rejections of the module's promises; the codes are the `TrackerErrorCode` union of the TypeScript API. */
class TrackerException private constructor(code: String, message: String, cause: Throwable? = null) : CodedException(code, message, cause) {
  companion object {
    fun alreadyRecording() = TrackerException("ERR_TRACKER_RUNNING", "A recording is already running")

    fun notRecording() = TrackerException("ERR_TRACKER_NOT_RECORDING", "No recording is running")

    fun locationPermission() = TrackerException("ERR_TRACKER_LOCATION_PERMISSION", "Precise location permission is not granted")

    fun bluetoothPermission() = TrackerException("ERR_TRACKER_BLUETOOTH_PERMISSION", "Bluetooth permission is not granted")

    fun bluetoothUnavailable() = TrackerException("ERR_TRACKER_BLUETOOTH_UNAVAILABLE", "Bluetooth is off or missing")

    fun invalidRequest(message: String) = TrackerException("ERR_TRACKER_INVALID_REQUEST", message)

    fun journal(cause: Throwable) = TrackerException("ERR_TRACKER_JOURNAL", "Journal unavailable: ${cause.message}", cause)

    fun foregroundStart(cause: Throwable) =
      TrackerException("ERR_TRACKER_FOREGROUND_START", "The recording service can only start while the app is visible", cause)
  }
}
