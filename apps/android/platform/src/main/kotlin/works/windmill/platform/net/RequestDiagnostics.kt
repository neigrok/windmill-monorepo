package works.windmill.platform.net

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response

@PublishedApi
internal enum class NetworkPhase(val value: String) {
    Prepare("prepare"), Queued("queued"), Dns("dns"), Connect("connect"), Tls("tls"),
    RequestHeaders("request_headers"), RequestBody("request_body"),
    ResponseHeaders("response_headers"), ResponseBody("response_body"), Decode("decode"),
}

@PublishedApi
internal class RequestDiagnostics {
    private val startNanos = System.nanoTime()
    @Volatile var phase = NetworkPhase.Prepare

    fun properties(): Map<String, String> = mapOf(
        "duration_ms" to TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos).coerceAtLeast(0).toString(),
        "network_phase" to phase.value,
    )

    fun listener(delegate: EventListener): EventListener = object : EventListener() {
        override fun callStart(call: Call) {
            phase = NetworkPhase.Queued
            delegate.callStart(call)
        }

        override fun proxySelectStart(call: Call, url: HttpUrl) = delegate.proxySelectStart(call, url)
        override fun proxySelectEnd(call: Call, url: HttpUrl, proxies: List<Proxy>) = delegate.proxySelectEnd(call, url, proxies)

        override fun dnsStart(call: Call, domainName: String) {
            phase = NetworkPhase.Dns
            delegate.dnsStart(call, domainName)
        }

        override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) {
            phase = NetworkPhase.Connect
            delegate.dnsEnd(call, domainName, inetAddressList)
        }

        override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
            phase = NetworkPhase.Connect
            delegate.connectStart(call, inetSocketAddress, proxy)
        }

        override fun secureConnectStart(call: Call) {
            phase = NetworkPhase.Tls
            delegate.secureConnectStart(call)
        }

        override fun secureConnectEnd(call: Call, handshake: Handshake?) {
            phase = NetworkPhase.Connect
            delegate.secureConnectEnd(call, handshake)
        }

        override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
            phase = NetworkPhase.RequestHeaders
            delegate.connectEnd(call, inetSocketAddress, proxy, protocol)
        }

        override fun connectFailed(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?, ioe: IOException) =
            delegate.connectFailed(call, inetSocketAddress, proxy, protocol, ioe)

        override fun connectionAcquired(call: Call, connection: Connection) {
            phase = NetworkPhase.RequestHeaders
            delegate.connectionAcquired(call, connection)
        }

        override fun connectionReleased(call: Call, connection: Connection) = delegate.connectionReleased(call, connection)

        override fun requestHeadersStart(call: Call) {
            phase = NetworkPhase.RequestHeaders
            delegate.requestHeadersStart(call)
        }

        override fun requestHeadersEnd(call: Call, request: Request) {
            phase = if (request.body == null) NetworkPhase.ResponseHeaders else NetworkPhase.RequestBody
            delegate.requestHeadersEnd(call, request)
        }

        override fun requestBodyStart(call: Call) {
            phase = NetworkPhase.RequestBody
            delegate.requestBodyStart(call)
        }

        override fun requestBodyEnd(call: Call, byteCount: Long) {
            phase = NetworkPhase.ResponseHeaders
            delegate.requestBodyEnd(call, byteCount)
        }

        override fun requestFailed(call: Call, ioe: IOException) = delegate.requestFailed(call, ioe)

        override fun responseHeadersStart(call: Call) {
            phase = NetworkPhase.ResponseHeaders
            delegate.responseHeadersStart(call)
        }

        override fun responseHeadersEnd(call: Call, response: Response) {
            phase = NetworkPhase.ResponseBody
            delegate.responseHeadersEnd(call, response)
        }

        override fun responseBodyStart(call: Call) {
            phase = NetworkPhase.ResponseBody
            delegate.responseBodyStart(call)
        }

        override fun responseBodyEnd(call: Call, byteCount: Long) = delegate.responseBodyEnd(call, byteCount)
        override fun responseFailed(call: Call, ioe: IOException) = delegate.responseFailed(call, ioe)
        override fun callEnd(call: Call) = delegate.callEnd(call)
        override fun callFailed(call: Call, ioe: IOException) = delegate.callFailed(call, ioe)
        override fun canceled(call: Call) = delegate.canceled(call)
        override fun satisfactionFailure(call: Call, response: Response) = delegate.satisfactionFailure(call, response)
        override fun cacheHit(call: Call, response: Response) = delegate.cacheHit(call, response)
        override fun cacheMiss(call: Call) = delegate.cacheMiss(call)
        override fun cacheConditionalHit(call: Call, response: Response) = delegate.cacheConditionalHit(call, response)
    }

    private class ListenerFactory(private val delegate: EventListener.Factory) : EventListener.Factory {
        override fun create(call: Call): EventListener {
            val listener = delegate.create(call)
            return call.request().tag(RequestDiagnostics::class.java)?.listener(listener) ?: listener
        }
    }

    companion object {
        fun attachTo(client: OkHttpClient): OkHttpClient {
            if (client.eventListenerFactory is ListenerFactory) return client
            return client.newBuilder().eventListenerFactory(ListenerFactory(client.eventListenerFactory)).build()
        }
    }
}
