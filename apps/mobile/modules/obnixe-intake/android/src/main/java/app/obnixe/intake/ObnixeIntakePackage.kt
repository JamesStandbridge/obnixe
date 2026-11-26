package app.obnixe.intake

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/** The shared file of a share sheet intent, or null for any other intent. */
private fun sharedFile(intent: Intent): Uri? {
  if (intent.action != Intent.ACTION_SEND) return null
  return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
  } else {
    @Suppress("DEPRECATION")
    intent.getParcelableExtra(Intent.EXTRA_STREAM)
  }
}

/**
 * IO-051: a file shared to Obnixe arrives as `ACTION_SEND` with the file in `EXTRA_STREAM`, which React Native's
 * Linking ignores. Turned into the `ACTION_VIEW` of the same file, it reaches the router like a file opened with Obnixe.
 */
private fun viewSharedFile(intent: Intent) {
  val file = sharedFile(intent) ?: return
  intent.action = Intent.ACTION_VIEW
  intent.data = file
}

class ObnixeIntakePackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> =
    listOf(
      object : ReactActivityLifecycleListener {
        override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
          if (savedInstanceState == null) viewSharedFile(activity.intent)
        }

        override fun onNewIntent(intent: Intent): Boolean {
          viewSharedFile(intent)
          return false
        }
      },
    )
}
