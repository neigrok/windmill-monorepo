package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.SessionDetail
import works.windmill.gym.domain.SessionSummary
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet

// THE SHELF — everything gym made on this device that no account has claimed yet: locally minted
// movements, local routines, and FINISHED local sessions with their sets. The live session is
// deliberately not here; that is SetQueue's file, and one fact living in one file is what keeps a
// crash from leaving two stores disagreeing about the same workout.
//
// Signed out this shelf IS the log: the log tab, the last-time prefill, a movement's record and
// the session revisit all read it. On sign-in the claim replay (ClaimReplay) walks it onto the
// account, and a row leaves the shelf only when the server has confirmed holding it — so the shelf
// is always exactly what the account does not yet have, and merging reads is one concatenation.
//
// It is also where §G18's correction lands for a session no account holds: the fix rewrites the row
// that will be replayed, and a delete leaves a tombstone rather than only a hole, because a claim
// that stopped half way through may already have put part of this session on the log.
//
// Same discipline as the queue's file: one atomic JSON file, every field optional so an older
// build's file still opens, and a file this build cannot read opens EMPTY rather than taking the
// history down with it. Written on every mutation — holds and claims are rare (a finish, a keep,
// a claim), not per-tap.
// `deviceOwner` is the account whose SESSION THIS DEVICE IS HOLDING when the file is opened, and it
// exists for exactly one decision: where a file from before the seats lands (see `open`). It cannot
// come from the room's `Account` — the room mounts before /v1/me resolves (MainActivity), so the
// first account through that door is always nobody — so the edge reads it out of the session store
// and hands it in here.
class LocalLog(private val file: File, deviceOwner: String? = null) {
    @Serializable
    data class FinishedSession(
        val session: Session,
        val sets: List<TrainingSet> = emptyList(),
        // THE TOMBSTONES — sets §G18 deleted off this row, kept by id until the claim has told the
        // account. A shelf session is not always wholly unclaimed: a pass that landed the start and
        // some of the sets and then stopped retryably leaves the row here with part of it already on
        // the log. Dropping a set from `sets` alone would let the next pass replay the survivors and
        // leave the deleted one standing on the account forever — the delete would silently undo
        // itself. Defaulted for the same reason every field here is: a file written before the
        // tombstones existed has no such key, and a file that fails to decode opens EMPTY.
        val deleted: List<String> = emptyList(),
    )

    // ONE SEAT'S SHELF. Named for what it is rather than for the file, because the file now holds
    // one of these per seat and only the seat in hand is reachable (`Seat`).
    @Serializable
    private data class Shelf(
        val exercises: List<Exercise>? = null,
        val routines: List<Routine>? = null,
        val finished: List<FinishedSession>? = null,
    ) {
        val isEmpty: Boolean get() =
            exercises.isNullOrEmpty() && routines.isNullOrEmpty() && finished.isNullOrEmpty()
    }

    // THE SEAT IS NOT IN HERE. It lives in memory and starts at whoever the device holds a session
    // for, because a seat READ BACK OFF DISK would let a freshly constructed store resolve the LAST
    // seat's rows before anybody adopted anything — harmless while `connect` is the only caller
    // that ever touches this, and a loaded gun for the next one (a widget, a notification, an
    // export). iOS keeps its key in memory for the same reason.
    @Serializable
    private data class Held(val shelves: Map<String, Shelf> = emptyMap())

    companion object {
        const val fileName = "windmill-gym-local.json"
    }

    private var seat: String = Seat.of(deviceOwner)
    // Set by `open` when it had to decide where a file from before the seats lands. The decision is
    // written back at once (`init`) so it is made ONCE and no later launch can make it differently
    // — a quarantine left only in memory is a legacy file still on disk, which the next launch
    // would re-read and could hand to somebody else.
    private var migrated = false
    private var held: Held = open(deviceOwner)

    init {
        if (migrated) flush()
    }

    // A FILE FROM BEFORE THE SEATS is one shelf with nobody's name on it, and it decodes cleanly as
    // that shelf — so it is read that way FIRST, and WHO IT BELONGS TO IS DECIDED HERE, off the
    // session this device is holding, which is the only thing that knows. A phone that was SIGNED
    // IN at the upgrade wrote those rows as that account: they are seated to it, and making that
    // lifter hunt a settings row to get their own live workout back would cost more than the leak
    // it closes. A phone holding NO session says nothing of the kind — "nobody is signed in now" is
    // not "nobody wrote this", and it may be exactly the last account's work after they signed out,
    // which IS the original leak — so those go to quarantine, which no seat can reach and no
    // arriving account ever adopts.
    //
    // The session, not the arriving Account, and that is the whole of why `deviceOwner` exists: the
    // room mounts before the seat resolves, so the first account it connects for is nobody on every
    // launch, and a rule reading it would quarantine every signed-in lifter's shelf on earth.
    // (apps/ios decides the same branch off its Keychain session.)
    //
    // A file this build wrote has none of those keys at the top level and decodes empty here, which
    // is what tells the two apart without a version number. Anything neither shape opens EMPTY
    // rather than taking the history down with it.
    private fun open(deviceOwner: String?): Held {
        val text = runCatching { file.readText() }.getOrNull() ?: return Held()
        val before = runCatching { diskJson.decodeFromString(Shelf.serializer(), text) }.getOrNull()
        if (before != null && !before.isEmpty) {
            migrated = true
            return Held(mapOf((if (deviceOwner == null) Seat.quarantine else seat) to before))
        }
        return runCatching { diskJson.decodeFromString(Held.serializer(), text) }.getOrElse { Held() }
    }

    // The seat in hand, and the one every verb below reads and writes. Absent is EMPTY: a seat that
    // has never trained on this phone opens on a clean shelf rather than on the last one's.
    private val mine: Shelf get() = held.shelves[seat] ?: Shelf()

    private fun keep(next: Shelf) {
        held = Held(held.shelves + (seat to next))
        flush()
    }

    // THE SEAT CHANGING HANDS, and the one place it does. The departing seat's movements, routines
    // and unclaimed workouts stay on disk under their own key — untouched, unreachable, and theirs
    // again the moment they sign back in — so the claim replay can never walk one person's training
    // into the account that signed in after them.
    //
    // The one carry is the ANONYMOUS one, and it is the anonymous-first door: what was made with
    // nobody signed in belongs to whoever claims it, so it MOVES onto the arriving account and
    // `ClaimReplay` walks it from there, exactly as it always has. It moves, never copies — a shelf
    // carried twice would land the same workout on two accounts.
    //
    // `confirmed` is the server having answered for this seat in THIS PROCESS. A seat standing on
    // the device's last-known user may draw its own room — the basement is what this app is built
    // for — but taking ownership of work nobody has claimed yet is irreversible, and a phone that
    // could not ask does not know whether that identity is still live. The next verified connect
    // makes the move.
    fun adopt(owner: String?, confirmed: Boolean = true) {
        val next = Seat.of(owner)
        val anonymous = held.shelves[Seat.anonymous] ?: Shelf()
        // The carry is not a property of the seat CHANGING, and writing it that way stranded the
        // anonymous shelf for good: a seat taken unconfirmed in a basement is already this seat by
        // the time the server answers, and a rule that only fires on a change would never look
        // again. A confirmed account seat sweeps the anonymous shelf whenever it finds one.
        val carrying = owner != null && confirmed && !anonymous.isEmpty
        if (next == seat && !carrying) return
        val arriving = held.shelves[next] ?: Shelf()
        val landed = if (!carrying) arriving else Shelf(
            exercises = anonymous.exercises.orEmpty() + arriving.exercises.orEmpty(),
            routines = anonymous.routines.orEmpty() + arriving.routines.orEmpty(),
            finished = anonymous.finished.orEmpty() + arriving.finished.orEmpty(),
        )
        val parked = if (carrying) held.shelves - Seat.anonymous else held.shelves
        seat = next
        held = Held((parked + (next to landed)).filterValues { !it.isEmpty })
        flush()
    }

    // WHAT THE PHONE IS HOLDING FOR NOBODY — the counts and the days a build before the seats left
    // behind, and nothing else. No movement name, no routine name and no numbers: whoever is reading
    // the settings row this feeds may not be who trained it.
    data class Unattributed(
        val sessions: Int,
        val routines: Int,
        val movements: Int,
        val days: List<Long>,
    )

    val unattributed: Unattributed?
        get() {
            val quarantined = held.shelves[Seat.quarantine] ?: return null
            return Unattributed(
                sessions = quarantined.finished.orEmpty().size,
                routines = quarantined.routines.orEmpty().size,
                movements = quarantined.exercises.orEmpty().size,
                days = quarantined.finished.orEmpty().map { it.session.startedAtMs }.sortedDescending(),
            )
        }

    // The human saying it is theirs — and only a human WITH AN ACCOUNT may say it. The quarantine
    // exists because this device cannot tell whose that work is, so an affirmation from a
    // signed-out stranger holding somebody's phone is worth nothing; releasing it onto the
    // anonymous seat would hand it to the next account to sign in, which is the leak, dressed as a
    // door. Answers false and the row says what to do instead.
    //
    // Released, it lands on the seat in hand merged with whatever that seat already holds, and from
    // there the claim carries it onto the account like any other shelf row.
    fun release(): Boolean {
        if (seat == Seat.anonymous) return false
        val quarantined = held.shelves[Seat.quarantine] ?: return false
        held = Held(held.shelves - Seat.quarantine + (seat to Shelf(
            exercises = quarantined.exercises.orEmpty() + mine.exercises.orEmpty(),
            routines = quarantined.routines.orEmpty() + mine.routines.orEmpty(),
            finished = quarantined.finished.orEmpty() + mine.finished.orEmpty(),
        )))
        flush()
        return true
    }

    fun discardUnattributed() {
        if (Seat.quarantine !in held.shelves) return
        held = Held(held.shelves - Seat.quarantine)
        flush()
    }

    val exercises: List<Exercise> get() = mine.exercises ?: emptyList()
    val finished: List<FinishedSession> get() = mine.finished ?: emptyList()

    // THE DAY A ROUTINE WAS LAST TRAINED IS DERIVED HERE AND NEVER STORED — the shelf's own version
    // of the aggregate the log computes (`max(started_at)` over the sessions run under it), read off
    // the finished sessions two lines up. Stored, it would have two ways to lie: it would still name
    // a day after that session was discarded, and it would say `never trained` over a workout this
    // same device recorded. Which is exactly what a signed-out routine used to say — and what the
    // word `untested` would have inherited.
    val routines: List<Routine> get() = stored.map { routine ->
        routine.copy(lastTrainedAtMs = finished
            .filter { it.session.routineId == routine.id }
            .maxOfOrNull { it.session.startedAtMs })
    }

    private val stored: List<Routine> get() = mine.routines ?: emptyList()

    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }

    fun row(sessionId: String): FinishedSession? = finished.firstOrNull { it.session.id == sessionId }

    fun detail(sessionId: String): SessionDetail? = row(sessionId)
        ?.let { SessionDetail(it.session, it.sets) }

    fun details(): List<SessionDetail> = finished.map { SessionDetail(it.session, it.sets) }

    // The log's own shape, newest first — the rows the log tab folds into weeks.
    fun summaries(): List<SessionSummary> = finished
        .sortedByDescending { it.session.startedAtMs }
        .map { SessionSummary(it.session, it.sets) }

    fun hold(exercise: Exercise) {
        keep(mine.copy(exercises = exercises + exercise))
    }

    // The rename of a movement this device minted and no account holds yet. It is the whole of the
    // signed-out rename: a catalog seed's per-lifter name is a row in the ACCOUNT's override table,
    // and the claim creates movements rather than overrides — so a seed renamed here would be a
    // name that silently reverted on the next connect, which is worse than a sentence saying where
    // the door is. Answers null when the shelf does not hold it, and the caller says so.
    fun renameExercise(id: String, name: String): Exercise? {
        val standing = exercises.firstOrNull { it.id == id } ?: return null
        val renamed = standing.copy(name = name)
        keep(mine.copy(exercises = exercises.map { if (it.id == id) renamed else it }))
        return renamed
    }

    fun claimExercise(id: String) {
        keep(mine.copy(exercises = exercises.filterNot { it.id == id }))
    }

    // A spent movement id changes EVERYWHERE this shelf wrote it — the movement itself, routine
    // lines, frozen plans, and every set — or the claim would land sets against an id the catalog
    // never minted.
    fun remintExercise(old: String, fresh: String) {
        keep(mine.copy(
            exercises = exercises.map { if (it.id == old) it.copy(id = fresh) else it },
            routines = stored.map { routine ->
                routine.copy(entries = routine.entries.map {
                    if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
                })
            },
            finished = finished.map { past ->
                past.copy(
                    session = remapPlan(past.session, old, fresh),
                    sets = past.sets.map { if (it.exerciseId == old) it.copy(exerciseId = fresh) else it },
                )
            },
        ))
    }

    // Add or replace by id — the signed-out create, the signed-out retarget and the builder's own
    // save all come through here. The last-trained instant is stripped on the way in for the reason
    // the getter derives it: a derived value written to disk is a second answer waiting to go stale.
    fun hold(routine: Routine) {
        keep(mine.copy(routines = stored.filterNot { it.id == routine.id } +
            routine.copy(lastTrainedAtMs = null)))
    }

    fun claimRoutine(id: String) {
        keep(mine.copy(routines = stored.filterNot { it.id == id }))
    }

    fun remintRoutine(old: String, fresh: String) {
        keep(mine.copy(
            routines = stored.map { if (it.id == old) it.copy(id = fresh) else it },
            finished = finished.map { past ->
                if (past.session.routineId != old) past
                else past.copy(session = past.session.copy(routineId = fresh))
            },
        ))
    }

    // Replace by session id, merging sets by id — never a second row. A crash between this hold
    // and the queue's forget leaves the same workout live again on relaunch, and its second
    // finish arrives here carrying everything the first hold did plus whatever was lifted since;
    // converging must not cost either copy a set.
    fun hold(finished: FinishedSession) {
        val standing = row(finished.session.id)
        // The tombstones survive every re-hold and they filter the merge: the queue's copy of the
        // same workout still carries a set §G18 deleted off this row, and a merge that took it back
        // would resurrect a set the lifter removed.
        val gone = ((standing?.deleted ?: emptyList()) + finished.deleted).distinct()
        val sets = (finished.sets + (standing?.sets ?: emptyList())
            .filter { old -> finished.sets.none { it.id == old.id } })
            .filterNot { it.id in gone }
        keep(mine.copy(finished = this.finished.filterNot { it.session.id == finished.session.id } +
            FinishedSession(finished.session, sets, gone)))
    }

    // THE SHELF'S OWN §G18, and the reason a fix on an unclaimed session never touches the wire: the
    // row has not been sent, so a correction rewrites what WILL be sent — no PATCH goes out for an id
    // the log has never seen, and the claim replays the CORRECTED set, never the original and never
    // both. Answers null where the shelf does not hold that set, which is how the caller tells the
    // device's rows from the account's.
    fun fixSet(sessionId: String, setId: String, fix: SetFix): TrainingSet? {
        val standing = row(sessionId)?.sets?.firstOrNull { it.id == setId } ?: return null
        if (!fix.moves(standing)) return standing
        val corrected = fix.corrected(standing)
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.map { if (it.id == setId) corrected else it })
        }))
        return corrected
    }

    // The delete's shelf half. The set leaves the row AND is remembered as gone, because part of
    // this session may already be on the account: a claim that landed the start and some of the
    // sets and then stopped retryably leaves the row here with the log already holding it.
    fun deleteSet(sessionId: String, setId: String): Boolean {
        val standing = row(sessionId) ?: return false
        if (standing.sets.none { it.id == setId }) return false
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.filterNot { it.id == setId },
                           deleted = past.deleted + setId)
        }))
        return true
    }

    // The row leaves the shelf for both reasons a row can leave a log: claimed onto the account
    // (the server holds it now), or discarded (nobody does).
    fun forget(sessionId: String) {
        keep(mine.copy(finished = finished.filterNot { it.session.id == sessionId }))
    }

    // The claim's other let-go: a routine id the log will never resolve — refused outright, or
    // deleted from another surface after it was claimed. The document leaves the shelf if it is
    // still here, and the sessions that named it keep their frozen plan — a snapshot, not a
    // reference — dropping only the id, so they replay ad-hoc rather than being refused.
    fun orphanRoutine(id: String) {
        keep(mine.copy(
            routines = stored.filterNot { it.id == id },
            finished = finished.map { past ->
                if (past.session.routineId != id) past
                else past.copy(session = past.session.copy(routineId = null))
            },
        ))
    }

    fun remintSession(old: String, fresh: String) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != old) past
            else past.copy(session = past.session.copy(id = fresh))
        }))
    }

    fun remintSet(sessionId: String, old: String, fresh: String) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.map { if (it.id == old) it.copy(id = fresh) else it })
        }))
    }

    // The claim's one loss door: a set the log refused forever leaves the shelf so it is not
    // re-refused on every connect — the RefusedSet the store publishes is its last copy. It leaves
    // no tombstone, and that is the difference from `deleteSet`: a set the log never took needs
    // nothing said to the account about it.
    fun dropSet(sessionId: String, setId: String) {
        keep(mine.copy(finished = finished.map { past ->
            if (past.session.id != sessionId) past
            else past.copy(sets = past.sets.filterNot { it.id == setId })
        }))
    }

    private fun remapPlan(session: Session, old: String, fresh: String): Session {
        val plan = session.plan ?: return session
        return session.copy(plan = plan.copy(entries = plan.entries.map {
            if (it.exerciseId == old) it.copy(exerciseId = fresh) else it
        }))
    }

    private fun flush() {
        val text = runCatching { diskJson.encodeToString(Held.serializer(), held) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
