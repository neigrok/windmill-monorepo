package works.windmill.gym.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// ASK HAS A PAST (§O, screen 33) — and this file is the reversal of a decision W7 made on purpose.
//
// W7 built Ask STATELESS: no conversation table, the client composing and re-sending the whole
// thread on every question, and it said so in its own comments. §O overturns it for a product
// reason rather than a technical one — a conversation about your bench plateau is worth more in six
// weeks than it was that evening — so the server now keeps the thread, titles it by the lifter's
// FIRST MESSAGE VERBATIM, and hands the past back as a list.
//
// WHAT WENT WITH THAT DECISION: `Ask.thread()` composed a turns array here and is gone, because the
// server assembles the prompt from what it stored — the conversation a lifter reads back is the one
// the model saw, which two copies of the composing rule could never guarantee. One question goes out
// now, against a thread id this phone mints.
//
// THE LIST IS NOT AN INBOX, and that is the rule most of this file exists to hold: no unread count,
// no badge, no notification, no auto-title, no search, no folders, and nothing that resurfaces a
// thread on its own. A threads screen is the most natural place in this whole product to grow a
// badge, and it must not.
//
// EVERY ROW'S DETAIL IS SOMETHING THE SERVER OBSERVED. The board draws a dismissed thread reading
// `built it myself instead` and that line cannot ship: nothing observes WHY a lifter dismissed a
// proposal and this product does not ask, so the sentence would be us narrating a motive onto
// somebody's evening — one line under the rule that a thread is titled by your own words and never
// by a summary a model wrote about you. A dismissed row carries WHAT was dismissed and nothing else.

// THE QUESTION ON THE WIRE, and both fields carry NO DEFAULT — the same landmine `AskStep` names
// from the other side. The app's one Json omits any value equal to its declared default
// (WindmillJson, `encodeDefaults` off), so a thread id defaulted to the empty string would travel as
// an ABSENT key and the log would refuse the question as malformed.
//
// The thread id is THIS PHONE'S to mint (`Ids.thread`): a fresh one opens a conversation, a spent
// one continues it, which is what lets a question be re-sent after a 502 without minting a second
// conversation out of one evening. IT IS NOT A REPLAY KEY: it names the conversation and not the
// question, and no field here identifies the question at all — so a reply lost after the log
// answered means asking again stores a second turn. Nothing re-sends on its own for that reason.
@Serializable
data class AskQuestion(val thread: String, val question: String)

// ONE TURN AS THE LOG STORED IT, byte for byte as it was sent. It arrives on the DETAIL read only —
// the list carries no turns at all, because a list of conversations is about what they were and what
// came of them, and a screen that shipped every word of every thread to draw five rows would be
// paying for a chat log to render a table of contents.
//
// `from` carries no default for the reason it never did: a turn with no speaker is a bubble drawn on
// the wrong side of the screen. `at` does — an absent instant is one this build has nothing to say
// about, and the room prints nothing rather than 1970.
@Serializable
data class AskTurn(val from: String, val text: String, @SerialName("at") val atMs: Long = 0) {
    val fromLifter: Boolean get() = from == Ask.fromLifter
}

// A PROPOSAL THIS CONVERSATION MINTED, at the size the thread carries it: what it was, what became of
// it, and the routine it was about BY NAME — the one thing a proposal head does not hold and the one
// thing the row says out loud. It is a projection and never the diff: opening one is a read of the
// proposal itself, because a diff moves the moment anybody decides anything.
@Serializable
data class ThreadProposal(
    val id: String,
    val state: ProposalState = ProposalState.Pending,
    val changeCount: Int = 0,
    val routineId: String = "",
    val routine: String = "",
    @SerialName("createdAt") val createdAtMs: Long = 0,
) {
    // `9 Aug · 4 changes to Push A · applied` — the same nouns and the same four words the routine's
    // own history prints for the same object, because a proposal described one way on the program
    // and another way in the conversation that minted it is two accounts of one change.
    //
    // It is dated by when the proposal was WRITTEN and not by when it was decided: the thread carries
    // no settled instant, and a decision dated by the day it was proposed would be a claim about an
    // evening nobody observed. An ABSENT instant drops the date and keeps the rest, for the same
    // reason: `1 Jan 1970` is not a day this room has anything to say about.
    fun line(nowMs: Long): String {
        val counted = if (changeCount == 1) "1 change" else "$changeCount changes"
        val about = routine.takeIf { it.isNotBlank() }?.let { "$counted to $it" } ?: counted
        val became = when (state) {
            ProposalState.Applied -> "applied"
            ProposalState.Dismissed -> "dismissed"
            ProposalState.Superseded -> "set aside"
            ProposalState.Pending -> "waiting"
        }
        val said = "$about · $became"
        if (createdAtMs <= 0) return said
        return "${Readout.shortDate(createdAtMs, nowMs)} · $said"
    }
}

// WHAT CAME OF THE CONVERSATION — derived by the server from the proposals riding with the thread
// rather than stored as a column, so it cannot go stale the day a lifter applies from the routine
// screen instead of from here.
//
// `kind` STAYS A STRING, exactly as `RoutineEvent.kind` does and for the same reason: what an unknown
// word decides here is whether a row draws a subtitle at all, and both `label` and `detail` answer
// null for one this build has never heard of. A closed enum would have to fall back to some real
// outcome, and every candidate is a claim — "read only" would tell a lifter nothing was proposed
// about an evening this build cannot read.
//
// `changes` IS ALWAYS PRESENT AND ZERO IS REAL: a read-only conversation proposed nothing, and that
// is a fact about the evening rather than a missing field.
//
// `routineId` and `routine` are BOTH absent when the changes spanned more than one routine — a
// subtitle that named one of two would be the row picking a winner — so the detail drops to the count
// alone, which is still entirely true.
@Serializable
data class ThreadOutcome(
    val kind: String = "",
    val changes: Int = 0,
    val routineId: String? = null,
    val routine: String? = null,
) {
    // The chip, in gym's own settled vocabulary: `waiting` and `set aside` are the words the
    // routine's history already prints for the same two states, so a proposal cannot be described
    // one way on the program and another way in the conversation that minted it.
    val label: String?
        get() = when (kind) {
            applied -> "applied"
            readOnly -> "read only"
            dismissed -> "dismissed"
            proposed -> "waiting"
            superseded -> "set aside"
            else -> null
        }

    // THE SUBTITLE, AND EVERY WORD OF IT IS A FACT THE SERVER OBSERVED. The count is the log's own
    // and the routine is the log's own name for it; nothing here is inferred, and there is no field
    // on the wire a motive could be written into even if this room wanted one.
    val detail: String?
        get() = when (kind) {
            applied -> routine?.takeIf { it.isNotBlank() }?.let { "$counted → $it" } ?: counted
            readOnly -> "no changes proposed"
            dismissed -> "$counted dismissed"
            proposed -> "$counted waiting"
            superseded -> "$counted superseded"
            else -> null
        }

    // Whether this is the one outcome the accent is spent on: the conversation that actually moved
    // the program, which is the row a lifter scanning six weeks of evenings is looking for.
    val moved: Boolean get() = kind == applied

    // `1 change`, `4 changes` — the same noun `Proposal.counted` spells, because the card, the
    // routine's history and this row all count one thing and must count it one way.
    private val counted: String get() = if (changes == 1) "1 change" else "$changes changes"

    companion object {
        const val applied = "applied"
        const val readOnly = "read-only"
        const val dismissed = "dismissed"
        const val proposed = "proposed"
        const val superseded = "superseded"
    }
}

// ONE CONVERSATION. The list read fills everything but `turns`; the detail read adds them.
//
// `title` IS THE LIFTER'S FIRST MESSAGE, VERBATIM — written once when the thread opened and never
// again — so it is drawn as it arrived, whatever its punctuation, its emoji or its capitals. Nothing
// on this phone summarises, truncates for meaning, sentence-cases or otherwise improves it: the
// whole point of the row is that it is the question in your words, and a client that tidied it would
// be the summary §O refuses, written by a different hand.
//
// BOTH INSTANTS DEFAULT TO ABSENT AND ABSENT IS DRAWN AS NOTHING — the same rule `AskTurn.at` states
// one screen up. Today's log writes both keys on every row, so this is the shape of a reply from a
// server that stopped, not one anybody has met; a row is still a true row without a date on it, and
// `1 Jan 1970` would be the one line on this screen asserting an evening nobody logged.
@Serializable
data class AskThread(
    val id: String,
    val title: String = "",
    @SerialName("createdAt") val createdAtMs: Long = 0,
    @SerialName("askedAt") val askedAtMs: Long = 0,
    val outcome: ThreadOutcome = ThreadOutcome(),
    val proposals: List<ThreadProposal> = emptyList(),
    val turns: List<AskTurn> = emptyList(),
) {
    // When it was last asked, said the way the room says a day — and null rather than a date when
    // the log said nothing about when.
    fun day(nowMs: Long): String? =
        askedAtMs.takeIf { it > 0 }?.let { Readout.briefDay(it, nowMs) }
}

// The months a list of conversations falls into, newest first — the only grouping on this screen and
// the only ordering. It is not a folder, it is not collapsible and nothing can be filed into it: a
// month is where an evening happened, which is the one thing about a conversation a lifter can be
// counted on to remember six weeks later.
//
// The label is NULL for the one group that is not a month: conversations the log gave no instant
// for. They sit last under no heading at all, because a heading is where an evening happened and
// this is the group of evenings nothing was written down about.
data class ThreadMonth(val label: String?, val threads: List<AskThread>)

object Threads {
    const val title = "Threads"
    const val open = "Ask something new"

    // The way back onto this screen, from the head of Ask itself.
    const val door = "Threads"

    // One conversation as a DESTINATION rather than as itself — what a screen pushed over a thread
    // calls the way back. The thread's own head is the lifter's question; a back row cannot be, at
    // the length a question can run to.
    const val conversation = "Conversation"

    // WHAT THE HEADER COUNTS, and it is the only number on the screen: how many conversations there
    // are, and whose they are to delete. Not "unread", not "new", not "waiting" — there is nothing
    // here waiting for anybody.
    fun counted(threads: Int): String {
        val said = if (threads == 1) "1 conversation" else "$threads conversations"
        return "$said · yours to delete"
    }

    // Nothing yet, said as chrome rather than as a message from a character — Ask does not speak
    // first, and neither does the room that lists what it has said.
    const val none = "Nothing here yet. Every conversation you have with Ask is kept until you delete it."

    // A list that could not be read is not an empty one, and the two never collapse into one
    // sentence — a lifter with nine conversations must never read a quiet log as a log with none.
    // It is named for a READ that failed and never `unread`: this screen has no unread anything, and
    // the word is not allowed to live here as a variable either.
    const val outOfReach = "the log didn’t answer — your conversations are out of reach"

    // WHAT DELETING TAKES AND WHAT IT LEAVES, said under the button rather than left to the word
    // "delete" to imply. An applied change stays in the routine's history because that is a fact
    // about the program rather than a message — the routine's row still says the change came from
    // Ask, it just no longer opens a conversation that is gone.
    const val deletes = "Delete this conversation"
    const val deleteRule =
        "Deleting the conversation keeps what it changed: an applied change stays in the routine's " +
            "history. There is no undoing the delete."

    // Read-only, and it says so rather than drawing a composer that would open a second conversation
    // under the same title. A past thread is a record; the door out of it is a new question.
    const val past = "A conversation you had. Ask something new to start another."

    // Grouped by the month the last question was asked in — newest month first, newest thread first
    // inside it. It sorts by the SERVER'S instants and never by arrival order: the list read is
    // already ordered, and a client that trusted the sequence would draw a month twice the first time
    // a reply came back out of order.
    fun months(threads: List<AskThread>, nowMs: Long): List<ThreadMonth> =
        threads.sortedByDescending { it.askedAtMs }
            .groupBy { thread ->
                thread.askedAtMs.takeIf { it > 0 }?.let { Readout.month(it, nowMs) }
            }
            .map { (label, held) -> ThreadMonth(label, held) }
}
