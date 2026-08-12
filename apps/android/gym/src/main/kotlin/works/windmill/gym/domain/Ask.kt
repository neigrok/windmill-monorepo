package works.windmill.gym.domain

import kotlinx.serialization.Serializable

// ASK — the second door onto the engine the connected log already is, for the lifter who does not
// bring an agent of their own. Same reads, same typed diffs, same tap: a proposal minted in this
// conversation is indistinguishable in type and mechanism from one a lifter's own Claude mints over
// MCP, because provenance is a column on the object and never a fork in the product.
//
// WHAT IT IS NOT IS A COACH. It answers questions about numbers the lifter already owns, it never
// speaks first, and it has no personality, no encouragement, no daily check-in, no streak and no
// unread badge — this product still sends no notification of any kind. It is not a tab either: a
// chat is not a place anybody lives, and the rail belongs to the three tabs. It is NEVER OFFERED
// MID-SESSION, which on this phone is structural rather than remembered — Today is not drawn while
// a workout is open — and the server refuses one anyway (409 `ask-session-open`), because three
// clients each getting it right is not a rule.
//
// THE ONE PLACE THE WORD COACH SURVIVES IN GYM is the SHARE: one finished workout, handed to one
// person, by the lifter's own hand. That is a different object with a different door, and nothing
// on this screen borrows its name.
//
// THE WIRE — `POST /v1/gym/ask`, owner-scoped, the same route the web and the iOS room speak:
//
//     { "turns": [ { "from": "lifter" | "ask", "text": "…" } ] }
//   → { "answer", "steps": [{tool, failed}], "read": {sets, sessions, weeks}, "proposals": [id] }
//
// THE SERVER KEEPS NOTHING. Every ask carries the whole conversation, which is why the thread is
// composed here and why the trimming below is the client's to get right rather than a nicety.
//
// NO FIELD ON THE WAY OUT CARRIES A DEFAULT, and that is this file's one landmine. The app's single
// Json omits any value equal to its declared default (WindmillJson, `encodeDefaults` off), so a
// `from` defaulted to "lifter" would travel as an ABSENT key and every turn would be refused as
// malformed — the same trap GymPreferences names from the other side, where the omission is the
// contract.
//
// COMING BACK, a default is a decision about what an ABSENCE means, and this file makes it twice.
// `steps` and `proposals` default to empty because empty is what an absent one means and neither is
// a claim. `answer` and `read` do NOT default, because a receipt invented out of a missing field
// would be the one number on the screen that nobody counted — §L's rule is that every answer states
// what it read, so prose with no receipt is not an answer this room may draw.

@Serializable
data class AskTurn(val from: String, val text: String)

@Serializable
data class AskThread(val turns: List<AskTurn>)

// One tool the model asked for, in call order. The opening read Ask makes on the lifter's behalf is
// not one of these — it was not the model's idea, so it is not reported as the model's move.
//
// `tool` CARRIES NO DEFAULT, for the reason `read` below carries none: a step is a name, and a step
// with no name is a row that draws as a blank line or as a bare ` · no answer`. Absent, the parse
// fails and the room says nobody answered, which is the honest thing to say about a reply this build
// cannot read. `failed` defaults freely — false is what an absent one means, and it is not a claim.
// (The iOS room decodes this field the same way, which is why the two cannot drift.)
@Serializable
data class AskStep(val tool: String, val failed: Boolean = false) {
    // The tool's OWN name, unchanged. It is the name a lifter's own Claude sees over MCP, and
    // renaming it for the room would put two vocabularies on one catalog — the seam the connected
    // log exists to keep single. A read that came back empty-handed says so beside its own name,
    // because it changes how much of the answer above it stands.
    val line: String get() = if (failed) "$tool · no answer" else tool
}

// WHAT THE SERVER SERVED, COUNTED WHERE IT WAS SERVED — the whole reason the line under an answer is
// worth printing. A model asked how much it read will happily say a number; this one was counted by
// the log as it handed the rows over, deduped by id, and it rides in the tool envelope so a lifter's
// own Claude sees the same accounting. NOTHING ON THIS PHONE MAY COMPUTE, SUM OR INFER IT: a receipt
// a client could arrive at on its own is a receipt the model could have made up.
@Serializable
data class ReadTally(val sets: Int = 0, val sessions: Int = 0, val weeks: Int = 0) {
    val anything: Boolean get() = sets > 0 || sessions > 0 || weeks > 0
}

// ONE ANSWER — and `answer` and `read` CARRY NO DEFAULT ON PURPOSE, which is the other half of the
// landmine above read from the decoding side. §L's rule is that every answer states what it read, so
// a body with no receipt in it is not an answer this room may draw: defaulted to zeros it would come
// out as "read nothing from your log", which is a claim ABOUT THE LOG made from the absence of a
// field. Required, a missing receipt fails the parse, and the room says nobody answered — the honest
// thing to say about prose we cannot check. `steps` and `proposals` default freely: both are
// legitimately empty, and neither is a claim.
@Serializable
data class AskAnswer(
    val answer: String,
    val read: ReadTally,
    val steps: List<AskStep> = emptyList(),
    // Minted during this exchange, in mint order, and observed at the tool rather than read out of
    // the prose — so a proposal reaches the lifter whether or not the model remembered to mention
    // it. The diff itself is read back off the log by id: these are ids and never documents.
    val proposals: List<String> = emptyList(),
)

// ONE EXCHANGE, AS THE SCREEN HOLDS IT: the lifter's question, and what came back — an answer, or a
// sentence about why nothing did. Both halves are kept because the question stays on screen either
// way: a bubble that vanished with its failure would take the lifter's own words with it.
//
// `again` is the one distinction the screen acts on rather than only reads out. A log that went
// quiet is worth another tap; a cap, a malformed thread or a workout still open are answers that
// will not change, and a Retry under one of those would be an offer that is not one.
@Serializable
data class AskExchange(
    val question: String,
    val answer: AskAnswer? = null,
    val trouble: String? = null,
    val again: Boolean = false,
) {
    // NEITHER HALF YET — the question is on screen and the log has not come back. It is the state a
    // question is born in and, on this phone, the one state that can be RESTORED: a thread saved
    // through an activity recreation was saved mid-flight, and the coroutine that would have
    // settled it went down with the ROOM (the ask is the room's, not the screen's, so leaving Ask
    // for Today no longer strands one).
    val pending: Boolean get() = answer == null && trouble == null
}

object Ask {
    const val title = "Ask"
    const val subtitle = "reads your log · proposes only"
    const val placeholder = "Ask about your training"

    // The server's own ceiling on one turn, held here too — because the composer has to stop a
    // question BEFORE it is sent. A 400 for a long question would cost the lifter the typing.
    const val maxTurnBytes = 1000

    // SEVEN, where the wire's ceiling is eight. The thread must alternate and must both begin and
    // end with the lifter, so only an odd count is a conversation at all: three answered exchanges
    // carried as context, and the question being asked now.
    const val maxTurns = 7

    // gym's own vocabulary on the wire, and deliberately not the vendor's `user`/`assistant`: this
    // shape is gym's contract with its own clients, and nothing about it should have to change when
    // the model behind it does.
    const val fromLifter = "lifter"
    const val fromAsk = "ask"

    // What Ask is, said before it has said anything — the empty state is chrome and not a message,
    // because it does not speak first. It names the ceiling of the whole feature in the same breath
    // as the offer: the safeguard ladder's third rung is the promise a lifter needs most.
    const val whatItIs =
        "Ask reads the log you already keep and answers questions about it. It can propose a change " +
            "to a routine — you decide on the diff. It cannot edit or delete a set you logged: that " +
            "one is yours."

    // THE DAILY LIMIT, SAID BEFORE IT IS MET AND NOT ONLY BY THE REFUSAL THAT MEETS IT. Ask is the
    // first thing in this product with a cost per use, and therefore the first with a structural
    // incentive to ration — so the ration is a fact on the screen rather than an ops detail a lifter
    // discovers by running out. The numbers are the server's own (`kAskPerDay`, `kAskBackToBack`),
    // said in the same words the 429 says them in, so the sentence read before and the sentence read
    // after cannot disagree. "About" is honest: the bucket is in memory, so a deploy refills it.
    //
    // NOTHING IS SOLD AGAINST IT. Windmill One cannot be bought, so a cap that offered a way past
    // itself would advertise a checkout that answers 503 — the cap is what keeps Ask open to
    // everybody instead.
    const val dailyCap =
        "It answers about ten questions a day, three back to back — the cap that keeps Ask open to " +
            "everyone. There is nothing to buy here."

    // §L's own paragraph, and the reason it is not a retreat to ship it: an in-app chat that tells
    // you how to stop paying us costs one paragraph and is the strongest proof the connected log is
    // real. The grant itself is a WEB PAGE — this phone has no screen for it and W7 does not build
    // one — so the offer under this paragraph opens a browser rather than a room, which is the most
    // a surface can honestly do about a door it does not hold.
    const val freeDoor =
        "If you already use Claude or ChatGPT, connect them instead — it's free, and it's better, " +
            "because it knows the rest of your life."

    const val connect = "Connect your own"

    // WHERE THAT DOOR ACTUALLY IS — and it is spelled off the ACCOUNT's own origin, so a build
    // pointed at a local server sends a lifter to that server and never to windmill.works.
    //
    // WHICH IS A GUESS THIS PHONE IS MAKING, AND THE SHARE LINK IS WHERE THAT GUESS IS ALREADY
    // WRITTEN DOWN (`CoachShare.link`): this app knows where the API answers and does NOT know where
    // the browser app is served. In production they are one host and this is exact. Against a stack
    // where they are two — the emulator on `10.0.2.2:8088` with vite on another port — it opens the
    // API host, which does not serve this page. The share got out of that by preferring a URL the
    // SERVER composes and falling back to this only against an older backend; the ask reply carries
    // no such field, so there is nothing here to prefer. A `connectUrl` on the wire would close it,
    // and until then this is a dev-only wrong host rather than a link that opens the wrong thing.
    fun connectUrl(origin: String): String = "${origin.removeSuffix("/")}/#/connect"

    // Said under a proposal minted in the conversation, verbatim from the design: the apply tap
    // happens on the diff, all-or-none, and a logged set is never part of one.
    const val promise =
        "Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal."

    // While the log is being read. It is the one line on this screen that is not an answer, not a
    // refusal and not chrome, and it says what is actually happening rather than spinning: Ask's
    // first move on every question is to go and read.
    const val waiting = "reading your log…"

    // A QUESTION THE ROOM WAS TORN DOWN UNDER — a rotation, a theme flip, the system reclaiming the
    // activity mid-answer. The thread survives that (it is saved); the request does not, so the
    // question comes back with nothing under it and nobody left to fill it in.
    //
    // AND IT SAYS WHAT THAT MAY HAVE COST, because it may have cost something. The day's questions
    // are counted at the EDGE, before a token is spent, so a request that got as far as the log was
    // paid for whether or not anybody was left to read the answer — and whether it got that far is
    // the one thing this phone cannot know, which is why the sentence says "may" and not "did".
    // "Nothing happened" would be the cheaper sentence and this room's own invention.
    //
    // A proposal is the log's object rather than the conversation's, so anything the answer minted
    // is on the routine either way, waiting as a card on Today — said out loud here because the
    // sentence that would have named it is exactly what went missing.
    //
    // It is the one refusal this room mints itself rather than repeating the log's words, because
    // the log never heard that anybody stopped listening. The retry is offered under it by the
    // screen, so the sentence does not ask for one in words.
    const val interrupted =
        "Ask didn't finish that one. The log heard the question, so it may have counted against " +
            "today's — and anything it proposed is on the routine either way."

    // WHAT IS SAID WHEN THE DEPLOYMENT HAS NO ASK AT ALL. The route is only registered where a model
    // is configured, so the answer is a bare 404 — the feature not existing rather than a request
    // failing — and there is nothing to retry. The door goes down behind the lifter with it.
    const val notHere = "Ask isn't part of this Windmill. Your log is still yours to read."

    // THREE OPENERS, AND THEY ARE THE ONLY CHIPS THIS SCREEN DRAWS. Nothing counts whether they were
    // tapped, and — the rule that decides their WORDING — not one of them names a movement, a number
    // or a week the log has not been read for. "How has my bench moved?" was here and is gone: to a
    // lifter who has never benched it is the room guessing what they train, which is the same
    // failure as inventing a number, arriving as a question instead of as a claim.
    //
    // §L's follow-up chips after an ANSWER are deliberately not built — a follow-up has to come from
    // the answer, and nothing on the wire carries one, so a client inventing "Deload week?" would be
    // the room writing the lifter's next question about numbers it never saw.
    val openers = listOf("What's stalled?", "Which lifts are moving?", "Is my week too light?")

    // THE THREAD, COMPOSED FOR THE WIRE. Alternating, lifter-first, lifter-last, and never longer
    // than the ceiling — the server refuses anything else outright, and it is right to.
    //
    // Only ANSWERED exchanges are carried. One that failed has a question and no reply, and putting
    // it in would break the alternation the whole shape rests on; the lifter's Retry sends it as the
    // question again, which is what they asked for.
    //
    // The oldest exchanges are the ones dropped, because a conversation is about where it has got
    // to. Ask re-reads the log on every turn, so context lost here is context it can fetch again —
    // which is the whole reason a chat over a log can afford a short memory.
    fun thread(settled: List<AskExchange>, question: String): List<AskTurn> {
        val answered = settled.mapNotNull { exchange ->
            val said = exchange.answer?.answer ?: return@mapNotNull null
            if (said.isBlank()) null else exchange.question to said
        }
        val turns = mutableListOf<AskTurn>()
        // BOTH SIDES OF A CARRIED TURN ARE HELD TO THE CEILING. It is per turn and the server
        // refuses the WHOLE thread over one turn that breaks it, so an oversized answer — or an
        // oversized question from an older build or a seed nobody typed — would kill the question
        // being asked now over bytes from three questions ago. The composer keeps every question
        // inside the ceiling before it is sent, so this is a floor under context rather than a
        // rewrite a lifter meets.
        answered.takeLast((maxTurns - 1) / 2).forEach { (asked, replied) ->
            turns += AskTurn(fromLifter, clipped(asked))
            turns += AskTurn(fromAsk, clipped(replied))
        }
        // THE LIVE QUESTION IS NEVER CLIPPED, and that is the one place this rule stops: what a
        // lifter just typed goes as typed. A question sent in words they did not write would be
        // this room deciding what somebody said, and the log's own refusal is a better answer.
        turns += AskTurn(fromLifter, question)
        return turns
    }

    // WHAT A RESTORED THREAD NEEDS DONE TO IT before it is drawn again. A question left pending was
    // in flight when the ACTIVITY went down — nothing shorter can strand one, because the request
    // belongs to the room that holds the thread rather than to the screen that draws it — and
    // nothing is coming for it, so it is settled here as the silence it is, with the retry, because
    // a second tap is exactly what would have worked.
    //
    // It runs on the way IN and not on the way out: a room being torn down has no time to write
    // anything, and the honest place to notice a wait that never ended is where somebody is looking
    // at it again.
    fun settled(thread: List<AskExchange>): List<AskExchange> {
        if (thread.none { it.pending }) return thread
        return thread.map { exchange ->
            if (!exchange.pending) exchange
            else exchange.copy(trouble = interrupted, again = true)
        }
    }

    // Whether this is a question at all, asked before the send rather than after the refusal. Blank
    // is not a question, and over the ceiling is a question the log will not take — so the door is
    // shut while either is true instead of spending a round trip to be told.
    fun sendable(typed: String): Boolean {
        val asked = typed.trim()
        return asked.isNotEmpty() && asked.toByteArray(Charsets.UTF_8).size <= maxTurnBytes
    }

    // Cut to a byte budget on a CHARACTER boundary, because the ceiling is bytes and the text is
    // UTF-8: an emoji or an accented letter is several bytes, and a cut through the middle of one
    // is a byte sequence no reader can decode. Code points rather than chars for the same reason a
    // surrogate pair is one character to a person.
    fun clipped(text: String, maxBytes: Int = maxTurnBytes): String {
        if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return text
        val ellipsis = "…"
        val budget = maxBytes - ellipsis.toByteArray(Charsets.UTF_8).size
        // A BUDGET TOO SMALL TO HOLD THE MARK KEEPS NOTHING. The ceiling is this function's whole
        // promise, and a mark appended past it would hand back MORE bytes than were asked for — the
        // one thing a clip may never do.
        if (budget <= 0) return ""
        val kept = StringBuilder()
        var taken = 0
        var at = 0
        while (at < text.length) {
            val point = text.codePointAt(at)
            val width = Character.charCount(point)
            val piece = text.substring(at, at + width)
            val size = piece.toByteArray(Charsets.UTF_8).size
            if (taken + size > budget) break
            kept.append(piece)
            taken += size
            at += width
        }
        return kept.append(ellipsis).toString()
    }

    // THE RECEIPT, SPELLED — `read 214 sets · 12 weeks · 34 sessions`, in the design's own order. It
    // prints only what was actually served: a bucket at zero is left out rather than drawn as a
    // zero, because "0 weeks" reads as a claim about the log and it is a claim about the question.
    //
    // A read that served nothing at all says so in words. The alternative — printing nothing — would
    // make the strongest fact on the screen (an answer standing on no rows) the quietest one.
    //
    // All three nouns are spelled by `Readout` and none of them here: gym counts sets, sessions and
    // weeks in exactly one place, so the read line cannot drift from the log's own rows.
    fun receipt(read: ReadTally): String {
        if (!read.anything) return "read nothing from your log"
        val parts = mutableListOf<String>()
        if (read.sets > 0) parts += Readout.setCount(read.sets)
        if (read.weeks > 0) parts += Readout.weekCount(read.weeks)
        if (read.sessions > 0) parts += Readout.sessionCount(read.sessions)
        return "read ${parts.joinToString(" · ")}"
    }
}
