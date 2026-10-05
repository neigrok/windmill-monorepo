package works.windmill.gym.store

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApiException
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.*
import works.windmill.sync.engine.*
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.schema.Gym
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.modelserver.Credential

class GymEngineSessionTests {
    @get:Rule val tmp = TemporaryFolder()
    private val gym = ScopeRef.product("gym")
    private fun localMovement(engine: Engine, id: String = "local-movement") {
        engine.commit(gym) { Gesture(listOf(Change.create("exercise", NewID.Given(RecordID(id)),
            mapOf("name" to Json.of("Local movement"), "pattern" to Json.of("isolation"), "equipment" to Json.of("barbell"), "stepKg" to Json.of(2.5))))) to Unit }
        engine.releaseHeld(true)
    }
    private class Tokens : SessionTokens {
        val values = mutableMapOf<String, String>()
        override fun token(account: String) = values[account]
        override fun save(account: String, token: String) { values[account] = token }
        override fun delete(account: String) { values.remove(account) }
        override fun accounts() = values.keys.toSet()
    }
    private fun transport(holdsRecords: Boolean) = object : SyncTransport {
        override suspend fun hello(token: String?) = Reply.Answer(SyncResponse(200, Json.objectOf(
            "serverTime" to Json.of(System.currentTimeMillis()), "epoch" to Json.of("epoch"), "schema" to Json.of(5), "minSchema" to Json.of(5),
            "as" to Json.of("A"), "holdsRecords" to Json.objectOf("gym" to Json.of(holdsRecords), "journal" to Json.of(false)))))
        override suspend fun push(request: Json, token: String) = Reply.Unreachable
        override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
        override suspend fun openLive(token: String) = Reply.Unreachable
    }
    private fun refusingTransport(reply: Reply<SyncResponse>) = object : SyncTransport {
        override suspend fun hello(token: String?) = reply
        override suspend fun push(request: Json, token: String) = Reply.Unreachable
        override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
        override suspend fun openLive(token: String) = Reply.Unreachable
    }
    private suspend fun decision(session: GymEngineSession) = withTimeout(2_000) { while (session.decision == null) delay(5); requireNotNull(session.decision) }
    private fun active(engine: Engine): Json { val s = engine.snapshot(); return s.member("replicas").arr().single { it.member("meta").member("replica") == s.member("active") } }

    private fun transport(server: ModelServer, now: () -> Long) = object : SyncTransport {
        private fun reply(value: works.windmill.sync.modelserver.Reply) = Reply.Answer(SyncResponse(value.status, value.body))
        override suspend fun hello(token: String?) = reply(server.hello(Credential.Account("A"), now()))
        override suspend fun push(request: Json, token: String) = reply(server.push(request, Credential.Account("A"), now()))
        override suspend fun pull(request: Json, token: String?) = reply(server.pull(request, Credential.Account("A"), now()))
        override suspend fun openLive(token: String) = Reply.Unreachable
    }
    private suspend fun signIn(session: GymEngineSession) = coroutineScope {
        val signingIn = async { session.signedIn(User("A", "a@example.com"), "token-A", false) }
        decision(session)
        session.decide(LineageAnswer.add)
        signingIn.await()
    }
    private suspend fun accountWorkout(room: EngineRoomFixture, server: ModelServer) {
        room.select("A")
        room.now += 1_000_000
        room.training.startSession(SessionStart("remote01", room.now - 10_000, joinOpenSession = false))
        room.training.appendSet("remote01", SetWrite("remoteset", "back-squat", 60.0, 5, SetKind.Working, room.now - 9_000))
        room.sync(server)
    }

    @Test fun adoptingAFinishedAnonymousWorkoutPackagesOneAtomicImportWithoutMeetingTheAccountsOpenWorkout() = runBlocking {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), this).use { remote ->
            accountWorkout(remote, server)
            EngineRoomFixture(tmp.newFolder(), this).use { source ->
                source.select(null)
                val workout = source.workout()
                val original = source.training.session(workout.id)!!
                source.now = remote.now
                GymEngineSession(source.engine, SyncRuntime(source.engine, transport(server) { source.now }, Tokens(), "test")).use { session ->
                    session.beforeAccountChange = source.store::prepareEngineTransition
                    signIn(session)
                    source.selected = "A"
                    val workoutIntents = source.outbox().filter { entry ->
                        entry["intent"]?.get("cmd")?.get("args")?.get("id") == Json.of(workout.id) ||
                            entry["intent"]?.get("cmd")?.get("args")?.get("sessionId") == Json.of(workout.id) ||
                            entry["intent"]?.get("d")?.arr().orEmpty().any { it["t"] == Json.of("set") }
                    }
                    assertEquals(1, workoutIntents.size)
                    assertEquals(Gym.Commands.importSession, workoutIntents.single().member("intent").member("cmd").member("name").str())
                    source.sync(server)
                    assertEquals(original.session, source.training.session(workout.id)!!.session)
                    assertEquals(original.sets.map { it.copy(setNumber = 1) }, source.training.session(workout.id)!!.sets)
                    assertTrue(source.training.session("remote01")!!.session.isOpen)
                    assertEquals(listOf("remoteset"), source.training.session("remote01")!!.sets.map { it.id })
                }
            }
        }
    }

    @Test fun anAnonymousOpenWorkoutConflictKeepsItsOriginalContentAndDoesNotJoinTheAccountsWorkout() = runBlocking {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), this).use { remote ->
            accountWorkout(remote, server)
            val directory = tmp.newFolder()
            val snapshot: Json
            val original: SessionDetail
            EngineRoomFixture(directory, this).use { source ->
                source.select(null)
                val workout = source.workout(finish = false)
                original = source.training.session(workout.id)!!
                source.now = remote.now
                GymEngineSession(source.engine, SyncRuntime(source.engine, transport(server) { source.now }, Tokens(), "test")).use { session ->
                    session.beforeAccountChange = source.store::prepareEngineTransition
                    signIn(session); source.selected = "A"
                    source.store.connect(source.account())
                    assertEquals(original.session.id, source.store.session!!.id)
                    source.sync(server)
                    assertEquals(original, source.training.session(workout.id))
                    assertEquals(listOf("remoteset"), source.training.session("remote01")!!.sets.map { it.id })
                    withContext(Dispatchers.IO) { withTimeout(2_000) { source.engine.notices("gym").notices.first { it.isNotEmpty() } } }
                    source.store.refreshEngine()
                    assertEquals("remote01", source.store.session!!.id)
                    assertEquals(listOf("remoteset"), source.store.sets.map { it.id })
                    source.training.dismissRefusals()
                    assertEquals(original, source.training.session(workout.id))
                    snapshot = source.engine.snapshot()
                }
            }
            EngineRoomFixture(directory, this, snapshot).use { restarted ->
                assertEquals(original, restarted.training.session(original.session.id))
                assertTrue(LegacyGymMigration.refusals(restarted.engine).any { it.id == original.session.id })
            }
        }
    }

    @Test fun aRefusedAnonymousFinishedImportStaysInspectableAfterDismissalAndRestart() = runBlocking {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), this).use { remote ->
            accountWorkout(remote, server)
            val directory = tmp.newFolder()
            val snapshot: Json
            val original: SessionDetail
            EngineRoomFixture(directory, this).use { source ->
                source.select(null)
                val workout = source.workout()
                original = source.training.session(workout.id)!!
                source.now = remote.now
                GymEngineSession(source.engine, SyncRuntime(source.engine, transport(server) { source.now }, Tokens(), "test")).use { session ->
                    session.beforeAccountChange = source.store::prepareEngineTransition
                    signIn(session); source.selected = "A"
                    server.refuse(code = Gym.Codes.payloadConflict)
                    source.sync(server)
                    withContext(Dispatchers.IO) { withTimeout(2_000) { source.engine.notices("gym").notices.first { it.isNotEmpty() } } }
                    assertEquals(original, source.training.session(workout.id))
                    source.training.dismissRefusals()
                    assertEquals(original, source.training.session(workout.id))
                    snapshot = source.engine.snapshot()
                }
            }
            EngineRoomFixture(directory, this, snapshot).use { restarted ->
                assertEquals(original, restarted.training.session(original.session.id))
                assertTrue(LegacyGymMigration.refusals(restarted.engine).any { it.id == original.session.id })
            }
        }
    }

    @Test fun addWaitsForThePinnedCountsAndRetainsIdsAndAccountLineage() = runBlocking {
        val engine = Engine.memory(SyncSchema.registry)
        localMovement(engine)
        val anonymous = engine.activeReplica()
        val runtime = SyncRuntime(engine, transport(true), Tokens(), "test")
        val session = GymEngineSession(engine, runtime)
        try {
            val signingIn = async { session.signedIn(User("A", "a@example.com"), "token", false) }
            assertEquals(mapOf("exercise" to 1), decision(session).decisions.single().count)
            assertEquals(anonymous, engine.activeReplica())
            assertFalse(signingIn.isCompleted)
            session.decide(LineageAnswer.add)
            signingIn.await()
            assertEquals("A", active(engine).member("meta").member("account").str())
            assertEquals(listOf("local-movement"), engine.read(gym) { it.drawn("exercise").map { row -> row.id.string } })
            assertTrue(active(engine).member("outbox").arr().all { it.member("lineage") == Json.of("A") })
            assertNull(session.decision)
        } finally { session.close() }
    }

    @Test fun discardSelectsTheAccountAfterRemovingThePinnedSignedOutTraining() = runBlocking {
        val engine = Engine.memory(SyncSchema.registry)
        localMovement(engine)
        val runtime = SyncRuntime(engine, transport(true), Tokens(), "test")
        val session = GymEngineSession(engine, runtime)
        try {
            val signingIn = async { session.signedIn(User("A", "a@example.com"), "token", false) }
            decision(session)
            session.decide(LineageAnswer.discard)
            signingIn.await()
            assertEquals(emptyList<String>(), engine.read(gym) { it.drawn("exercise").map { row -> row.id.string } })
            assertEquals("A", active(engine).member("meta").member("account").str())
        } finally { session.close() }
    }

    @Test fun keepSignOutRetainsUnsentWorkOnlyUnderItsAccount() = runBlocking {
        val engine = Engine.memory(SyncSchema.registry)
        localMovement(engine)
        val tokens = Tokens()
        val runtime = SyncRuntime(engine, transport(false), tokens, "test")
        val session = GymEngineSession(engine, runtime)
        try {
            session.signedIn(User("A", "a@example.com"), "token", false)
            session.signOut()
            assertEquals("anon", active(engine).member("meta").member("state").str())
            assertEquals(listOf(DormantReplica("A", 0, 1, 0)), engine.dormantReplicas())
            assertEquals(emptyList<String>(), engine.read(gym) { it.drawn("exercise").map { row -> row.id.string } })
            assertNull(tokens.token("A"))
        } finally { session.close() }
    }

    @Test fun updateRequiredHelloKeepsAnonymousTrainingWritableWithoutSelectingTheProposedOwner() = runBlocking {
        val engine = Engine.memory(SyncSchema.registry)
        localMovement(engine)
        val anonymous = engine.activeReplica()
        val tokens = Tokens()
        val session = GymEngineSession(engine, SyncRuntime(engine,
            refusingTransport(Reply.Answer(SyncResponse(426, Json.objectOf("minSchema" to Json.of(6))))), tokens, "test"))
        try {
            val failure = runCatching { session.signedIn(User("A", "a@example.com"), "token-A", false) }.exceptionOrNull()
            assertEquals(426, (failure as WindmillApiException.Refused).status)
            assertTrue(engine.status.state.value.upgradeRequired)
            assertEquals(anonymous, engine.activeReplica())
            assertNull(session.decision)
            localMovement(engine, "still-local")
            assertEquals(setOf("local-movement", "still-local"), engine.read(gym) { it.drawn("exercise").map { row -> row.id.string }.toSet() })
        } finally { session.close() }
    }

    @Test fun cancelledAddRetainsAnonymousIdsAndDeletesTheExactPendingCredentialAcrossRestart() = runBlocking {
        val engine = Engine.memory(SyncSchema.registry)
        localMovement(engine)
        val anonymous = engine.activeReplica()
        val tokens = Tokens()
        val session = GymEngineSession(engine, SyncRuntime(engine, transport(true), tokens, "test"))
        val saved: Json
        try {
            val signingIn = async { session.signedIn(User("A", "a@example.com"), "token-A", false) }
            decision(session); session.cancel(); signingIn.join()
            assertTrue(signingIn.isCancelled)
            assertEquals(anonymous, engine.activeReplica())
            assertNull(tokens.token("A"))
            assertNull(engine.snapshot()["meta"]?.get("pendingSignIn"))
            assertEquals(listOf("local-movement"), engine.read(gym) { it.drawn("exercise").map { row -> row.id.string } })
            saved = engine.snapshot()
        } finally { session.close() }
        Engine.memory(SyncSchema.registry, saved).use { restarted ->
            assertEquals(anonymous, restarted.activeReplica())
            assertNull(restarted.snapshot()["meta"]?.get("pendingSignIn"))
            localMovement(restarted, "after-restart")
        }
    }

    @Test fun anOfflinePendingSignInResumesAfterRestartWithTheOriginalAnonymousWork() = runBlocking {
        val tokens = Tokens()
        val engine = Engine.memory(SyncSchema.registry)
        localMovement(engine)
        val first = GymEngineSession(engine, SyncRuntime(engine, refusingTransport(Reply.Unreachable), tokens, "test"))
        val saved: Json
        try {
            assertEquals(WindmillApiException.Offline, runCatching { first.signedIn(User("A", "a@example.com"), "token-A", false) }.exceptionOrNull())
            localMovement(engine, "during-offline")
            saved = engine.snapshot()
        } finally { first.close() }
        val restarted = Engine.memory(SyncSchema.registry, saved)
        val second = GymEngineSession(restarted, SyncRuntime(restarted, transport(true), tokens, "test"))
        try {
            val signingIn = async { second.signedIn(User("A", "a@example.com"), "token-A", true) }
            assertEquals(mapOf("exercise" to 2), decision(second).decisions.single().count)
            second.decide(LineageAnswer.add); signingIn.await()
            assertEquals("A", active(restarted).member("meta").member("account").str())
            assertEquals(setOf("local-movement", "during-offline"), restarted.read(gym) { it.drawn("exercise").map { row -> row.id.string }.toSet() })
        } finally { second.close() }
    }

    @Test fun aProposedDifferentOwnerCannotReplaceAnAlreadyBoundAccountsTokenOrReplica() = runBlocking {
        val engine = Engine.memory(SyncSchema.registry)
        localMovement(engine)
        val tokens = Tokens()
        val session = GymEngineSession(engine, SyncRuntime(engine, transport(false), tokens, "test"))
        try {
            session.signedIn(User("A", "a@example.com"), "token-A", false)
            val bound = engine.activeReplica()
            val failure = runCatching { session.signedIn(User("B", "b@example.com"), "token-B", false) }.exceptionOrNull() as EngineError
            assertEquals(EngineError.Code.signedIn, failure.code)
            assertEquals(bound, engine.activeReplica())
            assertEquals("token-A", tokens.token("A"))
            assertNull(tokens.token("B"))
            assertFalse(session.cancelSignIn(User("B", "b@example.com"), "token-B"))
            assertEquals("token-A", tokens.token("A"))
        } finally { session.close() }
    }
}
