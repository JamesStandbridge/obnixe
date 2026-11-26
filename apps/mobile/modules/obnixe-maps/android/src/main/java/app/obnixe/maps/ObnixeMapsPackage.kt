package app.obnixe.maps

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import org.maplibre.android.MapLibre
import org.maplibre.android.module.http.HttpRequestUtil

/** OpenFreeMap is a free service: tile downloads stay within 8 parallel requests per host, the cap MapLibre already applies on iOS. */
private const val MAX_REQUESTS_PER_HOST = 8

class ObnixeMapsPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(
      object : ApplicationLifecycleListener {
        override fun onCreate(application: Application) {
          MapLibre.getInstance(application)
          val dispatcher = Dispatcher().apply { maxRequestsPerHost = MAX_REQUESTS_PER_HOST }
          HttpRequestUtil.setOkHttpClient(OkHttpClient.Builder().dispatcher(dispatcher).build())
        }
      },
    )
}
