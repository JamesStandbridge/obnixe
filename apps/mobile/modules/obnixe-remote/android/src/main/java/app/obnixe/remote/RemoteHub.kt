package app.obnixe.remote

import app.obnixe.tunnel.Handler
import app.obnixe.tunnel.Tunnel

data class TunnelStatus(val state: String, val url: String, val message: String)

/** Receives the tunnel callbacks from Go threads and forwards them to the JavaScript module while it is alive. */
internal object RemoteHub : Handler {
  @Volatile
  var module: ObnixeRemoteModule? = null

  @Volatile
  var status: TunnelStatus = TunnelStatus("stopped", "", "")
    private set

  private const val unavailableHeaders = "{\"content-type\":\"text/plain; charset=utf-8\"}"

  override fun request(id: Long, method: String, target: String, headers: String, body: String) {
    val receiver = module
    if (receiver == null) {
      Tunnel.respond(id, 503, unavailableHeaders, "Obnixe is not running on the phone")
      return
    }
    receiver.emitRequest(id, method, target, headers, body)
  }

  override fun status(state: String, url: String, message: String) {
    val next = TunnelStatus(state, url, message)
    status = next
    module?.emitStatus(next)
  }
}
