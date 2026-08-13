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
//     { "thread": "thr_…", "question": "…" }
//   → { "answer", "steps": [{tool, failed}], "read": {sets, sessions, weeks}, "proposals": [id],
//       "thread": "thr_…" }
//
// THE SERVER KEEPS THE CONVERSATION — §O, and the reversal of W7's own decision. One question goes
// out against a thread id this phone minted, and the log assembles the prompt from the turns it
// stored, so the conversation a lifter reads back in six weeks is the one the model actually saw.
// What was composed here — an alternating, lifter-first, lifter-last turns array — is the log's job
// now, and `Ask.thread()` went with it. Thread.kt is where the past lives.
//
// NO FIELD ON THE WAY OUT CARRIES A DEFAULT, and that is the landmine this file and Thread.kt share.
// The app's single Json omits any value equal to its declared default (WindmillJson,
// `encodeDefaults` off), so a thread id defaulted to the empty string would travel as an ABSENT key
// and the question would be refused as malformed — the same trap GymPreferences names from the other
// side, where the omission is the contract.
//
// COMING BACK, a default is a decision about what an ABSENCE means, and this file makes it twice.
// `steps` and `proposals` default to empty because empty is what an absent one means and neither is
// a claim. `answer` and `read` do NOT default, because a receipt invented out of a missing field
// would be the one number on the screen that nobody counted — §L's rule is that every answer states
// what it read, so prose with no receipt is not an answer this room may draw.

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

    // gym's own vocabulary on the wire, and deliberately not the vendor's `user`/`assistant`: this
    // shape is gym's contract with its own clients, and nothing about it should have to change when
    // the model behind it does. The log's own word for the other side (`ask`) is not spelled here,
    // because nothing on this phone tests for it: a stored turn is the LIFTER'S or it is drawn as
    // the log's, and a speaker this build has never heard of must not be put in somebody's mouth.
    const val fromLifter = "lifter"

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

    // WHAT HAPPENS TO WHAT YOU ASK, said where Ask is explained rather than discovered on a screen
    // somewhere else. §O made this true — the log keeps the conversation now — and a feature that
    // started keeping a lifter's questions without saying so would be the quietest dark pattern in
    // the product. It is one sentence and it names the door out in the same breath: kept, and yours
    // to delete.
    const val kept = "Every conversation is kept so you can read it back, and yours to delete."

    // §L's own paragraph, and the reason it is not a retreat to ship it: an in-app chat that sends
    // you somewhere better costs one paragraph and is the strongest proof the connected log is real.
    // (§L wrote it as "how to stop paying us"; nothing in gym is paid, so what it actually points at
    // is the door that costs us money and the lifter nothing.) The grant itself is a WEB PAGE — this
    // phone has no screen for it and W7 does not build one — so the offer under this paragraph opens
    // a browser rather than a room, which is the most a surface can honestly do about a door it does
    // not hold.
    //
    // THE CLIENTS NAMED ARE THE ONES THE PAGE UNDER THE BUTTON ACTUALLY WALKS THROUGH. This said
    // "Claude or ChatGPT" until W8, and the button beneath it opens `#/connect` — whose roster is
    // Claude Desktop, Claude Code, Cursor, Codex and any other MCP client, with no ChatGPT path
    // anywhere on it or on connect.html. That is not a claim about somebody else's product; it is a
    // claim about what OUR setup page covers, made directly above the button that opens it, and a
    // lifter who arrived there on the strength of the word would find nothing to follow.
    const val freeDoor =
        "If you already use Claude — or Cursor, Codex, any tool of yours that speaks MCP — connect " +
            "it instead: it's free, and it's better, because it knows the rest of your life."

    const val connect = "Connect your own"

    // WHERE THAT DOOR GOES is `ConnectedLog.setupUrl`, and it is spelled there rather than here: W8 gave
    // the connected log a card and a settings row of its own, and one room may not hold two
    // spellings of one address — the day the server sends a connect URL, one line moves.

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
    // sentence that would have named it is exactly what went missing. And since §O the answer
    // itself may be on the log too: a reply that landed after the room went down was stored with
    // the thread, so the last clause points at where to read it rather than leaving a lifter to
    // assume an evening was lost.
    //
    // It is the one refusal this room mints itself rather than repeating the log's words, because
    // the log never heard that anybody stopped listening. The retry is offered under it by the
    // screen, so the sentence does not ask for one in words.
    const val interrupted =
        "Ask didn't finish that one. The log heard the question, so it may have counted against " +
            "today's — and anything it proposed is on the routine either way. If it did answer, " +
            "the conversation is in Threads."

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

    // WHETHER THE PHONE CHANGED HANDS UNDER A CONVERSATION — asked by the room on every pass, and a
    // function here rather than a comparison at the call site because the two ways to get it wrong
    // are opposite and both silent.
    //
    // One way is keeping a thread across a seat: every question and every answer is somebody's own
    // training, so the next person holding this phone must not read it.
    //
    // The other way is what a naive comparison does, and it is the one that actually bit. `standing`
    // is NULL while the app has not yet asked `/v1/me` — the state EVERY launch begins in, including
    // the launch that follows the activity being recreated, where the saved thread is restored a
    // frame before anybody knows who is signed in. Read as "nobody", that first frame empties the
    // conversation on every restart, which is precisely the loss the saver exists to prevent: the
    // saver, `settled` and the interrupted retry would all be unreachable code.
    //
    // So null is NOT nobody. Only a seat the room has actually READ can take a thread away from the
    // seat that saved it, and `known` is what says it has been read — a fact about THIS ROOM's life,
    // never saved beside the thread, because a saved one would restore as true and be the same bug
    // wearing a different name. Once the room has met the lifter, an empty seat is a real sign-out
    // and the thread goes.
    fun handedOver(saved: String, standing: String?, known: Boolean): Boolean {
        if (standing == null && !known) return false
        return (standing ?: "") != saved
    }

    // Whether this is a question at all, asked before the send rather than after the refusal. Blank
    // is not a question, and over the ceiling is a question the log will not take — so the door is
    // shut while either is true instead of spending a round trip to be told.
    fun sendable(typed: String): Boolean {
        val asked = typed.trim()
        return asked.isNotEmpty() && asked.toByteArray(Charsets.UTF_8).size <= maxTurnBytes
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
