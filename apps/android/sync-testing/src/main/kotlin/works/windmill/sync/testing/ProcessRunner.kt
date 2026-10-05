package works.windmill.sync.testing

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.io.ByteArrayOutputStream
import java.io.InputStream

class ProcessFailure(val kind: String, val exitCode: Int? = null) : RuntimeException(kind)
data class ProcessOutput(val stdout: ByteArray, val stderr: ByteArray)

object ProcessRunner {
    fun run(command: List<String>, input: ByteArray = byteArrayOf(), timeoutMs: Long = 30_000, maxOutputBytes: Int = 2_097_152): ProcessOutput {
        require(timeoutMs > 0 && maxOutputBytes > 0)
        val process = try { ProcessBuilder(command).start() } catch (_: java.io.IOException) { throw ProcessFailure("start") }
        val workers = Executors.newFixedThreadPool(3) { task -> Thread(task, "sync-oracle-io").apply { isDaemon = true } }
        fun read(stream: InputStream): ByteArray = stream.use {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) return@use output.toByteArray()
                if (output.size() + count > maxOutputBytes) { process.destroyForcibly(); throw ProcessFailure("output-limit") }
                output.write(buffer, 0, count)
            }
            @Suppress("UNREACHABLE_CODE") byteArrayOf()
        }
        val stdout = workers.submit<ByteArray> { read(process.inputStream) }
        val stderr = workers.submit<ByteArray> { read(process.errorStream) }
        val stdin = workers.submit { process.outputStream.use { it.write(input) } }
        try {
            if (!process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) throw ProcessFailure("timeout")
            fun <T> result(future: java.util.concurrent.Future<T>): T = try { future.get(1, TimeUnit.SECONDS) }
                catch (error: java.util.concurrent.ExecutionException) { throw (error.cause as? ProcessFailure ?: ProcessFailure("io")) }
                catch (_: java.util.concurrent.TimeoutException) { throw ProcessFailure("timeout") }
            val output = ProcessOutput(result(stdout), result(stderr))
            if (process.exitValue() != 0) throw ProcessFailure("exit", process.exitValue())
            result(stdin)
            return output
        } finally {
            if (process.isAlive) { process.destroyForcibly(); process.waitFor(1, TimeUnit.SECONDS) }
            stdin.cancel(true); stdout.cancel(true); stderr.cancel(true); workers.shutdownNow()
        }
    }
}
