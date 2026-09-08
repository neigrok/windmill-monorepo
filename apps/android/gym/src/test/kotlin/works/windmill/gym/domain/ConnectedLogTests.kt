package works.windmill.gym.domain

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

// Every string the screen draws, pinned byte for byte to docs/design/gym/briefs/19-connected-log.md.
class ConnectedLogTests {
    // Word counts off the strings a lifter reads: a token is a run of letters, digits or an
    // apostrophe, so `weigh-ins` is two and `·` and `→` are none.
    private fun words(lines: List<String>): Int =
        lines.sumOf { Regex("[\\p{L}\\p{N}’']+").findAll(it).count() }

    private val firstPaint = listOf(
        ConnectedLog.title,
        ConnectedLog.head,
        LogLevel.Read.label, LogLevel.Read.meta,
        LogLevel.Write.label, LogLevel.Write.meta,
        LogLevel.Delete.label, LogLevel.Delete.meta,
        ConnectedLog.caption,
        ConnectedLog.action,
        ConnectedLog.disclosure,
    )

    private fun ms(date: String): Long =
        LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()

    @Test
    fun theScreenCarriesTheBriefsStringsByteForByte() {
        assertEquals("Connected log", ConnectedLog.title)
        assertEquals("Your log, read by Claude, Cursor or Codex.", ConnectedLog.head)
        assertEquals(listOf("Read", "Write", "Delete"), LogLevel.entries.map { it.label })
        assertEquals(
            listOf(
                "sets, workouts, routines, records, notes, weigh-ins",
                "logs sets · adds routines · shares workouts · proposes changes",
                "discards a workout · ends a share",
            ),
            LogLevel.entries.map { it.meta },
        )
        assertEquals("A routine change waits for your Apply; the rest lands at once.", ConnectedLog.caption)
        assertEquals("Connect a tool", ConnectedLog.action)
        assertEquals("Sign in first", ConnectedLog.actionSignedOut)
        assertEquals("opens in your browser", ConnectedLog.opensInBrowser)
        assertEquals("How this works", ConnectedLog.disclosure)
        assertEquals(
            listOf(
                "One URL pasted into your tool. Your browser opens once to approve.",
                "A shared workout is public for 30 days, until you end it.",
                "No tool can apply a proposal or edit a logged set.",
                "Delete is approved on its own, and a discard is permanent.",
                "End a connection under Settings → Connected tools; a key under API keys.",
            ),
            ConnectedLog.how,
        )
        assertEquals("Connected", ConnectedLog.connectedHead)
        assertEquals("A connected tool", ConnectedLog.unnamedGrant)
        assertEquals("A static key", ConnectedLog.unnamedKey)
        assertEquals("Couldn’t read your connections.", ConnectedLog.unread)
        assertEquals("Manage connections", ConnectedLog.manage)
        assertEquals("your AI tools", ConnectedLog.settingsUnknown)
        assertEquals("nothing connected yet", ConnectedLog.settingsNone)
    }

    // The arithmetic in the brief: 28 words of chrome, 52 with the three level rows drawn, 110 with
    // the disclosure open.
    @Test
    fun theScreenSpendsFiftyTwoWordsOnFirstPaintAndOneHundredAndTenOpen() {
        assertEquals(28, words(listOf(ConnectedLog.title, ConnectedLog.head, ConnectedLog.caption,
            ConnectedLog.action, ConnectedLog.disclosure)))
        assertEquals(52, words(firstPaint))
        assertEquals(110, words(firstPaint + ConnectedLog.how))
    }

    // Everything the brief strikes: the pitch, the price, the desk, the four apply sentences, the
    // cannot column. And no sentence on the screen claims a state this phone did not read.
    @Test
    fun nothingTheBriefStrikesIsDrawnAndNothingNamesAPriceOrARoom() {
        val everyLine = firstPaint + ConnectedLog.how + listOf(
            ConnectedLog.actionSignedOut, ConnectedLog.opensInBrowser, ConnectedLog.connectedHead,
            ConnectedLog.unnamedGrant, ConnectedLog.unnamedKey, ConnectedLog.unread, ConnectedLog.manage,
            ConnectedLog.settingsUnknown, ConnectedLog.settingsNone,
        )
        val refused = listOf(
            "free", "sunday", "monday", "windmill one", "upgrade", "subscription", "trial", "premium",
            "unlock", "per month", "$", "€", "£", "coach", "csv", "export", "apply tool", "desk",
            "never", "cannot", "last read", " ago", "disconnect", "rest dial", "mcp",
        )
        assertEquals(emptyList<String>(), everyLine.filter { line -> refused.any { it in line.lowercase() } })
        assertEquals("the share's window is a numeral", listOf(ConnectedLog.how[1]),
            everyLine.filter { "30 days" in it })
    }

    @Test
    fun aScopeReadsAsTheLevelsItNamesAndTheEmptyScopeIsTheWholeAccount() {
        assertEquals(LogReach(setOf(LogLevel.Read), accountWide = false), LogReach("gym:read"))
        assertEquals(
            LogReach(setOf(LogLevel.Read, LogLevel.Write, LogLevel.Delete), accountWide = false),
            LogReach("gym:delete roadmap:write gym:read gym:write"),
        )
        assertEquals(LogReach(LogLevel.entries.toSet(), accountWide = true), LogReach(""))
        assertEquals(LogReach(LogLevel.entries.toSet(), accountWide = true), LogReach("  "))
        assertEquals("a roadmap-only grant reaches nothing here",
            LogReach(emptySet(), accountWide = false), LogReach("roadmap:read roadmap:write"))
        assertEquals("a token nobody can parse confers nothing",
            LogReach(emptySet(), accountWide = false), LogReach("gym gym: :read gymx:read"))
        assertEquals("read · write · delete", LogReach("gym:delete gym:write gym:read").line)
        assertEquals("read · delete", LogReach("gym:delete gym:read").line)
        assertEquals("whole account", LogReach("").line)
    }

    @Test
    fun theTwoListsBecomeOneStateAndOtherProductsGrantsAreNotDrawn() {
        val now = ms("2026-09-09")
        val state = ConnectedLog.state(
            grants = listOf(
                OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = ms("2026-08-12"), scope = "gym:read gym:write gym:delete"),
                OAuthGrant(clientId = "c2", name = "Cursor", grantedMs = ms("2026-08-20"), scope = ""),
                OAuthGrant(clientId = "c3", name = "Codex", grantedMs = ms("2026-08-21"), scope = "roadmap:read"),
                OAuthGrant(clientId = "c4", name = "  ", grantedMs = ms("2025-12-01"), scope = "gym:read"),
            ),
            keys = listOf(McpKey(id = "k1", name = "", createdMs = ms("2026-07-04"))),
        )

        assertEquals(
            ConnectedLogState.Connected(listOf(
                ConnectedTool("c1", "Claude Desktop", ms("2026-08-12"), LogReach("gym:read gym:write gym:delete"), ConnectedTool.Credential.Approved),
                ConnectedTool("c2", "Cursor", ms("2026-08-20"), LogReach(""), ConnectedTool.Credential.Approved),
                ConnectedTool("c4", "A connected tool", ms("2025-12-01"), LogReach("gym:read"), ConnectedTool.Credential.Approved),
                ConnectedTool("k1", "A static key", ms("2026-07-04"), LogReach(""), ConnectedTool.Credential.Pasted),
            )),
            state,
        )
        val tools = (state as ConnectedLogState.Connected).tools
        assertEquals(
            listOf(
                "read · write · delete · since 12 Aug",
                "whole account · since 20 Aug",
                "read · since 1 Dec 2025",
                "API key · whole account · since 4 Jul",
            ),
            tools.map { it.meta(now) },
        )
        assertEquals("4 tools", state.settingsMeta)
        assertEquals(ConnectedLogState.None, ConnectedLog.state(emptyList(), emptyList()))
        assertEquals("a grant that reaches no gym level is nobody connected here", ConnectedLogState.None,
            ConnectedLog.state(listOf(OAuthGrant("c3", "Codex", 1L, "roadmap:read")), emptyList()))
    }

    @Test
    fun theSettingsRowPrintsTheStateAndNothingElse() {
        assertEquals("your AI tools", ConnectedLogState.Unknown.settingsMeta)
        assertEquals("your AI tools", ConnectedLogState.Refused.settingsMeta)
        assertEquals(listOf(false, false, true, true), listOf(
            ConnectedLogState.Unknown, ConnectedLogState.Refused, ConnectedLogState.None,
            ConnectedLogState.Connected(emptyList()),
        ).map { it.answered })
        assertEquals("nothing connected yet", ConnectedLogState.None.settingsMeta)
        assertEquals("Claude Desktop · read · write",
            ConnectedLog.state(listOf(OAuthGrant("c1", "Claude Desktop", 1L, "gym:write gym:read")), emptyList()).settingsMeta)
        assertEquals("Cursor · whole account",
            ConnectedLog.state(listOf(OAuthGrant("c2", "Cursor", 1L, "")), emptyList()).settingsMeta)
        assertEquals("2 tools",
            ConnectedLog.state(listOf(OAuthGrant("c1", "Claude Desktop", 1L, "gym:read")),
                listOf(McpKey("k1", "laptop", 1L))).settingsMeta)
    }

    @Test
    fun bothDoorsAreSpelledOffTheOriginTheAppTalksTo() {
        assertEquals("https://windmill.works/#/connect", ConnectedLog.setupUrl("https://windmill.works/"))
        assertEquals("https://windmill.works/#/connect", ConnectedLog.setupUrl("https://windmill.works"))
        assertEquals("http://10.0.2.2:8088/#/connect", ConnectedLog.setupUrl("http://10.0.2.2:8088/"))
        assertEquals("https://windmill.works/#/settings", ConnectedLog.connectionsUrl("https://windmill.works/"))
        assertEquals("http://10.0.2.2:8088/#/settings", ConnectedLog.connectionsUrl("http://10.0.2.2:8088"))
    }
}
