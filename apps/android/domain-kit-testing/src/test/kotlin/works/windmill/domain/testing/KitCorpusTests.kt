package works.windmill.domain.testing

import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.sync.testing.*

@RunWith(Parameterized::class)
class KitCorpusTests(private val vector: Vector) {
    @Test fun vector() { Corpus.assertVector(vector, KitCorpus.handlers.getValue(vector.file)) }
    companion object {
        val corpus = Corpus(File(System.getProperty("windmill.contract"), "domain-kit"))
        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun vectors(): List<Array<Any>> = KitCorpus.handlers.keys.sorted().flatMap { corpus.vectors(it) }.map { arrayOf(it) }
    }
}

class KitCoverageTests {
    @Test fun completeKitGateClaimsEveryFileAndCase() {
        val corpus = KitCorpusTests.corpus
        val missing = corpus.unclaimed(KitCorpus.handlers, corpus.paths)
        assertEquals(emptyList<String>(), missing)
        corpus.requireCoverage(KitCorpus.handlers, corpus.paths)
        assertEquals(corpus.paths.toSet(), KitCorpus.handlers.keys)
        assertTrue(corpus.paths.sumOf { corpus.vectors(it).size } >= 475)
        assertThrows(IllegalStateException::class.java) { corpus.requireCoverage(KitCorpus.handlers, corpus.paths + "unclaimed.json") }
        println("kit corpus: ${KitCorpus.handlers.size}/${corpus.paths.size} files, ${KitCorpus.handlers.keys.sumOf { corpus.vectors(it).size }}/${corpus.paths.sumOf { corpus.vectors(it).size }} vectors")
    }
}
