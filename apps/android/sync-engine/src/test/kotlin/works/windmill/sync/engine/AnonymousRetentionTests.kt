package works.windmill.sync.engine

import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.*

class AnonymousRetentionTests {
    @Test fun aRetainedAnonymousReplicaSurvivesPendingSignInRestartAndTheNextAdoptionCanTakeIt() = runBlocking {
        val registry = Registry(Json.parse(File(System.getProperty("windmill.contract"), "sync/probe.registry.json").readBytes()))
        val clock = object : EngineClock { override fun now() = 5000L }
        val tokens = object : SessionTokens {
            val values = mutableMapOf<String, String>()
            override fun token(account: String) = values[account]
            override fun save(account: String, token: String) { values[account] = token }
            override fun delete(account: String) { values.remove(account) }
            override fun accounts() = values.keys.toSet()
        }
        var reachable = false
        val transport = object : SyncTransport {
            override suspend fun hello(token: String?): Reply<SyncResponse> {
                if (!reachable) return Reply.Unreachable
                return Reply.Answer(SyncResponse(200, Json.objectOf("serverTime" to Json.of(clock.now()), "epoch" to Json.of("epoch"),
                    "schema" to Json.of(registry.version), "minSchema" to Json.of(registry.minVersion),
                    "as" to Json.of("A"), "holdsRecords" to Json.objectOf("probe" to Json.of(true)))))
            }
            override suspend fun push(request: Json, token: String) = Reply.Unreachable
            override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
            override suspend fun openLive(token: String) = Reply.Unreachable
        }
        val scope = ScopeRef.product("probe")
        val pending: Json
        val anonymous: Json
        Engine.memory(registry, clock = clock).use { engine ->
            engine.commit(scope, Gesture(listOf(Change.create("card", NewID.Given(RecordID("local")), mapOf("title" to Json.of("Local"))))))
            anonymous = engine.snapshot().member("replicas").arr().single()
            SyncRuntime(engine, transport, tokens, "test", activityAllowed = { false }).use { runtime ->
                val failure = runCatching { runtime.signIn("A", "token", retainAnonymous = true) }.exceptionOrNull()
                assertEquals(EngineError.Code.unreachable, (failure as EngineError).code)
                pending = engine.snapshot()
                assertEquals(anonymous, pending.member("replicas").arr().single())
            }
        }
        reachable = true
        Engine.memory(registry, pending, clock = clock).use { engine ->
            SyncRuntime(engine, transport, tokens, "test", activityAllowed = { false }).use { runtime ->
                assertTrue(requireNotNull(runtime.resumeSignIn()).isComplete)
                val retained = engine.snapshot().member("replicas").arr().single { it.member("meta")["state"] == Json.of("anon") }
                assertEquals(Json.Obj((anonymous.obj() - "meta").toList()), Json.Obj((retained.obj() - "meta").toList()))
                assertNull(engine.snapshot().member("replicas").arr().single { it.member("meta")["state"] == Json.of("bound") }["outbox"])
                engine.signOut("keep")
                assertEquals(anonymous.member("meta").member("replica").str(), engine.activeReplica())
                val adoption = runtime.signIn("A", "token")
                assertFalse(adoption.isComplete)
                adoption.complete(mapOf("probe" to LineageAnswer.add))
                assertEquals(Json.of("Local"), engine.read(scope) { it.drawn("card", RecordID("local"))?.values?.get("title") })
            }
        }
    }
}
