package works.windmill.gym.domain.sync

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.withActionContext
import works.windmill.sync.api.CommitFailure
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.modelserver.GymServerRules
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.testing.SteppedEngine

class RoutinePlanTests {
    @Test fun routineAndMovementEditsCommitTogetherAndServerRefusalRollsEverythingBack() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val seed = SeedExercises.all.first { it.id == Id("bench-press", Exercise) }
                val custom = Exercise(runner.mint(Exercise), "Single press", "press", "dumbbell", 2.0, loadCount = 1)
                val base = Routine(runner.mint(Routine))
                val current = base.copy(name = "Push", entries = listOf(
                    RoutineEntry(seed.id, listOf(SetTarget(8, 60.0))), RoutineEntry(custom.id)))
                val action = SaveRoutinePlan(base, current, true, listOf(
                    RoutineMovementChange(seed, seed.copy(name = "My press")), RoutineMovementChange(null, custom)))
                assertTrue(runner.run(action) is Outcome.Committed)
                assertEquals(listOf(current), phone.drawn(Routine.scope, Routine.type).map { Routine.decode(Fields(it)) })
                assertEquals(custom, runner.read(Routine.scope) { Catalogue(it).find(custom.id) })
                assertEquals(seed.copy(name = "My press", aliases = listOf(seed.name)),
                    runner.read(Routine.scope) { Catalogue(it).find(seed.id) })
                phone.server.refuse(code = "invalid")
                phone.sync()
                assertEquals(emptyList<Routine>(), phone.drawn(Routine.scope, Routine.type).map { Routine.decode(Fields(it)) })
                assertEquals(emptyList<Exercise>(), phone.drawn(Routine.scope, Exercise.type).map { Exercise.decode(Fields(it)) })
                assertEquals(emptyList<ExerciseName>(), phone.drawn(Routine.scope, ExerciseName.type).map { ExerciseName.decode(Fields(it)) })
                assertEquals(seed, runner.read(Routine.scope) { Catalogue(it).find(seed.id) })
                assertEquals(listOf(RefusalCode.invalid), phone.notices("gym").map { it.code })
            }
        }
    }

    @Test fun failedCommitLeavesNoPartialRoutineMovementOrAliasesAndCanRetry() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, account = null, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val seed = SeedExercises.all.first { it.id == Id("bench-press", Exercise) }
                val custom = Exercise(runner.mint(Exercise), "Press", "press", "barbell", 2.5)
                val base = Routine(runner.mint(Routine))
                val current = base.copy(name = "Push", entries = listOf(RoutineEntry(seed.id), RoutineEntry(custom.id)))
                val action = SaveRoutinePlan(base, current, true, listOf(
                    RoutineMovementChange(seed, seed.copy(name = "My press")), RoutineMovementChange(null, custom)))
                phone.failNextCommit()
                assertThrows(CommitFailure::class.java) { runner.run(action) }
                assertEquals(emptyList<Routine>(), phone.drawn(Routine.scope, Routine.type).map { Routine.decode(Fields(it)) })
                assertEquals(emptyList<Exercise>(), phone.drawn(Routine.scope, Exercise.type).map { Exercise.decode(Fields(it)) })
                assertNull(runner.read(Routine.scope) { it.device(Catalogue.formerNamesKey) })
                assertTrue(runner.run(action) is Outcome.Committed)
                assertEquals(listOf(current), phone.drawn(Routine.scope, Routine.type).map { Routine.decode(Fields(it)) })
                assertEquals(custom, runner.read(Routine.scope) { Catalogue(it).find(custom.id) })
                assertEquals(listOf(seed.name), runner.read(Routine.scope) { Catalogue(it).find(seed.id)!!.aliases })
            }
        }
    }

    @Test fun aConcurrentEquipmentChangeRefusesTheEntireTargetAndRenamePlanAsANotice() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, rules = GymServerRules()).use { first ->
            first.device().use { second ->
                withActionContext { context ->
                    val a = ActionRunner(first.replica, SyncSchema.registry, FixedZone(0), context)
                    val b = ActionRunner(second.replica, SyncSchema.registry, FixedZone(0), context)
                    val movement = Exercise(a.mint(Exercise), "Press", "press", "barbell", 2.5)
                    assertTrue(a.run(CreateExercise(movement)) is Outcome.Committed)
                    first.sync()
                    val base = Routine(a.mint(Routine), "Push", entries = listOf(RoutineEntry(movement.id)))
                    assertTrue(a.run(SaveRoutinePlan(base, base, true, emptyList())) is Outcome.Committed)
                    first.sync()
                    val equipment = movement.copy(equipment = "dumbbell", loadCount = 1)
                    assertTrue(a.run(SaveRoutinePlan(base, base, false, listOf(RoutineMovementChange(movement, equipment)))) is Outcome.Committed)
                    val custom = Exercise(b.mint(Exercise), "New press", "press", "barbell", 2.5)
                    val current = base.copy(name = "Push revised", entries = listOf(
                        RoutineEntry(movement.id, listOf(SetTarget(8, 60.0))), RoutineEntry(custom.id)))
                    assertTrue(b.run(SaveRoutinePlan(base, current, false, listOf(
                        RoutineMovementChange(movement, movement.copy(name = "My press")), RoutineMovementChange(null, custom)))) is Outcome.Committed)
                    first.sync()
                    assertEquals(listOf(base.fields()), second.drawn(Routine.scope, Routine.type).map { Routine.decode(Fields(it)).fields() })
                    assertEquals(listOf(movement), second.drawn(Routine.scope, Exercise.type).map { Exercise.decode(Fields(it)) })
                    assertEquals(equipment, b.read(Routine.scope) { Catalogue(it).find(movement.id) })
                    assertEquals(listOf(RefusalCode.stale), second.notices("gym").map { it.code })
                }
            }
        }
    }

    @Test fun repeatedRenamesPreserveAllLocalAliasesAndReturningToDumbbellsReplacesTheOldCount() = runBlocking<Unit> {
        SteppedEngine(SyncSchema.registry, testMoment.now.ms, account = null, rules = GymServerRules()).use { phone ->
            withActionContext { context ->
                val runner = ActionRunner(phone.replica, SyncSchema.registry, FixedZone(0), context)
                val custom = Exercise(runner.mint(Exercise), "Press", "press", "dumbbell", 2.0, loadCount = 1)
                val seed = SeedExercises.all.first { it.id == Id("bench-press", Exercise) }
                val base = Routine(runner.mint(Routine), "Push", entries = listOf(RoutineEntry(custom.id), RoutineEntry(seed.id)))
                assertTrue(runner.run(SaveRoutinePlan(base, base, true, listOf(RoutineMovementChange(null, custom)))) is Outcome.Committed)
                val barbell = custom.copy(name = "Barbell press", equipment = "barbell", loadCount = 1)
                val namedSeed = seed.copy(name = "Main press")
                assertTrue(runner.run(SaveRoutinePlan(base, base, false, listOf(
                    RoutineMovementChange(custom, barbell), RoutineMovementChange(seed, namedSeed)))) is Outcome.Committed)
                val catalogue = runner.read(Routine.scope) { Catalogue(it) }
                val renamed = catalogue.find(custom.id)!!.copy(name = "Dumbbell press", equipment = "dumbbell", loadCount = 2)
                val renamedSeed = catalogue.find(seed.id)!!.copy(name = "Main bench")
                assertTrue(runner.run(SaveRoutinePlan(base, base, false, listOf(
                    RoutineMovementChange(catalogue.find(custom.id), renamed),
                    RoutineMovementChange(catalogue.find(seed.id), renamedSeed)))) is Outcome.Committed)
                val expectedAliases = Json.objectOf(
                    custom.id.record.toString() to Json.objectOf("name" to Json.of("Dumbbell press"),
                        "aliases" to Json.array(Json.of("Barbell press"), Json.of("Press"))),
                    seed.id.record.toString() to Json.objectOf("name" to Json.of("Main bench"),
                        "aliases" to Json.array(Json.of("Main press"), Json.of(seed.name))))
                assertEquals(expectedAliases, runner.read(Routine.scope) { it.device(Catalogue.formerNamesKey) })
                assertEquals(renamed.copy(aliases = listOf("Barbell press", "Press")), runner.read(Routine.scope) { Catalogue(it).find(custom.id) })
                assertEquals(renamedSeed.copy(aliases = listOf("Main press", seed.name)), runner.read(Routine.scope) { Catalogue(it).find(seed.id) })
                assertEquals(listOf(base), phone.drawn(Routine.scope, Routine.type).map { Routine.decode(Fields(it)) })
            }
        }
    }
}
