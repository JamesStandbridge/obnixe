package app.obnixe.remote

import org.json.JSONException
import org.json.JSONObject

/** Joins the relay link, owned by the foreground service, to the JavaScript module, which may come and go. */
internal object RemoteHub : RelayLink.Listener {
  @Volatile var module: ObnixeRemoteModule? = null
  @Volatile var status = LinkStatus("stopped", "")
  @Volatile var link: RelayLink? = null

  override fun onStatus(status: LinkStatus) {
    this.status = status
    module?.emitStatus(status)
  }

  override fun onFrame(text: String) {
    val module = module
    if (module != null) {
      module.emitFrame(text)
      return
    }
    try {
      val frame = JSONObject(text)
      if (frame.optString("type") != "request") return
      val answer = JSONObject()
        .put("type", "response")
        .put("id", frame.getLong("id"))
        .put("status", 503)
        .put("headers", JSONObject().put("content-type", "text/plain; charset=utf-8"))
        .put("body", "Obnixe is not running on the phone")
      link?.send(answer.toString())
    } catch (error: JSONException) {
      return
    }
  }
}
