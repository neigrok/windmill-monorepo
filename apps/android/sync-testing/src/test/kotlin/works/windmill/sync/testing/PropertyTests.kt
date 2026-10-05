package works.windmill.sync.testing

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Random
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.core.*

class PropertyTests {
    @Test fun property1LatticeLaws() {
        val rank = mapOf("draft" to 0L, "review" to 1L, "done" to 2L, "dropped" to 2L)
        val type = Registry(Json.parse(java.io.File(CorpusTests.root, "sync/probe.registry.json").readBytes())).type("card")!!
        var checks = 0
        repeat(128) { seed ->
            val random = Random(seed.toLong())
            fun stamp() = Stamp.of(random.nextInt(4).toLong(), random.nextInt(2).toLong(), listOf("a", "b")[random.nextInt(2)])
            fun register(ranked: Boolean): Register? = if (random.nextInt(5) == 0) null else Register(
                if (ranked) Json.of(rank.keys.toList()[random.nextInt(4)]) else listOf(Json.Null, Json.of(0), Json.of(1), Json.of("é"), Json.of("e\u0301"))[random.nextInt(5)], stamp(),
            )
            fun <V> laws(a: V?, b: V?, c: V?, join: (V?, V?) -> V?) {
                assertEquals(join(a, b), join(b, a)); assertEquals(a, join(a, a))
                assertEquals(join(join(a, b), c), join(a, join(b, c))); checks += 3
            }
            repeat(64) {
                val a = register(false); val b = register(false); val c = register(false)
                laws(a, b, c, Join::lww); laws(a, b, c, Join::fww)
                laws(register(true), register(true), register(true)) { x, y -> Join.ranked(x, y, rank) }
                fun life(): Life? = if (random.nextInt(5) == 0) null else Life(if (random.nextBoolean()) "alive" else "dead", stamp())
                laws(life(), life(), life(), Join::life)
                laws(if (random.nextBoolean()) null else stamp(), stamp(), stamp(), Join::born)
                val left = Lattice(fields = a?.let { mapOf("title" to it) } ?: emptyMap())
                val middle = Lattice(fields = b?.let { mapOf("title" to it) } ?: emptyMap())
                val right = Lattice(fields = c?.let { mapOf("title" to it) } ?: emptyMap())
                laws(left, middle, right) { x, y -> Join.record(type, x ?: Lattice(), y ?: Lattice()) }
            }
        }
        println("property 1: 128 seeds × 64 steps, $checks law assertions")
    }

    @Test fun property5FractionalOrder() {
        var checks = 0
        repeat(128) { seed ->
            val random = Random(seed.toLong())
            val keys = mutableListOf<FractionalKey>()
            repeat(128) {
                val at = random.nextInt(keys.size + 1)
                val lower = keys.getOrNull(at - 1)
                val upper = keys.getOrNull(at)
                val key = FractionalKey.between(lower, upper)
                assertTrue(lower == null || lower < key); assertTrue(upper == null || key < upper)
                keys.add(at, key); checks += 2
            }
        }
        println("property 5: 128 seeds × 128 insertions, $checks order assertions")
    }

    @Test fun property6IncrementalDigestAgainstIndependentSha256() {
        val modulus = BigInteger.ONE.shiftLeft(256)
        var checks = 0
        repeat(128) { seed ->
            val random = Random(seed.toLong())
            val rows = linkedMapOf<Int, Json>()
            var digest = ScopeDigest.ZERO
            repeat(128) { step ->
                val id = random.nextInt(32)
                val before = rows[id]
                val after = if (random.nextInt(4) == 0) null else Json.objectOf(
                    "t" to Json.of("card"), "id" to Json.of("id_$id"), "seq" to Json.of(step),
                    "life" to Life(if (random.nextInt(4) == 0) "dead" else "alive", Stamp.of(step.toLong(), 0, "srv")).json,
                    "f" to Json.objectOf("title" to Register(Json.of("seed_$seed-$step"), Stamp.of(step.toLong(), 0, "srv")).json),
                )
                digest = digest.replacing(before, after)
                if (after == null) rows.remove(id) else rows[id] = after
                val oracle = rows.values.filter { it.member("life").arr()[0].str() == "alive" }.fold(BigInteger.ZERO) { sum, row ->
                    sum + BigInteger(1, MessageDigest.getInstance("SHA-256").digest(row.jcs.toByteArray(Charsets.UTF_8)))
                }.mod(modulus).toString(16).padStart(64, '0')
                assertEquals(oracle, digest.hex); assertEquals(ScopeDigest.rows(rows.values.toList()), digest)
                checks += 2
            }
        }
        println("property 6: 128 seeds × 128 mutations, $checks digest assertions")
    }
}
