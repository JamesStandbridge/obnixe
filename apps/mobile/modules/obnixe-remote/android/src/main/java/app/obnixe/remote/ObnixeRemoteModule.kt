package app.obnixe.remote

import android.os.Build
import app.obnixe.tunnel.Tunnel
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ObnixeRemoteModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ObnixeRemote")

    Events("onRequest", "onStatus")

    OnCreate {
      RemoteHub.module = this@ObnixeRemoteModule
    }

    OnDestroy {
      if (RemoteHub.module === this@ObnixeRemoteModule) RemoteHub.module = null
    }

    Function("isSupported") {
      Build.SUPPORTED_ABIS.contains("arm64-v8a")
    }

    Function("status") {
      statusMap(RemoteHub.status)
    }

    Function("start") { authtoken: String ->
      RemoteService.start(context, authtoken)
    }

    Function("stop") {
      RemoteService.stop(context)
    }

    Function("respond") { id: Double, status: Int, headers: String, body: String ->
      Tunnel.respond(id.toLong(), status.toLong(), headers, body)
    }
  }

  internal fun emitRequest(id: Long, method: String, target: String, headers: String, body: String) {
    sendEvent("onRequest", mapOf("id" to id.toDouble(), "method" to method, "target" to target, "headers" to headers, "body" to body))
  }

  internal fun emitStatus(status: TunnelStatus) {
    sendEvent("onStatus", statusMap(status))
  }

  private fun statusMap(status: TunnelStatus): Map<String, String> =
    mapOf("state" to status.state, "url" to status.url, "message" to status.message)
}
