package works.windmill.sync.testing

import java.io.File
import java.util.Random
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.*

class OracleTests {
    @Test fun jcsNumbersMatchTheJsOracleOverRandomFiniteBits() {
        val random = Random(117)
        val safe = Json.MAX_SAFE_INTEGER.toDouble()
        val values = mutableListOf(0.0, -0.0, 1.0, -1.0, 10.0, -10.0, 100.0, -100.0, 1000.0, -1000.0,
            1e6, -1e6, 1e12, -1e12, 1e15, -1e15, safe - 1, safe, safe + 1, -safe + 1, -safe, -safe - 1, 1e21, -1e21)
        while (values.size < 4096 + 24) {
            val number = Double.fromBits(random.nextLong())
            if (number.isFinite()) values.add(number)
        }
        val program = """
            import {readFileSync} from 'node:fs';
            import {pathToFileURL} from 'node:url';
            const {jcs} = await import(pathToFileURL(process.argv[1]).href);
            for (const hex of readFileSync(0, 'utf8').trim().split('\n')) {
                console.log(jcs(Buffer.from(hex, 'hex').readDoubleBE(0)));
            }
        """.trimIndent()
        val oracle = File(System.getProperty("windmill.contract"), "sync/reference/core/jcs.js")
        val output = ProcessRunner.run(listOf("node", "--input-type=module", "-e", program, oracle.absolutePath),
            values.joinToString("\n") { it.toBits().toULong().toString(16).padStart(16, '0') }.encodeToByteArray())
        val expected = output.stdout.decodeToString().trimEnd('\n').lines()
        assertTrue(output.stderr.isEmpty())
        assertEquals(values.size, expected.size)
        for (i in values.indices) assertEquals("bits ${values[i].toBits().toULong().toString(16)}", expected[i], Json.of(values[i]).jcs)
        println("JCS oracle: 4096 random finite IEEE-754 patterns + 24 integer/format boundaries, 0 differences")
    }
    @Test fun portablePatternsAndWholeValueMatching() {
        val portable = listOf("^b_[0-9a-f]{8}$", "^[A-Za-z0-9_-]{8,64}$", "^[-a]$", "^(?:ab|cd)+$", "^(a|b)?c{2,}$", "^a\\.b\\/c$", "^[\\]\\-]$", "^[\\[-a]$", "^[a-]$", "^[-:]$", "^a{65535}$", "^a{1,65535}$", "^[a:]$")
        val refused = listOf("b_[0-9a-f]{8}$", "^b_[0-9a-f]{8}", "^a|b$", "^.{1,64}$", "^\\s+$", "^\\d+$", "^\\w+$", "^a\\b$", "^\\_$", "^[^/]+$", "^[]$", "^[z-a]$", "^[a-b-c]$", "^[a--]$", "^[a&&b]$", "^[[a]]$", "^a+?$", "^a**$", "^a{3,2}$", "^a{,2}$", "^(?=a)a$", "^(a)\\1$", "^a\$b$", "^é$", "^a\\$", "^a{65536}$", "^a{2,65536}$", "^[:a]$", "^[:alpha:]$", "^[--]$", "^[\\--a]$")
        for (pattern in portable) Pattern(pattern)
        for (pattern in refused) assertThrows(pattern, RegistryError::class.java) { Pattern(pattern) }
        assertTrue(Pattern("^[a-z]+$").matches("abc"))
        assertFalse(Pattern("^[a-z]+$").matches("abc\n"))
        assertTrue(Pattern("^[\\[-a]$").matches("_"))
        assertFalse(Pattern("^[\\[-a]$").matches("-"))
        assertTrue(Pattern("^a{65535}$").matches("a".repeat(65535)))
        assertFalse(Pattern("^a{65535}$").matches("a".repeat(65534)))
        println("portable patterns: 13 accepted, 31 rejected, 6 whole-value checks")
    }
    @Test fun quantumRequiresAFiniteIntegerReciprocal() {
        assertThrows(IllegalArgumentException::class.java) { Quantum(1e-320) }
        for (step in listOf(0.5, 0.25, 0.01, 1.0, 7.0)) Quantum(step)
        for (step in listOf(0.0, -1.0, 0.3, Double.NaN, Double.POSITIVE_INFINITY)) {
            assertThrows(IllegalArgumentException::class.java) { Quantum(step) }
        }
    }
    @Test fun registryIntegersDoNotNarrowToJvmInt() {
        val large = 4_294_967_297L
        val bounds = Bounds.read(Json.objectOf("unit" to Json.of("bytes"), "max" to Json.of(large)))!!
        assertEquals(large, bounds.max)
        assertTrue(bounds.admits(Json.of("abc")))
        val stamp = Stamp.of(1, 0, "a")
        val low = Register(Json.of("low"), stamp)
        val high = Register(Json.of("high"), stamp)
        assertEquals(high, Join.ranked(low, high, mapOf("low" to 2L, "high" to large)))
    }
}
