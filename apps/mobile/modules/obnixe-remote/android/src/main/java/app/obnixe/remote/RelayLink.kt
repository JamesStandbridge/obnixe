package app.obnixe.remote

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

data class LinkStatus(val state: String, val message: String)

/**
 * Keeps one WebSocket to the relay open while started: OkHttp pings detect dead links, lost links come back with
 * exponential backoff, and a network becoming available retries at once. Frames go to [listener] untouched.
 */
class RelayLink(context: Context, private val url: String, private val listener: Listener) {
  interface Listener {
    fun onStatus(status: LinkStatus)
    fun onFrame(text: String)
  }

  private companion object {
    const val pingSeconds = 25L
    const val maxBackoffMs = 60_000L
  }

  private val handler = Handler(Looper.getMainLooper())
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val client = OkHttpClient.Builder().pingInterval(pingSeconds, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
  @Volatile private var socket: WebSocket? = null
  private var attempt = 0
  private var stopped = false
  private val retry = Runnable { connect() }
  private val network = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
      handler.post {
        if (!stopped && socket == null) {
          handler.removeCallbacks(retry)
          connect()
        }
      }
    }
  }

  fun start() {
    handler.post {
      connectivity.registerDefaultNetworkCallback(network)
      connect()
    }
  }

  fun stop() {
    handler.post {
      stopped = true
      handler.removeCallbacks(retry)
      connectivity.unregisterNetworkCallback(network)
      socket?.close(1000, "Stopped")
      socket = null
      listener.onStatus(LinkStatus("stopped", ""))
    }
  }

  /** Queues [text] on the open link; false when there is none. */
  fun send(text: String): Boolean = socket?.send(text) ?: false

  private fun connect() {
    if (stopped || socket != null) return
    listener.onStatus(LinkStatus("connecting", ""))
    socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        handler.post {
          if (webSocket !== socket) return@post
          attempt = 0
          listener.onStatus(LinkStatus("open", ""))
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (webSocket === socket) listener.onFrame(text)
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        handler.post { lost(webSocket, reason.ifEmpty { "closed ($code)" }) }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        handler.post { lost(webSocket, t.message ?: t.javaClass.simpleName) }
      }
    })
  }

  private fun lost(webSocket: WebSocket, message: String) {
    if (webSocket !== socket || stopped) return
    socket = null
    val delay = minOf(maxBackoffMs, 1000L shl minOf(attempt, 6))
    attempt += 1
    listener.onStatus(LinkStatus("waiting", message))
    handler.postDelayed(retry, delay)
  }
}
