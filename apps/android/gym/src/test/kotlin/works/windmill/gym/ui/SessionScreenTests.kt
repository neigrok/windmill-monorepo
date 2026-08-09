package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.Exercise
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet

// A session read back is the workout as it was LIVED: movements in the order they were first
// touched, sets inside a movement in the order they were performed. Nothing here re-sorts by load,
// by number or by name — an order that disagreed with the session would be a second account of it.

class SessionScreenTests {
    private val catalog = listOf(
        Exercise(id = "bench-press", name = "Bench press"),
        Exercise(id = "row", name = "Barbell row"),
    )

    private fun set(
        id: String,
        exerciseId: String,
        weightKg: Double,
        reps: Int,
        at: Long,
        number: Int? = null,
        kind: SetKind = SetKind.Working,
    ) = TrainingSet(id = id, exerciseId = exerciseId, setNumber = number, weightKg = weightKg,
                    reps = reps, kind = kind, completedAtMs = at)

    // Interleaved on the clock — a lifter supersetting two movements — and grouped on screen, with
    // the movement order taken from when each was FIRST touched.
    @Test
    fun setsAreGroupedByMovementInTheOrderTheyWereFirstTouched() {
        val movements = Performed.movements(listOf(
            set("s4", "row", 60.0, 10, at = 4_000, number = 2),
            set("s1", "bench-press", 80.0, 5, at = 1_000, number = 1),
            set("s3", "bench-press", 82.5, 5, at = 3_000, number = 2),
            set("s2", "row", 60.0, 10, at = 2_000, number = 1),
        ), catalog)

        assertEquals(listOf("Bench press", "Barbell row"), movements.map { it.movement })
        assertEquals(listOf("s1", "s3"), movements[0].rows.map { it.id })
        assertEquals(listOf("s2", "s4"), movements[1].rows.map { it.id })
        assertEquals(listOf("80 × 5", "82.5 × 5"), movements[0].rows.map { it.effort })
        assertEquals(listOf("1", "2"), movements[0].rows.map { it.number })
    }

    // The number is the LOG's own count of this movement in this session. A row that somehow
    // arrives without one is still numbered, from its place in the movement's own run — a
    // numberless row in a column of numbers reads as a set that did not count.
    @Test
    fun aSetWithNoNumberFromTheLogIsNumberedByItsPlaceInTheRun() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 80.0, 5, at = 1_000),
            set("s2", "bench-press", 80.0, 5, at = 2_000),
        ), catalog)

        assertEquals(listOf("1", "2"), movements[0].rows.map { it.number })
    }

    // A warmup counts toward nothing — not the records, not the prefill, not the comparison — so
    // the kind travels to the screen rather than being flattened into a row that looks like a
    // working set.
    @Test
    fun theKindTravelsSoAWarmupIsNotDrawnAsAWorkingSet() {
        val movements = Performed.movements(listOf(
            set("s1", "bench-press", 40.0, 8, at = 1_000, number = 1, kind = SetKind.Warmup),
            set("s2", "bench-press", 80.0, 5, at = 2_000, number = 1),
            set("s3", "bench-press", 80.0, 3, at = 3_000, number = 2, kind = SetKind.Failure),
        ), catalog)

        assertEquals(listOf(SetKind.Warmup, SetKind.Working, SetKind.Failure),
                     movements[0].rows.map { it.kind })
        assertEquals(listOf("40 × 8", "80 × 5", "80 × 3"), movements[0].rows.map { it.effort })
    }

    // The catalog has not answered yet, or never will: a slug a lifter can still recognise beats a
    // blank where the movement should be. The same fallback the whole product uses.
    @Test
    fun aMovementTheCatalogHasNoNameForKeepsItsId() {
        val movements = Performed.movements(listOf(set("s1", "zercher-squat", 60.0, 5, at = 1_000)),
                                            catalog)

        assertEquals(listOf("zercher-squat"), movements.map { it.movement })
        assertEquals(listOf("zercher-squat"), movements.map { it.id })
    }

    @Test
    fun aSessionWithNoSetsGroupsIntoNothing() {
        assertEquals(emptyList<Performed.Movement>(), Performed.movements(emptyList(), catalog))
    }
}
