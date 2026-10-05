package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.sync.core.Json
import works.windmill.sync.engine.nextPush

class BodyweightClaimTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun everyWeighInAndDeletionMigratesWithoutLosingItsDateOrRecordedTime() = runBlocking {
        val f = LegacyEngineFixture(tmp.root); val weights = f.weights
        val rows = listOf(WeighIn("2026-08-25", 82.4, f.now - 2_000), WeighIn("2026-08-26", 82.0, f.now - 1_000))
        rows.forEach(weights::record); weights.delete("2026-08-20")
        f.engine().use { e -> f.migrate(e); assertEquals(rows, EngineTraining(e) { null }.bodyweight())
            assertEquals(listOf("2026-08-20"), f.items(e).filter { it["kind"] == Json.of("deleteWeighin") }.map { it.member("id").str() })
            assertEquals(rows, LocalBodyweight(File(tmp.root, LocalBodyweight.fileName)).entries) }
    }
    @Test fun aStaleWriteKeepsTheLogsNewerRowOnThisPhoneToo() = runBlocking {
        val f = LegacyEngineFixture(tmp.root); f.engine().use { e -> val gym = EngineTraining(e) { null }
            gym.putBodyweight("2026-08-25", WeighInWrite(83.0, f.now - 1_000))
            assertEquals(83.0, gym.putBodyweight("2026-08-25", WeighInWrite(82.4, f.now - 2_000)).weightKg, 0.0)
            assertEquals(83.0, gym.bodyweight().single().weightKg, 0.0) }
    }
    @Test fun anOfflineWeighInRemainsOwedInTheReplicaAcrossRestart() = runBlocking {
        val f = LegacyEngineFixture(tmp.root); val row = WeighIn("2026-08-25", 82.4, f.now - 1_000); f.weights.record(row)
        val first = f.engine(); f.migrate(first); assertNull(first.nextPush()); val snapshot = first.snapshot(); first.close()
        f.engine(snapshot).use { e -> f.migrate(e); assertEquals(listOf(row), EngineTraining(e) { null }.bodyweight()); assertEquals(1, f.outbox(e).size) }
    }
    @Test fun aStrictRefusalKeepsItsOriginalWeighInOnThePhoneUntilExplicitDiscard() {
        val f = LegacyEngineFixture(tmp.root); f.weights.record(WeighIn("2026-08-25", 82.4, f.now - 1_000))
        val file = File(tmp.root, LocalBodyweight.fileName); file.writeText(file.readText().replace("82.4", "900.0")); val original = file.readText()
        f.engine().use { e -> f.migrate(e); val refusal = LegacyGymMigration.refusals(e).single()
            assertEquals("2026-08-25", refusal.id); assertEquals(original, file.readText()); assertEquals(Json.of(900.0), f.items(e).single().member("source").member("weightKg"))
            LegacyGymMigration.discardRefusal(e, refusal.id); assertTrue(LegacyGymMigration.refusals(e).isEmpty()); assertEquals(original, file.readText()) }
    }
    @Test fun aWorkoutWaitingForAnExplicitFixDoesNotLoseAnIndependentWeighIn() = runBlocking {
        val f = LegacyEngineFixture(tmp.root); f.log.hold(f.row(start = f.now + 5_000)); val weight = WeighIn("2026-08-25", 82.4, f.now - 1_000); f.weights.record(weight)
        f.engine().use { e -> f.migrate(e); assertEquals(listOf(weight), EngineTraining(e) { null }.bodyweight())
            assertEquals("bad-instant", LegacyGymMigration.refusals(e).single().code); assertEquals(1, f.outbox(e).size) }
    }
}
