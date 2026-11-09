package works.windmill.gym.presentation

import androidx.test.core.app.ApplicationProvider
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.spelled
import works.windmill.gym.string
import works.windmill.gym.R
import works.windmill.platform.i18n.Words

// Every string the screen draws, pinned byte for byte.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ConnectedLogTests {
    private val firstPaint: List<String>
        get() = listOf(
            string(R.string.gym_connected_title),
            string(R.string.gym_connected_head),
            string(LogLevel.Read.named), string(LogLevel.Read.reaches),
            string(LogLevel.Write.named), string(LogLevel.Write.reaches),
            string(LogLevel.Delete.named), string(LogLevel.Delete.reaches),
            string(R.string.gym_connected_caption),
            string(R.string.gym_connected_action),
            string(R.string.gym_connected_disclosure),
        )

    private fun ms(date: String): Long =
        LocalDate.parse(date).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()

    @Test
    fun theScreenCarriesTheBriefsStringsByteForByte() {
        assertEquals("Connected log", string(R.string.gym_connected_title))
        assertEquals("Your log, read by ChatGPT or Claude.", string(R.string.gym_connected_head))
        assertEquals(listOf("Read", "Write", "Delete"), LogLevel.entries.map { string(it.named) })
        assertEquals(
            listOf(
                "sets, workouts, routines, records, notes, weigh-ins",
                "logs sets · saves notes · adds routines · shares workouts · proposes changes",
                "discards a workout · ends a share",
            ),
            LogLevel.entries.map { string(it.reaches) },
        )
        assertEquals("A routine change waits for your Apply; the rest lands at once.", string(R.string.gym_connected_caption))
        assertEquals("Connect a tool", string(R.string.gym_connected_action))
        assertEquals("Sign in first", string(R.string.gym_connected_action_signed_out))
        assertEquals("opens in your browser", string(R.string.gym_connected_opens_in_browser))
        assertEquals("How this works", string(R.string.gym_connected_disclosure))
        assertEquals(
            listOf(
                "One URL pasted into your tool. Your browser opens once to approve.",
                "A shared workout is public for 30 days, until you end it.",
                "No tool can apply a proposal or edit a logged set.",
                "Delete is approved on its own, and a discard is permanent.",
                "End a connection under Settings → Connected tools; a key under API keys.",
            ),
            ConnectedLog.howItWorks.map { string(it) },
        )
        assertEquals("Connected", string(R.string.gym_connected_connected_head))
        assertEquals("A connected tool", string(R.string.gym_connected_unnamed_grant))
        assertEquals("A static key", string(R.string.gym_connected_unnamed_key))
        assertEquals("Couldn’t read your connections.", string(R.string.gym_connected_unread))
        assertEquals("Connect to the internet to read your connections.", string(R.string.gym_connected_offline))
    }

    // Everything the brief strikes: the pitch, the price, the desk, the four apply sentences, the
    // cannot column. And no sentence on the screen claims a state this phone did not read.
    @Test
    fun nothingTheBriefStrikesIsDrawnAndNothingNamesAPriceOrARoom() {
        val everyLine = firstPaint + ConnectedLog.howItWorks.map { string(it) } + listOf(
            R.string.gym_connected_action_signed_out, R.string.gym_connected_opens_in_browser, R.string.gym_connected_connected_head,
            R.string.gym_connected_unnamed_grant, R.string.gym_connected_unnamed_key, R.string.gym_connected_unread, R.string.gym_connected_offline,
        ).map { string(it) }
        val refused = listOf(
            "free", "sunday", "monday", "windmill one", "upgrade", "subscription", "trial", "premium",
            "unlock", "per month", "$", "€", "£", "coach", "csv", "export", "apply tool", "desk",
            "never", "cannot", "last read", " ago", "disconnect", "rest dial", "mcp",
        )
        assertEquals(emptyList<String>(), everyLine.filter { line -> refused.any { it in line.lowercase() } })
        assertEquals("the share's window is a numeral", listOf(string(ConnectedLog.howItWorks[1])),
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
        assertEquals("read · write · delete", LogReach("gym:delete gym:write gym:read").words.spelled())
        assertEquals("read · delete", LogReach("gym:delete gym:read").words.spelled())
        assertEquals("whole account", LogReach("").words.spelled())
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
                ConnectedTool("c1", Words.Plain("Claude Desktop"), ms("2026-08-12"), LogReach("gym:read gym:write gym:delete"), ConnectedTool.Credential.Approved),
                ConnectedTool("c2", Words.Plain("Cursor"), ms("2026-08-20"), LogReach(""), ConnectedTool.Credential.Approved),
                ConnectedTool("c4", Words.Plain("A connected tool"), ms("2025-12-01"), LogReach("gym:read"), ConnectedTool.Credential.Approved),
                ConnectedTool("k1", Words.Plain("A static key"), ms("2026-07-04"), LogReach(""), ConnectedTool.Credential.Pasted),
            )),
            state.spelled(),
        )
        val tools = (state as ConnectedLogState.Connected).tools
        assertEquals(
            listOf(
                "read · write · delete · since 12 Aug",
                "whole account · since 20 Aug",
                "read · since 1 Dec 2025",
                "API key · whole account · since 4 Jul",
            ),
            tools.map { it.described(now).spelled() },
        )
        assertEquals(ConnectedLogState.None, ConnectedLog.state(emptyList(), emptyList()))
        assertEquals("a grant that reaches no gym level is nobody connected here", ConnectedLogState.None,
            ConnectedLog.state(listOf(OAuthGrant("c3", "Codex", 1L, "roadmap:read")), emptyList()))
    }

    @Test
    fun onlyAnAnswerForTheSeatCountsAsAnswered() {
        assertEquals(listOf(false, false, false, true, true), listOf(
            ConnectedLogState.Unknown, ConnectedLogState.Refused, ConnectedLogState.Offline, ConnectedLogState.None,
            ConnectedLogState.Connected(emptyList()),
        ).map { it.answered })
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

private fun ConnectedLogState.spelled(): ConnectedLogState = if (this !is ConnectedLogState.Connected) this
    else ConnectedLogState.Connected(tools.map { it.copy(named = Words.Plain(it.named.text(ApplicationProvider.getApplicationContext()))) })
