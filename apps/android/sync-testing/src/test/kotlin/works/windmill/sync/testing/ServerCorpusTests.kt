package works.windmill.sync.testing

import java.io.File
import org.junit.Test

class ServerCorpusTests {
    @Test fun everyClaimedServerFile() {
        runServerCorpus(CorpusTests.root)
    }
}
