package app.obnixe.tracker

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.types.Enumerable

enum class TrackerPermission(val value: String) : Enumerable {
  LOCATION("location"),
  ACTIVITY("activity"),
  BLUETOOTH("bluetooth"),
  NOTIFICATIONS("notifications"),
}

/**
 * Runtime permissions behind each tracker capability (`PRV-001`, `PRV-005`, `PRV-006`). Location is only ever asked
 * while in use; a capability that needs no runtime permission on this Android version reads as granted.
 */
object TrackerPermissions {
  fun manifestPermissions(permission: TrackerPermission): Array<String> = when (permission) {
    TrackerPermission.LOCATION -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    TrackerPermission.ACTIVITY ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) arrayOf(Manifest.permission.ACTIVITY_RECOGNITION) else emptyArray()
    TrackerPermission.BLUETOOTH ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
      } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
      }
    TrackerPermission.NOTIFICATIONS ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()
  }

  /** True when the capability can be used; location requires the precise permission (`PRV-003`). */
  fun isGranted(context: Context, permission: TrackerPermission): Boolean {
    val required = if (permission == TrackerPermission.LOCATION) arrayOf(Manifest.permission.ACCESS_FINE_LOCATION) else manifestPermissions(permission)
    return required.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
  }

  /** `{ grant, canAskAgain }`, where `grant` is `granted`, `approximate` (coarse location only), `denied` or `undetermined`. */
  fun status(permission: TrackerPermission, responses: Map<String, PermissionsResponse>): Map<String, Any> {
    val required = manifestPermissions(permission)
    val statuses = required.map { responses[it]?.status ?: PermissionsStatus.UNDETERMINED }
    val canAskAgain = required.all { responses[it]?.canAskAgain ?: true }
    val grant = when {
      statuses.all { it == PermissionsStatus.GRANTED } -> "granted"
      permission == TrackerPermission.LOCATION && responses[Manifest.permission.ACCESS_COARSE_LOCATION]?.status == PermissionsStatus.GRANTED -> "approximate"
      statuses.any { it == PermissionsStatus.DENIED } -> "denied"
      else -> "undetermined"
    }
    return mapOf("grant" to grant, "canAskAgain" to canAskAgain)
  }
}
