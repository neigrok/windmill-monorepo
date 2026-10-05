package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.sync.api.Change
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.schema.SyncSchema

class CataloguePreferencesTests {
    val custom = Exercise(Id("exercise1", Exercise), "Custom squat", "squat", "barbell", 2.5, listOf("Old squat"))

    @Test fun seedCatalogueHasSixtyFourDistinctMovementsAndEquipmentSteps() {
        assertEquals(64, SeedExercises.all.size)
        assertEquals(64, SeedExercises.all.map { it.id }.distinct().size)
        assertEquals(setOf("squat", "hinge", "press", "pull", "carry", "core", "isolation"), SeedExercises.all.map { it.pattern }.toSet())
        for ((equipment, step) in mapOf("barbell" to 2.5, "dumbbell" to 2.0, "machine" to 5.0, "cable" to 2.5, "bodyweight" to 2.5, "kettlebell" to 4.0)) {
            assertEquals(step, ExerciseRules.defaultStepKg(equipment), 0.0)
            assertTrue(SeedExercises.all.filter { it.equipment == equipment }.all { it.stepKg == step })
        }
        for (id in listOf("dip", "pull-up", "muscle-up")) assertNotNull(Catalogue(emptyList(), emptyList()).find(Id(id, Exercise)))
        assertFalse((Exercise as EntityType<*>) is RemovableType<*>)
    }

    @Test fun catalogueReadsAliasesOverridesHeldSeedNamesAndStableNameOrdering() {
        val override = ExerciseName(Id(squat.record, ExerciseName), "My squat", listOf("Back Squat", "Previous"))
        val catalogue = Catalogue(listOf(custom), listOf(override))
        assertEquals(SeedExercises.all.first { it.id == squat }.copy(name = "My squat", aliases = override.aliases), catalogue.find(squat))
        assertEquals(custom, catalogue.find(custom.id))
        assertEquals(listOf(catalogue.find(squat)!!), catalogue.search("bACK sQUAT"))
        assertEquals(listOf(custom), catalogue.search("OLD SQUAT"))
        assertEquals(catalogue.exercises, catalogue.search(""))
        assertEquals(catalogue.exercises.sortedWith { a, b -> works.windmill.sync.core.compareBytes(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id) }, catalogue.exercises)
        val held = Catalogue(listOf(custom), listOf(override.copy(name = null)))
        assertEquals("Back Squat", held.find(squat)!!.name)
        assertEquals(override.aliases, held.find(squat)!!.aliases)
        val storedCustom = row(custom).copy(values = custom.fields() + ("aliases" to Json.Arr(custom.aliases.map(Json::of))))
        val localCustom = custom.copy(name = "Local squat")
        val drawnCustom = row(localCustom).copy(values = localCustom.fields() + ("aliases" to Json.Arr(custom.aliases.map(Json::of))))
        val read = reader(listOf(storedCustom, row(override)), listOf(drawnCustom))
        assertEquals("Local squat", Catalogue(read).find(custom.id)!!.name)
        assertEquals(listOf("Old squat"), Catalogue(read).find(custom.id)!!.aliases)
        assertEquals(custom, Catalogue(read, works.windmill.sync.api.ViewMode.stored).find(custom.id))
    }

    @Test fun aliasesKeepNewestFiveWithoutRepeatingCurrentName() {
        assertEquals(listOf("Old", "A", "B", "C", "D"), ExerciseRules.renamedAliases("Old", "New", listOf("New", "A", "Old", "B", "C", "D", "E")))
        assertEquals(listOf("New", "A", "B"), ExerciseRules.renamedAliases("New", "Old", listOf("Old", "A", "B", "New")))
    }

    @Test fun customCreationWritesConstFieldsButNeverServerAliases() {
        val result = writing(decide(CreateExercise(custom.copy(name = "  Cafe\u0301 squat  ", stepKg = 2.125))))
        val value = custom.copy(name = "Café squat", stepKg = 2.13)
        assertEquals(custom.id, result.result)
        assertEquals(listOf(Change.create(Exercise.type, works.windmill.sync.api.NewID.Given(custom.id.record), value.fields())),
            result.plan.gesture(Exercise.scope, SyncSchema.registry).changes)
        assertFalse(result.plan.operations.single().values.containsKey("aliases"))
    }

    @Test fun exerciseChecksAllClientFieldsAndNormalizesNames() {
        for ((value, field, reason) in listOf(
            Triple(custom.copy(name = "\u3000\n"), "name", Violation.Reason.Blank),
            Triple(custom.copy(name = "x".repeat(61)), "name", Violation.Reason.TooLong(60, MeasureUnit.chars, 61)),
            Triple(custom.copy(pattern = "push"), "pattern", Violation.Reason.NotOneOf),
            Triple(custom.copy(equipment = "other"), "equipment", Violation.Reason.NotOneOf),
            Triple(custom.copy(stepKg = 0.0), "stepKg", Violation.Reason.Below(0.01)),
            Triple(custom.copy(stepKg = 100.0), "stepKg", Violation.Reason.Above(99.99))))
            invalid(decide(CreateExercise(value)), "exercise.$field", field, reason)
        for (step in listOf(0.01, 99.99)) assertEquals(step, Valid(custom.copy(stepKg = step), Exercise, at = testMoment).value.stepKg, 0.0)
        invalidValue("exerciseName.name", "name", Violation.Reason.Blank) {
            Valid(ExerciseName(Id(squat.record, ExerciseName), "  "), ExerciseName, at = testMoment)
        }
        invalidValue("exerciseName.name", "name", Violation.Reason.TooLong(60, MeasureUnit.chars, 61)) {
            Valid(ExerciseName(Id(squat.record, ExerciseName), "😀".repeat(61)), ExerciseName, at = testMoment)
        }
        assertEquals("😀".repeat(60), Valid(ExerciseName(Id(squat.record, ExerciseName), "😀".repeat(60)), ExerciseName, at = testMoment).value.name)
    }

    @Test fun renameWritesSeedOverrideOrOnlyCustomNameAndUsesStoredDisplayedName() {
        val changed = writing(decide(RenameExercise(custom.id, "  New  "), reader(listOf(row(custom)), listOf(row(custom.copy(name = "New"))))))
        assertEquals(listOf(Change.update(Exercise.type, custom.id.record, mapOf("name" to Json.of("New")))), changed.plan.gesture(Exercise.scope, SyncSchema.registry).changes)
        val seed = writing(decide(RenameExercise(squat, "My squat"))).plan.gesture(Exercise.scope, SyncSchema.registry)
        assertEquals(listOf(Change.write(ExerciseName.type, squat.record, mapOf("name" to Json.of("My squat")))), seed.changes)
        val overridden = ExerciseName(Id(squat.record, ExerciseName), "My squat")
        val back = writing(decide(RenameExercise(squat, "Back Squat"), reader(listOf(row(overridden))))).plan.gesture(Exercise.scope, SyncSchema.registry)
        assertEquals(listOf(Change.write(ExerciseName.type, squat.record, mapOf("name" to Json.of("Back Squat")))), back.changes)
        assertEquals(Decision.Unchanged(Unit), decide(RenameExercise(squat, " Back Squat ")))
        assertEquals(Decision.Refuse(GymRefusal.Gone(custom.id.ref, Refused.Path.predicted)), decide(RenameExercise(custom.id, "New")))
    }

    @Test fun preferencesDefaultAndPhoneDraftWritesOnlyPhoneFields() {
        assertEquals(Preferences(units = "kg", confirmHaptic = true, confirmSound = false), Preferences.decode(Fields(Preferences.type, Preferences().id.record, emptyMap())))
        assertEquals(RestSettings(null, true), restSettings(reader()))
        val stored = row(Preferences, Preferences().id.record, mapOf("units" to Json.of("lb")))
        val drawn = stored.copy(values = mapOf("units" to Json.of("kg"), "restSeconds" to Json.of(180), "restSound" to Json.of(false)))
        assertEquals(RestSettings(180, false), restSettings(reader(listOf(stored), listOf(drawn))))
        val result = writing(decide(savePreferences(Preferences(units = "lb", confirmHaptic = false, confirmSound = true))))
        assertEquals(listOf(Change.write(Preferences.type, Preferences().id.record,
            mapOf("units" to Json.of("lb"), "confirmHaptic" to Json.of(false), "confirmSound" to Json.of(true)))), result.plan.gesture(Preferences.scope, SyncSchema.registry).changes)
        assertTrue(result.plan.gesture(Preferences.scope, SyncSchema.registry).guards.isEmpty())
        invalid(decide(savePreferences(Preferences(units = "stones"))), "prefs.units", "units", Violation.Reason.NotOneOf)
    }

    @Test fun preferenceEditsAreUnguardedAndPreserveConcurrentUntouchedFields() {
        val base = Preferences()
        val current = base.copy(units = "lb")
        val concurrent = base.copy(confirmSound = true)
        val action = SaveDraft.fromDraft(Draft.opening(base).edit { current }, Preferences, GymRefusal)
        val gesture = writing(decide(action, reader(listOf(row(concurrent))))).plan.gesture(Preferences.scope, SyncSchema.registry)
        assertEquals(listOf(Change.write(Preferences.type, base.id.record, mapOf("units" to Json.of("lb")))), gesture.changes)
        assertTrue(gesture.guards.isEmpty())
    }
}
