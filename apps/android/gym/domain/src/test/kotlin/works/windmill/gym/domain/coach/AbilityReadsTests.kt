package works.windmill.gym.domain.coach

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.PlanSnapshot
import works.windmill.gym.domain.sync.RoutineEntry
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.SessionRules
import works.windmill.gym.domain.sync.SetTarget
import works.windmill.gym.domain.sync.TrainingSet
import works.windmill.gym.domain.sync.decide
import works.windmill.gym.domain.sync.reader
import works.windmill.gym.domain.sync.row
import works.windmill.gym.domain.sync.setRow
import works.windmill.sync.core.Json

// The log reads over a replica, for what the ability corpus leaves open: the orders a workout's and a movement's sets read in, and the `list_sessions` rows of a plan with an empty name, a workout holding no set and the open workout.
class AbilityReadsTests {
    // The newest page `list_sessions` answers over the given workouts and sets, a minute after the last instant they hold.
    private fun listed(sessions: List<Session>, sets: List<TrainingSet>): Json {
        val now = (sessions.map { it.finishedAt ?: it.startedAt } + sets.map { it.completedAt }).maxOf { it.ms } + 60_000
        val read = reader(sessions.map { row(it) } + sets.map { setRow(it) }, moment = Moment(Instant(now), FixedZone(0)))
        val page = decide(LogRead(LogRead.Query.Sessions(Instant(SessionRules.maxInstantMs), "", LogRead.defaultPage)), read)
        return (page as Decision.Unchanged).result.payload.member("sessions")
    }

    // A workout's sets read as performed, then by their number, then by id; a movement's last sets by their number, then by id.
    @Test fun setsReadInTheOrderEachListHolds() {
        val session = Session(Id("sesAAAAAAAAAAAA1", Session), Instant(1_000), Instant(90_000), "finish")
        fun set(id: String, at: Long, number: Int) = TrainingSet(Id(id, TrainingSet), session.id, Id("bench-press", Exercise), 60.0, 5, completedAt = Instant(at), setNumber = number)
        val sets = listOf(set("setAAAAAAAAAAAA3", 3_000, 1), set("setAAAAAAAAAAAA1", 2_000, 3), set("setAAAAAAAAAAAA2", 2_000, 2), set("setAAAAAAAAAAAA0", 2_000, 2))
        val read = reader(listOf(row(session)) + sets.map { setRow(it) }, moment = Moment(Instant(100_000), FixedZone(0)))
        fun ids(decision: Decision<AbilityAnswer, GymRefusal>) = (decision as Decision.Unchanged).result.payload.member("sets").arr().map { it.member("id").str() }
        assertEquals(listOf("setAAAAAAAAAAAA0", "setAAAAAAAAAAAA2", "setAAAAAAAAAAAA1", "setAAAAAAAAAAAA3"), ids(decide(LogRead(LogRead.Query.Workout(session.id, false)), read)))
        assertEquals(listOf("setAAAAAAAAAAAA3", "setAAAAAAAAAAAA0", "setAAAAAAAAAAAA2", "setAAAAAAAAAAAA1"), ids(decide(LogRead(LogRead.Query.LastTimeOf(Id("bench-press", Exercise))), read)))
    }

    // A plan with an empty name names no row; a workout holding no set has no line and no top set.
    @Test fun aRowGoesByNoEmptyNameAndAWorkoutHoldingNoSetHasNoLineAndNoTopSet() {
        val at = 1_789_740_800_000L
        val unnamed = Session(Id("sesRRRRRRRRRRRR1", Session), Instant(at), Instant(at + 3_600_000), "finish",
            plan = PlanSnapshot("", listOf(RoutineEntry(Id("bench-press", Exercise), listOf(SetTarget(5, 60.0))))))
        val empty = Session(Id("sesRRRRRRRRRRRR2", Session), Instant(at - 86_400_000), Instant(at - 82_800_000), "finish")
        val set = TrainingSet(Id("setR000000000001", TrainingSet), unnamed.id, Id("bench-press", Exercise), 60.0, 5, completedAt = Instant(at + 60_000))
        assertEquals(Json.parse("""[
            {"id": "sesRRRRRRRRRRRR1", "startedAt": 1789740800000, "finishedAt": 1789744400000, "setCount": 1, "workingSetCount": 1, "tonnageKg": 300,
             "exercises": ["Bench Press"], "topSet": {"exerciseId": "bench-press", "weightKg": 60, "reps": 5}, "topE1rm": 70, "record": false, "closedItself": false,
             "movements": [{"exerciseId": "bench-press", "topSet": {"weightKg": 60, "reps": 5}, "topE1rm": 70}]},
            {"id": "sesRRRRRRRRRRRR2", "startedAt": 1789654400000, "finishedAt": 1789658000000, "setCount": 0, "workingSetCount": 0, "tonnageKg": 0,
             "exercises": [], "topE1rm": null, "record": false, "closedItself": false, "movements": []}
        ]"""), listed(listOf(unnamed, empty), listOf(set)))
    }

    // The open workout lists the movements it holds so far, and a line's estimate is its best set's, not its heaviest set's.
    @Test fun theOpenWorkoutsRowListsItsMovementsSoFarEachEstimateBeingItsBestSets() {
        val at = 1_789_740_800_000L
        val open = Session(Id("sesOOOOOOOOOOOO1", Session), Instant(at))
        fun set(id: String, weightKg: Double, reps: Int, after: Long) = TrainingSet(Id(id, TrainingSet), open.id, Id("deadlift", Exercise), weightKg, reps, completedAt = Instant(at + after))
        assertEquals(Json.parse("""[
            {"id": "sesOOOOOOOOOOOO1", "startedAt": 1789740800000, "setCount": 2, "workingSetCount": 2, "tonnageKg": 1140, "exercises": ["Deadlift"],
             "topSet": {"exerciseId": "deadlift", "weightKg": 150, "reps": 2}, "topE1rm": 168, "record": false, "closedItself": false,
             "movements": [{"exerciseId": "deadlift", "topSet": {"weightKg": 150, "reps": 2}, "topE1rm": 168}]}
        ]"""), listed(listOf(open), listOf(set("setO000000000001", 140.0, 6, 60_000), set("setO000000000002", 150.0, 2, 120_000))))
    }
}
