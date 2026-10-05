package works.windmill.sync.testing

import org.junit.Assert.*
import org.junit.Test

class ProcessTests {
    private fun node(code: String) = listOf("node", "-e", code)
    @Test fun drainsBothPipesWhileWritingInput() {
        val output = ProcessRunner.run(node("process.stdin.resume(); process.stdout.write('a'.repeat(200000)); process.stderr.write('b'.repeat(200000));"), ByteArray(200000))
        assertEquals(200000, output.stdout.size); assertEquals(200000, output.stderr.size)
    }
    @Test fun stalledInputCannotDeadlockTheOracle() {
        assertEquals("timeout", assertThrows(ProcessFailure::class.java) {
            ProcessRunner.run(node("setInterval(()=>{},1000)"), ByteArray(8_388_608), timeoutMs = 200)
        }.kind)
    }
    @Test fun aChildThatNeverClosesOutputTimesOut() {
        assertEquals("timeout", assertThrows(ProcessFailure::class.java) {
            ProcessRunner.run(node("process.stdout.write('partial');setInterval(()=>{},1000)"), timeoutMs = 200)
        }.kind)
    }
    @Test fun excessiveOutputIsBoundedAndKillsTheChild() {
        assertEquals("output-limit", assertThrows(ProcessFailure::class.java) { ProcessRunner.run(node("process.stdout.write('a'.repeat(200000))"), maxOutputBytes = 1024) }.kind)
    }
    @Test fun exitAndCrashAreReportedWithoutHanging() {
        assertEquals(9, assertThrows(ProcessFailure::class.java) { ProcessRunner.run(node("process.exit(9)")) }.exitCode)
        assertEquals("exit", assertThrows(ProcessFailure::class.java) { ProcessRunner.run(node("process.kill(process.pid,'SIGKILL')")) }.kind)
    }
    @Test fun startupFailureIsExplicit() {
        assertEquals("start", assertThrows(ProcessFailure::class.java) { ProcessRunner.run(listOf("/no-such-sync-oracle")) }.kind)
    }
}
