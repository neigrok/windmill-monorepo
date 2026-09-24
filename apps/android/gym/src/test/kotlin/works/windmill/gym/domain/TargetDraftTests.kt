package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class TargetDraftTests {
    @Test
    fun newMovementStartsWithThreeSetsOfTenAndNoLoad() {
        val scheme = TargetEntry.Draft()
        val targets = (scheme.reading as TargetEntry.Reading.Scheme).sets
        assertEquals(List(3) { SetTarget(10) }, targets)
        assertEquals(RoutineDraft(name = "Push", entries = listOf(
            RoutineEntry(1, "custom-press", List(3) { SetTarget(10) }),
        )), RoutineDraft(name = "Push").adding("custom-press", targets))
    }

    @Test
    fun schemeRoundTripPreservesSignedLoadsAndVariableTargets() {
        val targets = listOf(SetTarget(8, -20.0), SetTarget(6, -10.0), SetTarget(null, null))
        val draft = TargetEntry.Draft(targets)
        val encoded = WindmillJson.encodeToString(TargetEntry.Draft.serializer(), draft)
        assertEquals("""{"rows":[{"reps":"8","weight":"−20"},{"reps":"6","weight":"−10"},{}],"varyBySet":true}""", encoded)
        assertEquals(TargetEntry.Reading.Scheme(targets),
            WindmillJson.decodeFromString(TargetEntry.Draft.serializer(), encoded).reading)
    }

    @Test
    fun rawInvalidValuesAndHiddenRowsSurviveSaveAndRestore() {
        val draft = TargetEntry.Draft(rows = listOf(
            TargetEntry.TypedSet("8", "50"), TargetEntry.TypedSet("six", "70..5"),
        ), sets = "1", varyBySet = true)
        val saved = WindmillJson.encodeToString(TargetEntry.Draft.serializer(), draft)
        val restored = WindmillJson.decodeFromString(TargetEntry.Draft.serializer(), saved)
        assertEquals(TargetEntry.Reading.Scheme(listOf(SetTarget(8, 50.0))), restored.reading)
        assertEquals(draft.copy(sets = "2"), restored.withCount("2"))
        assertEquals(TargetEntry.Reading.Refused(1, TargetEntry.Field.Reps, TargetEntry.notANumber),
            restored.withCount("2").reading)
        assertEquals(TargetEntry.Reading.Open, restored.withCount("").reading)
        assertEquals(draft, restored.withCount("").withCount("1"))
    }

    @Test
    fun stepsRespectBoundsAbsencesAndTypedRefusals() {
        val draft = TargetEntry.Draft()
        assertEquals(TargetEntry.Reading.Scheme(List(4) { SetTarget(11, 1.0) }),
            draft.stepped(TargetEntry.Field.Sets, 1).stepped(TargetEntry.Field.Reps, 1)
                .stepped(TargetEntry.Field.Weight, 1).reading)
        assertEquals(TargetEntry.Reading.Scheme(List(3) { SetTarget(10, -1.0) }),
            draft.stepped(TargetEntry.Field.Weight, -1).reading)
        assertEquals(TargetEntry.Reading.Open,
            draft.withCount("1").stepped(TargetEntry.Field.Sets, -1).reading)
        val ceiling = draft.withCount("20")
        assertEquals(ceiling, ceiling.stepped(TargetEntry.Field.Sets, 1))
        val invalid = draft.withCount("2.5")
        assertEquals(invalid, invalid.stepped(TargetEntry.Field.Sets, 1))
    }
}
