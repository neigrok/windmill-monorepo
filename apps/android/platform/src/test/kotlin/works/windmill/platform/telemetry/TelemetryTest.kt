package works.windmill.platform.telemetry

import java.io.EOFException
import java.io.IOException
import java.net.ProtocolException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import okhttp3.internal.http2.ErrorCode
import okhttp3.internal.http2.StreamResetException
import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.platform.net.WindmillApiException

class TelemetryTest {
    @Test
    fun onlyTransportNetworkLossIsExcludedFromFailureReporting() {
        val certificate = SSLHandshakeException("certificate").apply { initCause(CertificateException()) }
        val cases = listOf(
            WindmillApiException.Transport(SocketException("Connection reset")) to false,
            WindmillApiException.Transport(IOException("unexpected end of stream", EOFException())) to false,
            WindmillApiException.Transport(certificate) to true,
            WindmillApiException.Transport(IOException("other")) to true,
            WindmillApiException.Transport(ProtocolException("garbage status line")) to true,
            WindmillApiException.Transport(StreamResetException(ErrorCode.INTERNAL_ERROR)) to true,
            EOFException() to true,
            WindmillApiException.Offline to false,
            WindmillApiException.Timeout(SocketTimeoutException()) to true,
        )
        for ((failure, expected) in cases) assertEquals(failure.javaClass.simpleName, expected, TelemetryPolicy.report(failure))
    }
}
