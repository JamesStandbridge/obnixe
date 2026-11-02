package app.obnixe.remote

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ObnixeRemoteModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ObnixeRemote")

    Events("onFrame", "onStatus")

    OnCreate {
      RemoteHub.module = this@ObnixeRemoteModule
    }

    OnDestroy {
      if (RemoteHub.module === this@ObnixeRemoteModule) RemoteHub.module = null
    }

    Function("status") {
      statusMap(RemoteHub.status)
    }

    Function("start") { url: String ->
      RemoteService.start(context, url)
    }

    Function("stop") {
      RemoteService.stop(context)
    }

    Function("send") { text: String ->
      RemoteHub.link?.send(text) ?: false
    }
  }

  internal fun emitFrame(text: String) {
    sendEvent("onFrame", mapOf("text" to text))
  }

  internal fun emitStatus(status: LinkStatus) {
    sendEvent("onStatus", statusMap(status))
  }

  private fun statusMap(status: LinkStatus): Map<String, String> = mapOf("state" to status.state, "message" to status.message)
}
