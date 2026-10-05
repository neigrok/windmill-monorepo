package works.windmill.sync.testing

import java.io.File
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.sync.core.*

@RunWith(Parameterized::class)
class NetworkCorpusTests(private val vector: Vector) {
    @Test fun vector() { Corpus.assertVector(vector, handlers.getValue(vector.file)) }
    companion object {
        private val root = File(System.getProperty("windmill.contract"), "sync")
        private val corpus = Corpus(File(root, "corpus"))
        private val registry = Registry(Json.parse(File(root, "probe.registry.json").readBytes()))
        private val handlers = NetworkCorpus.handlers(registry)
        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun vectors(): List<Array<Any>> = NetworkCorpus.paths.flatMap { corpus.vectors(it) }.map { arrayOf(it) }
    }
}
