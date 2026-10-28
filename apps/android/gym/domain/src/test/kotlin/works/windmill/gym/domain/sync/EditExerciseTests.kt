package works.windmill.gym.domain.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.withActionContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

class EditExerciseTests {
    @Test fun commitFailureAndServerRefusalKeepNameLoadingAndAliasesTogether() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val base = Exercise(runner.mint(Exercise), "Press", "press", "barbell", 2.5)
                assertTrue(runner.run(CreateExercise(base)) is Outcome.Committed)
                phone.sync()
                val edit = EditExercise(base, "Pair press", "dumbbell", 2)
                phone.failNextCommit()
                assertThrows(CommitFailure::class.java) { runner.run(edit) }
                assertEquals(base, runner.read(Exercise.scope) { Catalogue(it).find(base.id) })
                assertNull(runner.read(Exercise.scope) { it.device(Catalogue.formerNamesKey) })
                assertEquals(emptyList<ExerciseName>(), phone.drawn(Exercise.scope, ExerciseName.type).map { ExerciseName.decode(Fields(it)) })
                assertTrue(runner.run(edit) is Outcome.Committed)
                assertEquals(base.copy(name = "Pair press", equipment = "dumbbell", loadCount = 2, aliases = listOf("Press")),
                    runner.read(Exercise.scope) { Catalogue(it).find(base.id) })
                phone.server.refuse(code = "invalid")
                phone.sync()
                assertEquals(base, runner.read(Exercise.scope) { Catalogue(it).find(base.id) })
                assertEquals(emptyList<ExerciseName>(), phone.drawn(Exercise.scope, ExerciseName.type).map { ExerciseName.decode(Fields(it)) })
                assertEquals(listOf(RefusalCode.invalid), phone.notices("gym").map { it.code })
            }
        }
    }

    @Test fun loadingRaceRefusesTheWholeNameAndMetadataBatch() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, rules = GymServerRules()).use { first ->
            first.device().use { second ->
                withActionContext { context ->
                    val a = ActionRunner(first.replica, SyncSchema.registry, FixedZone(0), context)
                    val b = ActionRunner(second.replica, SyncSchema.registry, FixedZone(0), context)
                    val base = Exercise(a.mint(Exercise), "Press", "press", "barbell", 2.5)
                    a.run(CreateExercise(base)); first.sync()
                    assertTrue(a.run(EditExercise(base, "First", "dumbbell", 1)) is Outcome.Committed)
                    assertTrue(b.run(EditExercise(base, "Second", "dumbbell", 2)) is Outcome.Committed)
                    first.sync()
                    val expected = base.copy(name = "First", equipment = "dumbbell", loadCount = 1, aliases = listOf("Press"))
                    assertEquals(expected, a.read(Exercise.scope) { Catalogue(it).find(base.id) })
                    assertEquals(expected, b.read(Exercise.scope) { Catalogue(it).find(base.id) })
                    assertEquals(listOf(RefusalCode.stale), second.notices("gym").map { it.code })
                    assertEquals(listOf(ExerciseName(Id(base.id.record, ExerciseName), null, equipment = "dumbbell", loadCount = 1)),
                        second.drawn(Exercise.scope, ExerciseName.type).map { ExerciseName.decode(Fields(it)) })
                }
            }
        }
    }

    @Test fun aNameEditPreservesRemoteLoadingAndRepeatedAliasesAcrossEquipmentChanges() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, account = null, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val base = Exercise(runner.mint(Exercise), "Press", "press", "barbell", 2.5)
                runner.run(CreateExercise(base))
                runner.run(EditExercise(base, "Press", "dumbbell", 1))
                runner.run(EditExercise(base, "Mine", "barbell", 1))
                val one = runner.read(Exercise.scope) { Catalogue(it).find(base.id)!! }
                assertEquals(base.copy(name = "Mine", equipment = "dumbbell", loadCount = 1, aliases = listOf("Press")), one)
                runner.run(EditExercise(one, "Single", "bodyweight", 1))
                val assisted = runner.read(Exercise.scope) { Catalogue(it).find(base.id)!! }
                runner.run(EditExercise(assisted, "Pair", "dumbbell", 2))
                val expected = base.copy(name = "Pair", equipment = "dumbbell", loadCount = 2, aliases = listOf("Single", "Mine", "Press"))
                assertEquals(expected, runner.read(Exercise.scope) { Catalogue(it).find(base.id) })
                assertEquals(listOf(expected), runner.read(Exercise.scope) { Catalogue(it).search("SINGLE") })
                assertEquals(listOf(base.copy(name = "Pair")), phone.drawn(Exercise.scope, Exercise.type).map { Exercise.decode(Fields(it)) })
            }
        }
    }
}
