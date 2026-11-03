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
        assertEquals(listOf("é", "é"), listOf("é", "é").sortedWith(Collation.order))
        assertEquals(listOf("é", "é"), listOf("é", "é").sortedWith(Collation.order))
    }

    @Test fun theOrderAnswersOppositelyBothWays() {
        val names = listOf("", "a", "A", "á", "Á", "b", "a️a", "áa", "ab", " ", "1", "😀", "Ａ", "𐐀")
        for (a in names) for (b in names) {
            assertEquals("$a $b", Integer.signum(Collation.order.compare(a, b)), -Integer.signum(Collation.order.compare(b, a)))
        }
    }

    // Other_Uppercase lists after its lowercase like any capital. `Character.isUpperCase` answers these on the JVM and not on Android, so this holds on both only through Collation's own table.
    @Test fun otherUppercaseReadsAsUppercase() {
        for ((upper, lower) in listOf("\u2160" to "\u2170", "\u24B6" to "\u24D0")) {
            assertEquals(listOf(lower, upper), listOf(upper, lower).sortedWith(Collation.order))
        }
    }
}
