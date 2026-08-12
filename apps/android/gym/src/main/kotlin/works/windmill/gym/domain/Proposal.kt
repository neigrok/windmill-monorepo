package works.windmill.gym.domain

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// IT READS. IT PROPOSES. IT NEVER REWRITES A DAY THAT ALREADY STANDS.
//
// The third clause was "it never writes to your program" and that is false of the catalog it claims
// to describe: `create_routine` is `gym:write` and lands a day that did not exist immediately, with
// no tap at all. The paragraph below always said the split correctly, so the headline was arguing
// with its own body — and with `ConnectedLog`, which refuses the same sentence one file away.
//
// The split the whole object exists to carry: a mutation that RECORDS something that already
// happened lands at every door — a set is logged, a session starts and finishes, a movement is
// created — while a mutation of something that WILL HAPPEN mints one of these and does nothing at
// all until the lifter taps Apply. A lifter saying "log 100 × 5" is using their agent as a
// transcription device and the bar is already back on the rack; a rewritten Tuesday speaks to a
// tired future person in a room where the conversation that caused it is gone, and Apply is the
// only UI that decision will ever have.
//
// NOTHING ON THIS PHONE MINTS ONE, and nothing here writes a proposal of any kind: the agent's
// tools are the only door in, the lifter's tap is the only door out, and the two verbs this client
// has — apply and dismiss — are decisions rather than documents. Every type below is READ-ONLY on
// the wire, which is why none of them carries a `Write` twin.
//
// PROPOSALS ARE SIGNED-IN ONLY. No account, no agent, no proposal: the shelf never holds one, the
// claim never replays one, and a signed-out lifter sees NOTHING about them — no card, no chip, no
// empty history and no pitch. Not because there is something to sell here: nothing about the
// connected log is paid, the tools read no entitlement, and W8's invitation says outright that
// connecting is free. It is that a grant is granted against an ACCOUNT, so a room pitching one to
// somebody who has none would be asking for a sign-in where this product answers questions.
//
// It reads the gym wire conventions Training.kt states — epoch-ms instants, signed kg, an absent
// optional omitted rather than null, and reads that DEFAULT rather than throw, so a word from a
// future server draws a card instead of crashing a room.

@Serializable(with = ProposalIntentSerializer::class)
enum class ProposalIntent(val wire: String) {
    Revise("revise"), Remove("remove");

    companion object {
        fun parse(raw: String?): ProposalIntent = entries.firstOrNull { it.wire == raw } ?: Revise
    }
}

object ProposalIntentSerializer : KSerializer<ProposalIntent> {
    override val descriptor = PrimitiveSerialDescriptor("ProposalIntent", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ProposalIntent) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): ProposalIntent = ProposalIntent.parse(decoder.decodeString())
}

// THE FOUR STATES, and they are a ladder with one rung a decision can be taken on. An UNKNOWN word
// reads as `Superseded` and deliberately not as `Pending`: `pending` is the only state that can
// grow a successor, so anything this build has never heard of is settled by construction — and the
// safe direction for a word we cannot read is a screen that draws no Apply button rather than one
// that offers a decision it cannot describe. An ABSENT state is the field's own default and reads
// as `Pending`, which is what the card was drawn for.
@Serializable(with = ProposalStateSerializer::class)
enum class ProposalState(val wire: String) {
    Pending("pending"), Applied("applied"), Dismissed("dismissed"), Superseded("superseded");

    companion object {
        fun parse(raw: String?): ProposalState = entries.firstOrNull { it.wire == raw } ?: Superseded
    }
}

object ProposalStateSerializer : KSerializer<ProposalState> {
    override val descriptor = PrimitiveSerialDescriptor("ProposalState", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ProposalState) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): ProposalState = ProposalState.parse(decoder.decodeString())
}

// WHICH DOOR, WHICH CONNECTION, WHICH MODEL — provenance as a column and never a fork, because "a
// change appeared in my Tuesday and I cannot tell whether it was my own Claude or the app's own
// Ask" is the exact mental-model failure this design exists to prevent. The two doors mint the same
// type through the same mechanism and land in the same list; only this field differs.
//
// Both NAMES are omitted by the log today — the MCP transport carries no connection identity yet —
// so the fallback is the one fact the column always holds: which door. Ask is a door this app can
// name outright, so it is; anything else is somebody's own agent, and "your connected agent" is the
// true thing to say about a name gym does not have. A byline reading `from` and then nothing would
// be a proposal from nobody.
//
// `door` stays a String where `state` and `kind` are closed enums, and the difference is what each
// decides: a door this build has never heard of only picks which fallback to print, while an
// unknown state would put a wrong control in front of a tap.
@Serializable
data class ProposalSource(
    val door: String = "mcp",
    val connection: String? = null,
    val agent: String? = null,
) {
    val name: String
        get() = agent?.takeIf { it.isNotBlank() }
            ?: connection?.takeIf { it.isNotBlank() }
            ?: if (door == askDoor) "Ask" else "your connected agent"

    companion object {
        const val askDoor = "ask"
    }
}

// What a routine line asks a movement for, either side of a change. The absences mean what they
// mean everywhere else in this product: no reps is `max`, no weight is "whatever you did last
// time", no rest is the global dial (Rest.target) — so each has a WORD here rather than a blank,
// because a diff row with one side empty reads as a field being emptied.
@Serializable
data class ProposalTargets(
    val sets: Int = 0,
    val reps: Int? = null,
    val weightKg: Double? = null,
    val restSeconds: Int? = null,
)

@Serializable(with = ChangeKindSerializer::class)
enum class ChangeKind(val wire: String) {
    Kept("kept"), Added("added"), Removed("removed"), Retargeted("retargeted");

    companion object {
        // An unknown kind reads as `Retargeted` and never as `Kept`: a row this build cannot name
        // is still a row the lifter is about to apply, and hiding it would make `Apply all 4` count
        // one more thing than the screen showed. Retargeted is also the only drawing that survives
        // either shape — it prints whichever of before and after actually arrived.
        fun parse(raw: String?): ChangeKind = entries.firstOrNull { it.wire == raw } ?: Retargeted
    }
}

object ChangeKindSerializer : KSerializer<ChangeKind> {
    override val descriptor = PrimitiveSerialDescriptor("ChangeKind", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ChangeKind) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): ChangeKind = ChangeKind.parse(decoder.decodeString())
}

// ONE LINE OF THE DIFF. `before` is absent on an added line and `after` on a removed one, which is
// what makes the pair readable as a sentence rather than as a record with holes in it.
//
// `loggedSets` rides on a REMOVED line only, and a zero there is a real answer: `41 logged sets
// kept` is the promise the removal has to make out loud, because a lifter reads "removed" as
// "deleted" unless something says otherwise. A proposal never touches a logged set.
@Serializable
data class ProposalChange(
    val position: Int = 0,
    val kind: ChangeKind = ChangeKind.Retargeted,
    val exerciseId: String,
    val before: ProposalTargets? = null,
    val after: ProposalTargets? = null,
    val loggedSets: Int? = null,
) {
    // `added · 3 × 10 · 24 · after Bench Press` — the PLACE is part of the change, because a
    // movement arriving third is a different program from the same movement arriving first.
    fun addedLine(follows: String?): String {
        val said = mutableListOf("added")
        after?.let { said += Proposal.asks(it) }
        said += follows?.let { "after $it" } ?: "first in the routine"
        return said.joinToString(" · ")
    }

    // `removed from the routine · 41 logged sets kept`. The count is what the removal DOES NOT
    // touch — a proposal never reaches a logged set — and zero is a real answer rather than a
    // missing one: a movement removed before it was ever trained says so instead of offering a
    // reassurance about nothing. A count the log did not send says neither.
    val removedLine: String
        get() {
            val kept = loggedSets ?: return "removed from the routine"
            if (kept == 0) return "removed from the routine · never logged"
            val sets = if (kept == 1) "1 logged set" else "$kept logged sets"
            return "removed from the routine · $sets kept"
        }

    // THE SAME CHANGE AT CARD SIZE — one line, for the summons Ask draws in the message stream when
    // a conversation mints a proposal. It lives HERE, beside the two lines above, because a diff
    // spelled in a screen file is a second grammar for the same change: the card and the document it
    // opens saying one removal two ways is the drift this product keeps a `Readout` to prevent, and
    // the room already learned it once with weights.
    //
    // Every word is the diff screen's own — `removedLine` verbatim, an addition's targets in `asks`,
    // a retarget in the FIELD MOVES screen 14 draws one under another. What the compact line drops
    // is the POSITION an addition lands at: that is a fact about the routine's order and belongs to
    // the review, not to a card whose whole job is to get somebody to open it.
    val compactLine: String
        get() {
            if (kind == ChangeKind.Added) return after?.let { "+ added · ${Proposal.asks(it)}" } ?: "+ added"
            if (kind == ChangeKind.Removed) return "− $removedLine"
            // A retarget, and everything this build cannot name with it: both read off whichever of
            // the two sides actually arrived, exactly as the full row does, so a kind from a newer
            // server still draws what the line would end up asking for.
            val moved = before?.let { was -> after?.let { now -> Proposal.moves(was, now) } }.orEmpty()
            if (moved.isNotEmpty()) return moved.joinToString(" · ") { "${it.before} → ${it.after}" }
            return (after ?: before)?.let { Proposal.asks(it) } ?: "no targets"
        }
}

// THE PROPOSAL, in the two sizes the wire sends it. A HEAD — embedded on a routine as
// `pendingProposal`, and listed by the routine's own history read — carries everything above
// `baseRevision`; the WHOLE proposal adds the base it was written against and the typed diff. One
// type for both, because a head is exactly this object with the diff still unread: `changes` is
// empty there, and the only screen that reads it is the one that fetched the whole thing.
//
// `changeCount` is the server's own count of what Apply would do — moved rows plus a renamed name —
// and it is what the button promises. The rows this file draws are the same set, which is why the
// rename is drawn as a row of its own: a button saying four over three readable rows would be the
// screen counting something the lifter cannot see.
@Serializable
data class Proposal(
    val id: String,
    val routineId: String,
    val intent: ProposalIntent = ProposalIntent.Revise,
    val state: ProposalState = ProposalState.Pending,
    val summary: String = "",
    val changeCount: Int = 0,
    @SerialName("createdAt") val createdAtMs: Long = 0,
    @SerialName("settledAt") val settledAtMs: Long? = null,
    val source: ProposalSource = ProposalSource(),
    // ABSENT ON A HEAD, and that absence is the whole of what tells the two sizes apart — the
    // routines read sends no base because there is no diff on it to have been written against one.
    // It is nullable rather than a number for that reason: a zero would be a base every routine
    // alive has already moved past, and every head would then read as superseded.
    val baseRevision: Int? = null,
    val baseName: String = "",
    val name: String = "",
    val changes: List<ProposalChange> = emptyList(),
) {
    val isPending: Boolean get() = state == ProposalState.Pending

    // The rows screen 14 draws, in the order it draws them — and `kept` is not one of them. A line
    // the proposal leaves alone is context the routine already shows, and drawing it under a header
    // that says "changes" would make the screen argue with its own button.
    val drawn: List<ProposalChange> get() = changes.filterNot { it.kind == ChangeKind.Kept }

    // The routine's own name moving is a change with no row on the wire, and the server counts it.
    // Both names have to be there to claim it: a head carries neither, and a head is never drawn as
    // a diff.
    val renames: Boolean
        get() = name.isNotBlank() && baseName.isNotBlank() && name != baseName

    // Where an added line LANDS, which is half of what makes it reviewable — `added · 3 × 10 · 24 ·
    // after Bench Press` is a position a lifter can disagree with, where "added" alone is not. The
    // proposed run is the rows up to the first removal; what the routine takes away is listed after
    // it and is not part of the order. The first line of the day lands after nothing.
    fun landsAfter(added: ProposalChange): String? {
        val run = changes.takeWhile { it.kind != ChangeKind.Removed }
        val at = run.indexOf(added)
        if (at <= 0) return null
        return run[at - 1].exerciseId
    }

    // THE BASE THIS DIFF WAS WRITTEN AGAINST, checked against the routine the room is holding. A
    // routine that has moved on since — the lifter's own mid-session `Save 87.5 to Push A`, a PUT
    // from the web, another proposal applied — leaves this one with nothing to apply over, and the
    // screen says so instead of sending a document composed against a routine that no longer
    // stands. Behind the held revision is not the same fact: this phone is merely one read stale,
    // and the log is the one that decides.
    //
    // A HEAD ANSWERS NO, because a head carries no base to have been passed: an unread diff is not
    // a stale one, and claiming otherwise would take the button off every proposal in the product.
    // The screen that decides always holds the whole read, and the log refuses what this cannot see.
    fun supersededBy(routine: Routine?): Boolean {
        val base = baseRevision ?: return false
        val held = routine ?: return false
        return held.revision > base
    }

    // The byline screen 14 and the card both print: who proposed it and when it arrived. The
    // instant is spelled the way every other instant in this room is (`Readout.whenLogged`), so a
    // proposal that landed this morning reads as today and one from Sunday reads as Sunday.
    fun byline(nowMs: Long): String = "from ${source.name} · ${Readout.whenLogged(createdAtMs, nowMs)}"

    // WHAT THE CARD SAYS WHEN THE AGENT WROTE NO SUMMARY: a count and a routine name, never an
    // invented sentence. The agent's own words are the only voice allowed to describe its own diff,
    // and a room that made one up for it would be putting words in the mouth the lifter is about to
    // judge.
    fun summaryLine(routineName: String): String {
        if (summary.isNotBlank()) return summary
        if (intent == ProposalIntent.Remove) return "A proposal to remove $routineName."
        return "$counted to $routineName."
    }

    // THE NOUN THIS PROPOSAL IS COUNTED IN — `3 changes`, or `a removal`, which is one act however
    // many lines it takes away. Every label and every dated row below is built from it, so the card,
    // the button and the history can never count the same proposal two ways.
    val counted: String
        get() {
            if (intent == ProposalIntent.Remove) return "a removal"
            return if (changeCount == 1) "1 change" else "$changeCount changes"
        }

    // What the card offers, and it counts the same thing the button applies.
    val reviewLabel: String
        get() = if (intent == ProposalIntent.Remove) "Review the removal" else "Review $counted"

    // THE COUNT IS THE SERVER'S AND NEVER THE ROWS THIS BUILD MANAGED TO DRAW. The button states
    // what the tap DOES, and apply is atomic against the whole document — so a build that drew four
    // of five rows must still not promise to apply four. It is the same rule the tool names live
    // under: never promise an effect you do not have.
    val applyLabel: String
        get() = if (intent == ProposalIntent.Remove) "Remove $routineName" else "Apply all $changeCount"

    // ALL OF IT OR NONE, said under the button rather than left to the word "all" to imply. Apply is
    // atomic against a base version: the routine ends up as the whole diff describes it or exactly
    // as it stands, and there is no half. The count is a WORD here and a NUMERAL on the button,
    // because one is a sentence and the other is a control.
    val atomicLine: String
        get() {
            if (intent == ProposalIntent.Remove) {
                return "The routine goes and your logged sets stay. Nothing is removed until you tap."
            }
            if (changeCount <= 1) return "Nothing is applied until you tap."
            return "All ${Readout.spelled(changeCount)} or none. Nothing is applied until you tap."
        }

    // The dated record this becomes on the routine (§6's History), whatever the lifter decided — an
    // agent's suggestion is part of the program's history, so a dismissal keeps its row exactly as
    // an apply does. Nothing is a toast that disappears.
    // It reads off `settledAt` because that is the day the record is ABOUT — a proposal written on
    // Sunday and applied on Tuesday belongs to Tuesday in the program's history.
    fun historyLine(nowMs: Long): String {
        val on = Readout.shortDate(settledAtMs ?: createdAtMs, nowMs)
        return when (state) {
            ProposalState.Applied -> "$on · applied $counted from ${source.name}"
            ProposalState.Dismissed -> "$on · dismissed $counted from ${source.name}"
            ProposalState.Superseded -> "$on · set aside $counted from ${source.name}"
            ProposalState.Pending -> "$on · $counted from ${source.name}, waiting"
        }
    }

    // What a settled proposal says on its own screen, with the instant the decision was taken. The
    // dismissal asks for no reason and offers no undo, and says both.
    fun settledNote(nowMs: Long): String? {
        val at = settledAtMs ?: return null
        // The day the way a person says the one they are standing in, and the clock beside it: a
        // decision taken this morning is placed by its hour, an older one by its date. Both read as
        // one phrase, which is why neither half is borrowed from a spelling built for a log row.
        val on = "${Readout.briefDay(at, nowMs)} at ${Readout.time(at)}"
        return when (state) {
            ProposalState.Applied ->
                "Applied to $routineName $on. Kept on the routine as a dated record — the program's history, not a toast that disappears."
            ProposalState.Dismissed ->
                "Dismissed $on. No reason asked for, nothing changed, and it stays in the routine's history in case you want it back."
            // The one outcome here the lifter did not choose, so it explains itself.
            ProposalState.Superseded ->
                "$routineName changed after this was written, so it was set aside $on. None of it was applied, and it stays in the routine's history."
            ProposalState.Pending -> null
        }
    }

    // The routine this is about, named the way the diff names it: the base the proposal was written
    // against, because that is the routine the lifter is being asked about. A head carries no name
    // at all and falls back to the noun rather than to an id nobody can read.
    val routineName: String get() = baseName.ifBlank { "this routine" }

    companion object {
        // WHAT ACTUALLY MOVED between two target lines, in the order screen 14 draws them: the sets
        // and reps as one field, the load, then the rest.
        //
        // The load is compared on the LADDER's grid and never on raw doubles, exactly as a set's
        // correction is (SetFix.moves): a weight that went out, was stored and came back is the same
        // weight, and a hundredth of a gram's disagreement would draw a change nobody proposed.
        fun moves(before: ProposalTargets, after: ProposalTargets): List<FieldMove> {
            val moved = mutableListOf<FieldMove>()
            if (before.sets != after.sets || before.reps != after.reps) {
                moved += FieldMove("sets", countOf(before), countOf(after))
            }
            if (!sameLoad(before.weightKg, after.weightKg)) {
                moved += FieldMove("weight", loadOf(before.weightKg), loadOf(after.weightKg))
            }
            if (before.restSeconds != after.restSeconds) {
                moved += FieldMove("rest", restOf(before.restSeconds), restOf(after.restSeconds))
            }
            return moved
        }

        // What an added line asks for, in the routine card's own grammar — one string, because an
        // addition has no before to sit beside.
        fun asks(targets: ProposalTargets): String =
            Readout.target(targets.sets, targets.reps, targets.weightKg)

        fun countOf(targets: ProposalTargets): String =
            "${targets.sets} × ${Readout.repTarget(targets.reps)}"

        fun loadOf(weightKg: Double?): String =
            weightKg?.let { Readout.weight(it) } ?: "last time"

        fun restOf(seconds: Int?): String = seconds?.let { "${it}s" } ?: "the dial"

        private fun sameLoad(before: Double?, after: Double?): Boolean {
            if (before == null || after == null) return before == null && after == null
            return Ladder.round(before) == Ladder.round(after)
        }
    }
}

// WHAT A DECISION ANSWERS WITH: the proposal as it now stands — settled and dated — and the routine
// it moved. The routine is ABSENT when the intent was to remove it, because there is no longer one
// to send; that absence is the removal having happened, and never an empty document.
@Serializable
data class ProposalDecision(val proposal: Proposal, val routine: Routine? = null)

// ONE FIELD OF ONE MOVEMENT, before and after — the typed diff, and the reason a proposal is
// reviewable at all: `sets 5 × 5 → 5 × 3` is a claim a lifter can agree or disagree with, where
// "your agent rewrote Push A" is only a thing that happened to them.
data class FieldMove(val label: String, val before: String, val after: String)
