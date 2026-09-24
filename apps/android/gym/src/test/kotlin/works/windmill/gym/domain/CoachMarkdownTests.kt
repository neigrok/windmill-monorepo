package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.CoachBlock.Code
import works.windmill.gym.domain.CoachBlock.Heading
import works.windmill.gym.domain.CoachBlock.ListItem
import works.windmill.gym.domain.CoachBlock.Paragraph
import works.windmill.gym.domain.CoachBlock.Rule

class CoachMarkdownTests {
    private fun paragraph(vararg spans: CoachSpan) = Paragraph(spans.toList())
    private fun paragraph(text: String) = Paragraph(listOf(CoachSpan(text)))
    private fun bullet(text: String, depth: Int = 0) = ListItem(null, depth, listOf(CoachSpan(text)))
    private fun numbered(ordinal: Int, text: String) = ListItem(ordinal, 0, listOf(CoachSpan(text)))
    private fun spansOf(block: CoachBlock): List<CoachSpan> = when (block) {
        is Paragraph -> block.spans
        is Heading -> block.spans
        is ListItem -> block.spans
        is Code -> listOf(CoachSpan(block.text, code = true))
        Rule -> emptyList()
    }

    @Test
    fun plainTextComesBackByteForByteAndASingleNewlineStaysInsideTheParagraph() {
        val answer = "Café\n東京 — 🏋🏽‍♀️ é\nFinal words."

        assertEquals(listOf(paragraph(answer)), CoachMarkdown.parse(answer))
        assertEquals(answer, CoachMarkdown.plain(answer))
    }

    @Test
    fun aBlankLineSplitsParagraphsAndCopyKeepsTheBlankLine() {
        val answer = "First paragraph.\n\nSecond paragraph — exact text."

        assertEquals(
            listOf(paragraph("First paragraph."), paragraph("Second paragraph — exact text.")),
            CoachMarkdown.parse(answer),
        )
        assertEquals(answer, CoachMarkdown.plain(answer))
    }

    @Test
    fun theAnswersOwnWhitespaceIsNotTrimmed() {
        assertEquals(listOf(paragraph(" keep ")), CoachMarkdown.parse(" keep \n\n"))
        assertEquals(" keep \n\n", CoachMarkdown.plain(" keep \n\n"))
        assertEquals("  \n \n", CoachMarkdown.plain("  \n \n"))
    }

    @Test
    fun nothingToSayParsesToNothing() {
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse(""))
        assertEquals("", CoachMarkdown.plain(""))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("  \n\n"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("``"))
    }

    @Test
    fun anyOfTheThreeBulletMarkersMakesABullet() {
        assertEquals(
            listOf(bullet("squat"), bullet("bench"), bullet("row")),
            CoachMarkdown.parse("- squat\n* bench\n+ row"),
        )
    }

    @Test
    fun aNumberedItemKeepsTheOrdinalAsWritten() {
        assertEquals(
            listOf(numbered(1, "squat"), numbered(3, "bench"), numbered(7, "row")),
            CoachMarkdown.parse("1. squat\n3. bench\n7) row"),
        )
    }

    @Test
    fun fourSpacesOrATabNestOneLevelAndNoDeeper() {
        assertEquals(
            listOf(bullet("a"), bullet("b", depth = 1), bullet("c", depth = 1), bullet("d", depth = 1), bullet("e")),
            CoachMarkdown.parse("- a\n    - b\n\t- c\n        - d\n   - e"),
        )
    }

    @Test
    fun linesUnderAnItemJoinItUntilABlankLine() {
        assertEquals(
            listOf(
                ListItem(null, 0, listOf(CoachSpan("a\nmore\nstill"))),
                ListItem(1, 0, listOf(CoachSpan("b\nunder"))),
            ),
            CoachMarkdown.parse("- a\n  more\nstill\n\n1. b\n    under"),
        )
    }

    @Test
    fun oneToThreeHashesHeadAndFourAreJustText() {
        assertEquals(
            listOf(
                paragraph("Intro"),
                Heading(1, listOf(CoachSpan("One"))),
                Heading(2, listOf(CoachSpan("Two"))),
                Heading(3, listOf(CoachSpan("Three"))),
                paragraph("#### Four"),
            ),
            CoachMarkdown.parse("Intro\n# One\n## Two\n### Three\n#### Four"),
        )
    }

    @Test
    fun inlineMarkersStyleTheirRunAndVanish() {
        assertEquals(
            listOf(
                paragraph(
                    CoachSpan("bold", bold = true),
                    CoachSpan(" and "),
                    CoachSpan("also", bold = true),
                    CoachSpan(" then "),
                    CoachSpan("it", italic = true),
                    CoachSpan(" and "),
                    CoachSpan("it2", italic = true),
                    CoachSpan(" and "),
                    CoachSpan("both", bold = true, italic = true),
                    CoachSpan(" plus "),
                    CoachSpan("x*y", code = true),
                    CoachSpan(" end"),
                ),
            ),
            CoachMarkdown.parse("**bold** and __also__ then *it* and _it2_ and ***both*** plus `x*y` end"),
        )
    }

    @Test
    fun escapesResolveAndALinkKeepsOnlyItsText() {
        assertEquals(
            listOf(paragraph("*not* _lit_ `tick` \\ Bench [not a link] [nor](with space)")),
            CoachMarkdown.parse("\\*not\\* \\_lit\\_ \\`tick\\` \\\\ [Bench](https://x.y/z) [not a link] [nor](with space)"),
        )
        assertEquals(listOf(paragraph("# not a heading")), CoachMarkdown.parse("\\# not a heading"))
    }

    @Test
    fun arithmeticAndSnakeCaseStayLiteral() {
        val answer = "5 * 5 and 3*8 reps, snake_case_name, a_b, 2 ** 3"

        assertEquals(listOf(paragraph(answer)), CoachMarkdown.parse(answer))
        assertEquals(
            listOf(paragraph(CoachSpan("5 * 5", bold = true))),
            CoachMarkdown.parse("**5 * 5**"),
        )
    }

    @Test
    fun neighbouringSpansOfOneStyleAreOneSpan() {
        assertEquals(listOf(paragraph(CoachSpan("ab", code = true))), CoachMarkdown.parse("`a``b`"))
        assertEquals(
            listOf(paragraph(CoachSpan("a", bold = true, italic = true), CoachSpan(" b", italic = true))),
            CoachMarkdown.parse("***a** b*"),
        )
    }

    @Test
    fun aFenceHoldsItsLinesVerbatim() {
        assertEquals(
            listOf(paragraph("before"), Code("val x = 1\n\n  y"), paragraph("after")),
            CoachMarkdown.parse("before\n```kotlin\nval x = 1\n\n  y\n```\nafter"),
        )
    }

    @Test
    fun aFenceStillOpenAtTheEndShowsWhatItHasSoFar() {
        assertEquals(listOf(paragraph("Try:"), Code("foo\nbar")), CoachMarkdown.parse("Try:\n```\nfoo\nbar\n"))
        assertEquals(listOf(Code("")), CoachMarkdown.parse("```"))
        assertEquals(listOf(Code("")), CoachMarkdown.parse("```\n"))
    }

    @Test
    fun aCloserBeingTypedUnderAnOpenFenceIsNotCodeYet() {
        assertEquals(listOf(Code("foo")), CoachMarkdown.parse("```\nfoo\n`"))
        assertEquals(listOf(Code("foo")), CoachMarkdown.parse("```\nfoo\n``"))
        assertEquals(listOf(Code("foo")), CoachMarkdown.parse("```\nfoo\n```"))
        assertEquals("copy keeps the line as written", "foo\n``", CoachMarkdown.plain("```\nfoo\n``"))
    }

    @Test
    fun aLinkWhoseUrlIsStillArrivingShowsItsTextAlready() {
        assertEquals(listOf(paragraph("See [plan")), CoachMarkdown.parse("See [plan"))
        assertEquals(listOf(paragraph("See [plan]")), CoachMarkdown.parse("See [plan]"))
        assertEquals(listOf(paragraph("See plan")), CoachMarkdown.parse("See [plan]("))
        assertEquals(listOf(paragraph("See plan")), CoachMarkdown.parse("See [plan](https://x.y/pl"))
        assertEquals(listOf(paragraph("See plan now")), CoachMarkdown.parse("See [plan](https://x.y/plan) now"))
        assertEquals("brackets before prose in parentheses are not a link",
            listOf(paragraph("[note](see the")), CoachMarkdown.parse("[note](see the"))
    }

    @Test
    fun threeDashesStarsOrUnderscoresRuleALine() {
        assertEquals(
            listOf(paragraph("a"), Rule, paragraph("b"), Rule, Rule),
            CoachMarkdown.parse("a\n---\nb\n***  \n___"),
        )
    }

    @Test
    fun anOpenerStillWaitingForItsCloserStylesTheTailAsItGrows() {
        assertEquals(
            listOf(paragraph(CoachSpan("Add "), CoachSpan("one more", bold = true))),
            CoachMarkdown.parse("Add **one more"),
        )
        assertEquals(
            listOf(paragraph(CoachSpan("Add "), CoachSpan("one", italic = true))),
            CoachMarkdown.parse("Add *one"),
        )
        assertEquals(
            listOf(paragraph(CoachSpan("Add "), CoachSpan("one", italic = true))),
            CoachMarkdown.parse("Add _one"),
        )
        assertEquals(
            listOf(paragraph(CoachSpan("Add "), CoachSpan("one", bold = true))),
            CoachMarkdown.parse("Add __one"),
        )
        assertEquals(
            listOf(paragraph(CoachSpan("Add "), CoachSpan("one", code = true))),
            CoachMarkdown.parse("Add `one"),
        )
        assertEquals(
            listOf(paragraph(CoachSpan("Add "), CoachSpan("bold", bold = true), CoachSpan(" then "), CoachSpan("more", bold = true))),
            CoachMarkdown.parse("Add **bold** then **more"),
        )
    }

    @Test
    fun aMarkerWithNothingAfterItIsSwallowed() {
        assertEquals(listOf(paragraph("Add ")), CoachMarkdown.parse("Add **"))
        assertEquals(listOf(paragraph("Add ")), CoachMarkdown.parse("Add *"))
        assertEquals(listOf(paragraph("Add ")), CoachMarkdown.parse("Add _"))
        assertEquals("what was swallowed while it was the tail stays swallowed once the answer moves on",
            listOf(paragraph("Add "), paragraph("more")), CoachMarkdown.parse("Add *\n\nmore"))
    }

    @Test
    fun aBareBlockMarkerOnTheLastLineWaitsForItsNextToken() {
        assertEquals(listOf(bullet("squat")), CoachMarkdown.parse("- squat\n-"))
        assertEquals(listOf(bullet("squat")), CoachMarkdown.parse("- squat\n- "))
        assertEquals(listOf(bullet("squat"), bullet("bench")), CoachMarkdown.parse("- squat\n- bench"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("1."))
        assertEquals(listOf(numbered(1, "Squat")), CoachMarkdown.parse("1. Squat"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("#"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("##"))
        assertEquals(listOf(Heading(1, listOf(CoachSpan("T")))), CoachMarkdown.parse("# T"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("*"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("+"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("12)"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("    -"))
        assertEquals(listOf(paragraph("Plan:")), CoachMarkdown.parse("Plan:\n#"))
        assertEquals("only the tail waits; a bare marker the model moved past is text",
            listOf(paragraph("-\nnext")), CoachMarkdown.parse("-\nnext"))
    }

    @Test
    fun aLoneDigitOrDashOnTheLastLineIsAMarkerStillBeingTyped() {
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("1"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("    12"))
        assertEquals(listOf(paragraph("Three sets")), CoachMarkdown.parse("Three sets\n\n1"))
        assertEquals(listOf(bullet("a")), CoachMarkdown.parse("- a\n1"))
        assertEquals(listOf(bullet("a"), numbered(1, "b")), CoachMarkdown.parse("- a\n1. b"))
        assertEquals(emptyList<CoachBlock>(), CoachMarkdown.parse("--"))
        assertEquals(listOf(paragraph("a")), CoachMarkdown.parse("a\n--"))
        assertEquals(listOf(paragraph("a"), Rule), CoachMarkdown.parse("a\n---"))
        assertEquals("copy keeps what is held", "a\n--", CoachMarkdown.plain("a\n--"))
    }

    @Test
    fun everyPrefixOfARealAnswerShowsNoRawMarkerAndNeverLosesABlock() {
        val answer = "# Plan for next week\n\n" +
            "Your **squat** stalled at 100 kg — three weeks flat. Two changes:\n\n" +
            "- Drop to *90 kg* and add a set\n" +
            "- Keep `RPE 8` on the last set\n" +
            "    - Back-off at 80 kg\n\n" +
            "1. Monday: squat 5×5\n" +
            "2. Thursday: bench 3×8\n\n" +
            "```\nweek 1: 90 → 92.5 → 95\n```\n\n" +
            "---\n\n" +
            "More on this: [Café — 東京](https://example.com/plan) 🏋🏽‍♀️"

        var blocksSoFar = 0
        for (length in 0..answer.length) {
            val blocks = CoachMarkdown.parse(answer.substring(0, length))
            val spans = blocks.flatMap(::spansOf)
            assertEquals("a raw marker at prefix $length", emptyList<CoachSpan>(),
                spans.filter { "**" in it.text || "__" in it.text })
            assertEquals("a stray backtick at prefix $length", emptyList<String>(),
                blocks.map { block -> spansOf(block).joinToString("") { it.text } }.filter { it.endsWith("`") })
            assertTrue("blocks went from $blocksSoFar to ${blocks.size} at prefix $length", blocks.size >= blocksSoFar)
            blocksSoFar = blocks.size
        }
        assertEquals(
            listOf(
                Heading(1, listOf(CoachSpan("Plan for next week"))),
                paragraph(CoachSpan("Your "), CoachSpan("squat", bold = true), CoachSpan(" stalled at 100 kg — three weeks flat. Two changes:")),
                ListItem(null, 0, listOf(CoachSpan("Drop to "), CoachSpan("90 kg", italic = true), CoachSpan(" and add a set"))),
                ListItem(null, 0, listOf(CoachSpan("Keep "), CoachSpan("RPE 8", code = true), CoachSpan(" on the last set"))),
                bullet("Back-off at 80 kg", depth = 1),
                numbered(1, "Monday: squat 5×5"),
                numbered(2, "Thursday: bench 3×8"),
                Code("week 1: 90 → 92.5 → 95"),
                Rule,
                paragraph("More on this: Café — 東京 🏋🏽‍♀️"),
            ),
            CoachMarkdown.parse(answer),
        )
    }

    @Test
    fun copyStripsTheMarkupAndKeepsTheLines() {
        val answer = "# Plan\n\n**Squat**: keep *5x5*.\n- add `1 set`\n    next week\n1) rest\n\n```\nx = 1\n```\n---\n[link](http://a) \\*star\\*\n"

        assertEquals(
            "Plan\n\nSquat: keep 5x5.\n- add 1 set\nnext week\n1) rest\n\nx = 1\n---\nlink *star*\n",
            CoachMarkdown.plain(answer),
        )
        assertEquals(
            listOf(
                Heading(1, listOf(CoachSpan("Plan"))),
                paragraph(CoachSpan("Squat", bold = true), CoachSpan(": keep "), CoachSpan("5x5", italic = true), CoachSpan(".")),
                ListItem(null, 0, listOf(CoachSpan("add "), CoachSpan("1 set", code = true), CoachSpan("\nnext week"))),
                numbered(1, "rest"),
                Code("x = 1"),
                Rule,
                paragraph("link *star*"),
            ),
            CoachMarkdown.parse(answer),
        )
    }
}
