package works.windmill.gym.store

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet

// THE LOCAL-FIRST WRITE — a set is the lifter's the instant they tap, and the network's problem
// afterwards. This and the iOS SetQueue.swift are the two living statements of the verdict
// contract pinned in backend/products/gym/ARCHITECTURE.md §11, and the two must not drift. (The
// web's flushQueue.js was the reference implementation until 2026-08-09; it went with the web
// logger, and the web now holds no set queue at all.)
//
// Every set carries a CLIENT-MINTED id, which IS the idempotency key: a replay of a set that already
// landed answers 200 with the stored row, even after the session closed, so this queue can send in
// any order, any number of times, and the log converges on one row per id.
//
// The whole thing is held in memory (a workout is a few dozen rows) and flushed to ONE atomic file,
// so a read during a draw is never disk-bound and a file this build cannot read opens EMPTY rather
// than taking the app down with it. What it holds is the live session, that session's sets, and the
// sets that are still owed — which is everything a relaunch needs to carry on from.
//
// Two rules decide the shape of the walk, and each of them is a set somebody lifted:
//   · BY IDENTITY, NEVER BY POSITION. Entries are keyed by the minted set id and found again by it
//     or not at all — a send is in the air while the thumb keeps running, so the head that comes
//     back is not the head that went out.
//   · ORDER IS PER SESSION AND MOVEMENT, because that is the only order the server keeps: it numbers
//     sets max+1 per (session, exercise). A set that cannot land holds up its own LANE and nothing
//     else. A jam that stopped the whole queue stopped a whole workout, silently.
//
// And the rule the backend made non-negotiable: a set that never landed is REFUSED once the session
// is finished. So the queue flushes BEFORE finish, before the boot read and before the claim's
// starts — an append settles nothing and every one of those does — and a refusal is reported rather
// than counted as delivered.
class SetQueue(
    private val file: File,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    // The key the server numbers sets under. A value type rather than an interpolated string because
    // then it is provably collision-free instead of collision-free by an id's spelling.
    data class Lane(val sessionId: String, val exerciseId: String)

    @Serializable
    data class Entry(
        val set: TrainingSet,
        val sessionId: String,
        val needsPush: Boolean,
        val remints: Int,
        // THE UNDO WINDOW, and it is a promise the DEVICE keeps rather than a request to the log.
        // A logged row CAN be taken off the log now — §G18's delete does exactly that — but that is
        // a repair made at rest, on a past session, with a sheet and a second gesture. This is the
        // mistap seconds ago in a room with a rack in it, and the only moment it can be undone
        // without telling anybody is while this device is still the only place it exists.
        //
        // Defaulted because a queue file written before the window existed has no such key, and the
        // decoder tolerates a missing key only where there is a default — a file that failed to
        // decode opens EMPTY and takes a live session's sets down with it.
        val heldUntilMs: Long? = null,
    ) {
        val lane: Lane get() = Lane(sessionId, set.exerciseId)

        fun isHeld(at: Long): Boolean = (heldUntilMs ?: 0) > at
    }

    companion object {
        // The repair budget is its own counter: a set that spent an hour offline has not spent any
        // of the three id collisions it is allowed to survive. Past this, the collision is not a
        // coincidence and re-minting forever would hammer the log instead of telling the lifter.
        const val maxRemints = 3

        // iOS's own window (SetQueue.swift), to the millisecond: the surfaces must agree on how
        // long a set can be taken back, or the same mistake is undoable on one phone and permanent
        // on the other.
        const val undoWindowMs = 9_000L

        // The room edge resolves this against context.filesDir — the queue itself never touches an
        // android class, which is what keeps every test on the JVM.
        const val fileName = "windmill-gym-sets.json"
    }

    @Serializable
    private data class Held(
        val session: Session? = null,
        val entries: Map<String, Entry> = emptyMap(),
        // The movements this session holds, in the order it will walk them — the plan's lines
        // first, then whatever was added on the bench mid-rest. It is not derivable from the sets,
        // because a movement appended and not yet logged has none, and that intention is exactly
        // what "no sets yet — logging one starts it" is drawing. Defaulted for the same reason
        // Entry's hold is: an older file must still open.
        val order: List<String>? = null,
        // WHETHER THE LIVE SESSION IS THE LOG'S YET. True for a session composed on this device with
        // no server answered — signed out, mid-claim, or signed in with no signal — and the claim's
        // landed start is what turns it false, for that same id. Persisted, because deriving it
        // from how the last claim pass ended made a WAIT on somebody else's open workout — or one
        // 5xx — mark a session the server had already answered for as unclaimed: its lanes were
        // parked, its finish went to the shelf, and the server row stayed open.
        //
        // ABSENT READS AS UNCLAIMED, and that is the honest default for THIS shelf's history: every
        // build before this one re-sent the live session's start on every connect, so a file it
        // wrote says nothing about whether the log ever answered. Reading absent as claimed would
        // let a device-composed workout from that build meet a 404 on its first append and be
        // forgotten as "gone" (`TrainingStore.deliver`). Reading it as unclaimed costs one start
        // replay, idempotent under the session's own id, and then the bit is written — unless a
        // shelf session stands behind a live one the LOG holds (the state the old wait left): that
        // shelf start 409-waits on the phone's own workout, the claim halts before the live start,
        // and the live session's owed sets stay parked with no cadence until the first log read
        // adopts it — which flips the bit and walks them (`TrainingStore.loadLog`). One read late,
        // never a tap late, and only for a file this build did not write. (iOS reads absent as
        // claimed — its file carried the bit from the day its claim existed.)
        val unclaimed: Boolean? = null,
    )

    private var held: Held = runCatching {
        diskJson.decodeFromString(Held.serializer(), file.readText())
    }.getOrElse { Held() }

    val order: List<String> get() = held.order ?: emptyList()

    // Appending is a rest-time action, not a setup task: the movement joins the session the moment
    // it is chosen, before it has a set to its name.
    fun append(exerciseId: String) {
        if (exerciseId in order) return
        held = held.copy(order = order + exerciseId)
    }

    fun hold(order: List<String>) {
        held = held.copy(order = order)
    }

    val session: Session? get() = held.session

    // The live session was composed here and the log has not answered for it. Nothing walks its
    // sets while this holds — the claim's start opens their road — and no read may trade it for the
    // account's other open workout.
    val sessionIsUnclaimed: Boolean get() = held.session != null && (held.unclaimed ?: true)

    // A different session is a different workout, so the movement order goes with the old one. It
    // is cleared rather than merged: the two lists share nothing, and carrying yesterday's
    // movements into today would draw a session the lifter never started.
    //
    // `unclaimed` defaults to false because every caller but the device start is holding a session
    // the SERVER answered with; only the on-device start passes true, and `claimed` turns it back
    // for the same id once the log has the row.
    fun hold(session: Session?, unclaimed: Boolean = false) {
        val kept = if (held.session?.id == session?.id) held.order else null
        held = held.copy(session = session, order = kept, unclaimed = if (session == null) null else unclaimed)
    }

    // The claim's start landed: the log holds this session now, and its sets may walk.
    fun claimed(sessionId: String) {
        if (held.session?.id != sessionId) return
        held = held.copy(unclaimed = false)
    }

    // The open session's sets in the order they were performed — queued and delivered together,
    // because a row on this device is a set that happened whether or not the log has heard of it.
    val sets: List<TrainingSet>
        get() {
            val live = held.session ?: return emptyList()
            return sets(live.id)
        }

    fun sets(sessionId: String): List<TrainingSet> = held.entries.values
        .filter { it.sessionId == sessionId }
        .map { it.set }
        .sortedBy { it.completedAtMs }

    // Everything this device owes the log, oldest first — the queue a flush drains. Sorting by the
    // instant the set was performed is what makes the per-lane walk the server's own order.
    val pending: List<Entry>
        get() = held.entries.values
            .filter { it.needsPush }
            .sortedBy { it.set.completedAtMs }

    fun owed(sessionId: String): List<Entry> = pending.filter { it.sessionId == sessionId }

    // `readyAt` is the instant the walk is standing at, and an entry still inside its undo window
    // is not offered at it. A forced walk passes null: a finish, a boot read and a room being left
    // all end the window, because each of them is the moment the gesture the window protects has
    // left the screen.
    fun nextOwed(skipping: Set<Lane>, readyAt: Long?): Entry? = pending.firstOrNull { entry ->
        if (entry.lane in skipping) return@firstOrNull false
        if (readyAt == null) return@firstOrNull true
        !entry.isHeld(readyAt)
    }

    // The one set that can still be taken back: the newest one this device is holding for its own
    // window. Newest rather than oldest because Undo answers the tap the lifter just made.
    fun withdrawable(at: Long = clock()): Entry? = pending.lastOrNull { it.isHeld(at) }

    // Taking a set back HERE is only ever legal while it is still owed. Once the log holds the row
    // this returns false and says so: the row is the account's now, and taking it off the account is
    // §G18's delete on a past session — a deliberate repair with its own sheet — never a button that
    // quietly reaches through the logger.
    fun withdraw(id: String): Boolean {
        val entry = held.entries[id] ?: return false
        if (!entry.needsPush) return false
        held = held.copy(entries = held.entries - id)
        return true
    }

    // One door for both directions: a set the lifter just logged (owed), and a row the log handed
    // back on a read (not owed). A server row arriving for a set this device owes SETTLES it — the
    // log holding the row IS delivery, however the news arrived.
    fun store(set: TrainingSet, sessionId: String, needsPush: Boolean, heldUntilMs: Long? = null) {
        val remints = held.entries[set.id]?.remints ?: 0
        held = held.copy(
            entries = held.entries + (set.id to Entry(set, sessionId, needsPush, remints, heldUntilMs)))
    }

    // The reply to a send. The row comes back under the id that went out — always, because that id
    // is the idempotency key — and clearing the SENT key anyway is what stops a reply that ever
    // disagreed from leaving an entry owed, resent, and owed again forever.
    fun delivered(stored: TrainingSet, id: String, sessionId: String) {
        held = held.copy(entries = held.entries - id +
            (stored.id to Entry(stored, sessionId, needsPush = false, remints = 0, heldUntilMs = null)))
    }

    // The one repair a spent id allows: the same set under a new key, still owed, with the budget
    // counted down. Everything the lifter did travels unchanged.
    fun remint(id: String, fresh: String) {
        val entry = held.entries[id] ?: return
        // The fresh id carries no hold: the window was spent waiting for the send that collided,
        // and a set the lifter stopped watching nine seconds ago must not wait another nine to land.
        held = held.copy(entries = held.entries - id +
            (fresh to Entry(entry.set.copy(id = fresh), entry.sessionId, needsPush = true,
                remints = entry.remints + 1, heldUntilMs = null)))
    }

    fun drop(id: String) {
        held = held.copy(entries = held.entries - id)
    }

    // The claim's repair for a live session whose id another account already spent: the same
    // workout under a fresh session id, every owed set re-pointed at it. Set ids do not move —
    // they are keys of their own and each has its own remint budget.
    fun remapSession(old: String, fresh: String) {
        val entries = held.entries.mapValues { (_, entry) ->
            if (entry.sessionId == old) entry.copy(sessionId = fresh) else entry
        }
        val session = held.session?.let { if (it.id == old) it.copy(id = fresh) else it }
        held = held.copy(session = session, entries = entries)
    }

    // The claim's repair for a locally minted movement whose id another account already spent:
    // the id changes everywhere this queue wrote it — the sets, the walk order, and the live
    // plan's own lines — because a movement is a stable id everywhere except on screen.
    fun remapExercise(old: String, fresh: String) {
        val entries = held.entries.mapValues { (_, entry) ->
            if (entry.set.exerciseId == old) entry.copy(set = entry.set.copy(exerciseId = fresh)) else entry
        }
        val order = held.order?.map { if (it == old) fresh else it }
        val session = held.session?.let { live ->
            val plan = live.plan?.let { plan ->
                plan.copy(entries = plan.entries.map {
                    if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
                })
            }
            live.copy(plan = plan)
        }
        held = held.copy(session = session, entries = entries, order = order)
    }

    // A session that is over. Its delivered sets live on the log now, so this device stops holding
    // them — but an owed set is dropped by nobody quietly: it stays queued until the log answers
    // for it, and a `session-finished` refusal is what tells the lifter it never landed.
    fun close(sessionId: String) {
        held = held.copy(entries = held.entries.filterValues { it.sessionId != sessionId || it.needsPush })
        if (held.session?.id == sessionId) letGo()
    }

    // A session that no longer exists. Discard deletes the row out from under whatever this device
    // still held, and that is the one case where an owed set has nowhere left to go — keeping it
    // would re-send it against a session id the log no longer knows, forever.
    fun forget(sessionId: String) {
        held = held.copy(entries = held.entries.filterValues { it.sessionId != sessionId })
        if (held.session?.id == sessionId) letGo()
    }

    // The session row and its movement order are one fact and end together — an order left standing
    // over no session is a list of movements belonging to a workout that is over.
    private fun letGo() {
        held = held.copy(session = null, order = null, unclaimed = null)
    }

    fun flush() {
        val text = runCatching { diskJson.encodeToString(Held.serializer(), held) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}

// What a refusal is MADE OF, stripped of the transport that carried it: the status, the machine
// word, the server's sentence, and the two ways a reply can fail to be one at all. The store wave
// adapts the platform error into this, so the verdicts stay a rule this module proves on the JVM
// without importing the network.
data class RefusalFacts(
    val status: Int? = null,
    val code: String? = null,
    val sentence: String? = null,
    val offline: Boolean = false,
    val malformed: Boolean = false,
) {
    // What a retryable failure is BLOCKED BY, for the strip that names it. Only a transport
    // failure is "offline"; a lapsed session is its own fact; everything else that keeps a set owed
    // is the log's own trouble.
    val blocker: Blocker
        get() = when {
            offline -> Blocker.Offline
            status == 401 -> Blocker.SignInLapsed
            else -> Blocker.LogFailed
        }
}

// THE FOUR VERDICTS, and none of them is guesswork about English. The code is the contract; the
// sentence is copy for a human reading a banner, and it may be reworded any day — a queue that told
// the 409s apart by string-comparing it degrades to "terminal, reason unknown" the first time one
// is edited, and drops a set it should have minted a fresh id for.
sealed class Verdict {
    data class Remint(val said: String) : Verdict()     // 409 set-id-taken / session-id-taken — that id names a row elsewhere
    data class Dropped(val said: String) : Verdict()    // 409 session-finished — this set never landed and never will
    data class Refused(val said: String) : Verdict()    // 400, any other 409 — this body will never land as written
    data object Retry : Verdict()                       // 5xx, no reply at all, and everything that is only waiting

    // The sentence to SAY, or null while the set is still owed. A remint is terminal only once the
    // repair budget is spent, and then it surrenders under the log's own words rather than a
    // sentence this file invented for a case nobody has ever seen.
    fun terminalReason(afterRemints: Int): String? = when (this) {
        is Retry -> null
        is Remint -> if (afterRemints < SetQueue.maxRemints) null else said
        is Dropped -> said
        is Refused -> said
    }

    companion object {
        fun refusing(facts: RefusalFacts): Verdict {
            // A transport failure arrives as `offline` and a reply this build could not read
            // arrives as `malformed`. Neither is a status and neither is a lost set: replay is
            // free, so both keep the set queued.
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Retry
            val said = facts.sentence ?: "the log refused this set"
            if (facts.code == "set-id-taken" || facts.code == "session-id-taken") return Remint(said)
            if (facts.code == "session-finished") {
                return Dropped("the session closed before this set reached it")
            }
            // The 500 is the server's and is retryable — a dropped connection, a statement timeout,
            // a deadlock. The 400s and the remaining 409s are the client's and are terminal:
            // retrying an unreadable body never makes it readable.
            if (status >= 500) return Retry
            if (status == 400 || status == 409) {
                return Refused(if (facts.code == "unknown-exercise") "that movement is not in the catalog" else said)
            }
            // 401 waits for a sign-in and 404 for a session to exist. Terminal and retryable never
            // both hold, and neither follows from the other's absence — a queue that read "not
            // retryable" as "lost" would throw away a set that was only waiting for the session
            // secret to come back. The 404 is only WAITING here: whether the session can still come
            // to exist is a fact about the session, not the set, and the walks decide it before
            // they ask this — for a session the log once answered for, a 404 is the workout gone
            // (TrainingStore.deliver, ClaimReplay), said and let go rather than waited on.
            return Retry
        }
    }
}

// THE FIFTH WORD, and it is about a row that already exists rather than one still trying to land.
// The four verdicts above answer "will this set ever reach the log"; a correction asks something
// this vocabulary could not say — "the row you are editing was REFUSED" — and it is told apart by
// `code` for exactly the reason they are: the sentence is copy and may be reworded any day.
//
// Two terminal answers, and the screen owes them different moves. `Gone` means the log does not
// hold that set at all — absent, already deleted, another account's, or this account's set in a
// different workout, one answer byte-identical for all four — so the drawn row is stale and the
// pending edit has nowhere to go. `Unwritable` means these bytes will never land as written and
// the row is still there. Everything else waits: a 5xx is the server's, a 401 wants a sign-in, and
// no reply at all is not an answer.
//
// A FINISHED SESSION IS NOT HERE. Corrections are allowed after the workout ends — the server
// publishes no `session-finished` on either route — so a client that branched on one would be
// carrying a case the wire cannot produce.
sealed class FixVerdict {
    data class Gone(val said: String) : FixVerdict()        // 404 set-not-found — that row is not on the log
    data class Unwritable(val said: String) : FixVerdict()  // 400 fix-unreadable — this body never lands
    data object Retry : FixVerdict()                        // 5xx, 401, no reply at all

    companion object {
        fun refusing(facts: RefusalFacts): FixVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Retry
            val said = facts.sentence ?: "the log refused this fix"
            if (facts.code == "set-not-found") return Gone("that set is no longer on the log")
            if (facts.code == "fix-unreadable") return Unwritable(said)
            if (status >= 500) return Retry
            // A 404 with no word on it is still the route saying it has no such row, and a 400 is
            // still a body it could not read — the code is the contract, and its absence is an
            // older server rather than a different meaning.
            if (status == 404) return Gone("that set is no longer on the log")
            if (status == 400 || status == 409) return Unwritable(said)
            return Retry
        }
    }
}

// THE SIXTH WORD, and it is about a DECISION rather than a row. Apply and dismiss are the two taps
// this product hands an agent's proposal, and both can arrive after the answer is already fixed —
// told apart by `code` for the reason the five above are: the sentence is copy and may be reworded
// any day, while the code is the contract.
//
// `Superseded` is the one the design exists for. The routine MOVED after the diff was written — the
// lifter's own mid-session save, a PUT from the web, another proposal applied — so the base this
// document was composed against is gone, and applying it would write next week from a routine that
// no longer stands. It is never retried, never merged, and the card says so.
//
// None of the three is retryable and neither is a loss: a proposal that could not be decided is
// still sitting on the routine, and the log is the only thing that decides.
sealed class ProposalVerdict {
    data class Superseded(val said: String) : ProposalVerdict()   // 409 proposal-superseded — the routine moved first
    data class Settled(val said: String) : ProposalVerdict()      // 409 proposal-settled — the other decision was already taken
    data class Gone(val said: String) : ProposalVerdict()         // 404 — absent, another account's, never existed
    data object Retry : ProposalVerdict()                         // 5xx, 401, no reply at all

    companion object {
        fun refusing(facts: RefusalFacts): ProposalVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Retry
            if (facts.code == "proposal-superseded") {
                return Superseded("the routine moved after this was written — nothing was applied")
            }
            if (facts.code == "proposal-settled") {
                return Settled("that proposal was already decided")
            }
            if (status >= 500) return Retry
            // A 404 with no word on it is still the route saying it holds no such proposal, and a
            // 400 or a bare 409 is still a decision that will never land as sent — the code is the
            // contract, and its absence is an older server rather than a different meaning.
            if (status == 404) return Gone("that proposal is no longer on the log")
            if (status == 400 || status == 409) {
                return Settled(facts.sentence ?: "that proposal was already decided")
            }
            return Retry
        }
    }
}

// THE SEVENTH WORD, and it is about a QUESTION rather than about a row. Ask is the one door in this
// product that spends money per use, so it is also the only one whose refusals include a ceiling —
// and a ceiling is a sentence, never a checkout: there is nothing to buy in this product, and an
// upgrade offered against a cap would advertise a purchase that answers 503.
//
// `Absent` is the one nothing else here has. A deployment with no model configured does not register
// the route at all, so the answer is the framework's bare 404 — the feature not existing rather than
// an object being missing — and the room takes the door down rather than saying anything about it.
//
// TOLD APART BY STATUS AND CODE, never by the English: `ask-daily-limit` and `ask-out-of-budget` are
// two ceilings that read alike and are worded differently, and both are terminal for now. Only a log
// that went quiet is worth another tap.
sealed class AskVerdict {
    data class Said(val said: String) : AskVerdict()   // the answer is the sentence, and it will not change on a retry
    data class Again(val said: String) : AskVerdict()  // 5xx, no reply at all — the one worth offering a retry on
    data class Fresh(val said: String) : AskVerdict()  // 409 — this conversation cannot take the question; the next one opens a new thread
    data object Absent : AskVerdict()                  // 404 — this deployment has no Ask

    companion object {
        fun refusing(facts: RefusalFacts): AskVerdict {
            val status = facts.status
            if (facts.offline || facts.malformed || status == null) return Again(noAnswer)
            if (status == 404) return Absent
            if (status >= 500) return Again(facts.sentence ?: noAnswer)
            // THE TWO REFUSALS THAT ARE ABOUT THE THREAD RATHER THAN THE QUESTION, and the only
            // two in this product a retry can fix by CHANGING something rather than by waiting:
            // eight turns is a full conversation and an id another account holds is not this
            // lifter's to write into. Both are answered by opening a NEW thread — the question is
            // perfectly good, and a room that kept sending it into the same closed conversation
            // would refuse the same lifter forever. Nothing is re-sent on its own: this spends
            // money, so the retry is still a tap.
            if (facts.code == "ask-thread-full" || facts.code == "ask-thread-taken") {
                return Fresh(facts.sentence ?: "that conversation is full — ask again to start a new one")
            }
            // Everything else is the log answering in its own words — the cap, the ceiling, the
            // workout still open, a thread it could not read, a session that has expired. The
            // sentence is the whole of what the lifter needs, and a fallback exists only so a
            // refusal that arrived wordless still says something true.
            return Said(facts.sentence ?: "Ask couldn't take that one")
        }

        private const val noAnswer = "Ask didn't answer. Try again in a moment"
    }
}

// What is SAID when a write is lost for good — the one surface every loss rides, because a loss
// dropped quietly would count as intended.
sealed interface RefusedWrite {
    val reason: String
}

// A set that never landed, kept so it can be said out loud. The movement and the numbers travel
// with the reason because this is the LAST COPY of a set somebody lifted — "82.5 × 8 never reached
// the log" is unloggable again without knowing of what.
data class RefusedSet(
    val id: String,
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    override val reason: String,
) : RefusedWrite {
    constructor(set: TrainingSet, reason: String) :
        this(set.id, set.exerciseId, set.weightKg, set.reps, reason)
}

// The claim's own loss: a movement or routine document the server refuses outright, let go from
// the shelf so the same terminal write is not re-sent on every connect. Said under its name — a
// document has no numbers to carry.
//
// A SESSION IS NAMED BY THE DAY IT WAS AND THE DAY OF THE PROGRAM IT RAN — the two facts a lifter
// can find it by, since a minted id means nothing on a banner. The id rides anyway, unshown: it is
// what makes two passes refusing the SAME live workout one loss on the banner and not one per pass.
data class RefusedClaim(val id: String, val name: String, override val reason: String) : RefusedWrite {
    constructor(session: Session, reason: String) :
        this(session.id, "${session.plan?.routine ?: "workout"} · ${Readout.date(session.startedAtMs)}", reason)
}

// How a write reports itself: mono, lower-case, never a toast and never an alert (the journal's
// voice). Silence is a state — a room that has just opened says nothing. A refusal speaks in the
// log's own words, because it is the last copy of a set that never landed.
sealed class SaveState {
    data object Idle : SaveState()
    data object OnTheLog : SaveState()          // the account has it
    data object OnThisDevice : SaveState()      // held on purpose: nobody signed in, or the log cannot take this session yet
    data class Blocked(val by: Blocker) : SaveState()   // signed in and offered, and this is what stopped it landing
    data class Refused(val reason: String) : SaveState()

    // "offline" is said only when the transport failed. A log that answered 500, or a session that
    // lapsed, is a different fact and gets its own words — a lifter told "offline" under a full
    // signal would be pointed at the wrong thing.
    val line: String?
        get() = when (this) {
            Idle -> null
            OnTheLog -> "on the log"
            OnThisDevice -> "saved on this device"
            is Blocked -> when (by) {
                Blocker.Offline -> "offline · saved here"
                Blocker.LogFailed -> "the log didn’t answer · saved here"
                Blocker.SignInLapsed -> "sign in again · saved here"
            }
            is Refused -> reason
        }
}

// One Json for the files on disk, shared with the catalog beside the queue's: unknown keys are
// tolerated so an older build's file still opens, and an absent optional is omitted exactly as it
// is on the wire.
internal val diskJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

// Whole file, temp name, rename over the old copy — so a crash mid-write leaves the last good file
// on disk, never half a workout. Failures are swallowed for the same reason unreadable files open
// empty: the memory copy is the truth and the file is only its shadow.
internal fun writeAtomically(file: File, text: String) {
    runCatching {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        try {
            Files.move(tmp.toPath(), file.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
