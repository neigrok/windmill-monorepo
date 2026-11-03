package works.windmill.domain.kit

import org.junit.Assert.*
import org.junit.Test

class CollationTests {
    @Test fun nfdDecomposesWhatNormaliseComposes() {
        assertEquals("é", Nfc.nfd("é"))
        assertEquals("é", Nfc.normalise("é"))
        assertEquals("ạ́", Nfc.nfd("ạ́"))
    }

    @Test fun twoCanonicalSpellingsOfOneNameTieAtEveryLevel() {
        assertEquals(0, Collation.order.compare("éclair", "éclair"))
        assertFalse(Collation.precedes("éclair", "éclair"))
        assertFalse(Collation.precedes("éclair", "éclair"))
        assertEquals(listOf("é", "é"), listOf("é", "é").sortedWith(Collation.order))
        assertEquals(listOf("é", "é"), listOf("é", "é").sortedWith(Collation.order))
    }

    @Test fun orderAndPrecedesAgreeBothWays() {
        val names = listOf("", "a", "A", "á", "Á", "b", "a️a", "áa", "ab", " ", "1", "😀", "Ａ", "𐐀")
        for (a in names) for (b in names) {
            assertEquals("$a $b", Collation.precedes(a, b), Collation.order.compare(a, b) < 0)
            assertEquals("$a $b", Collation.precedes(b, a), Collation.order.compare(a, b) > 0)
        }
    }
}
