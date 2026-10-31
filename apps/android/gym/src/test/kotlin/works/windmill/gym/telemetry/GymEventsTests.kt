package works.windmill.gym.telemetry

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.EventBatchIn
import works.windmill.platform.telemetry.EventQueue

@OptIn(ExperimentalCoroutinesApi::class)
class GymEventsTests {
    @Test fun coachSetupKeepsBoundedActionsAndDropsDraftAndPhotoMetadata() {
        for (action in listOf("shown", "screenshot", "build_manually", "photo_selected", "photo_removed", "sign_in")) {
            val labels = mapOf("screen" to "coach", "action" to action)
            assertEquals(labels, GymEvents.schemas.properties("gym_setup_step", labels + mapOf(
                "question" to "private", "file_name" to "private", "photo_bytes" to "100", "operation" to "private")))
        }
        assertEquals(mapOf("screen" to "coach"), GymEvents.schemas.properties("gym_setup_step",
            mapOf("screen" to "coach", "action" to "private-draft-text")))
    }

    @Test fun routineFormAndOuterSaveKeepOnlyBoundedOutcomes() {
        val allowed = listOf("open" to "ok", "cancel" to "ok", "stage" to "ok", "stage" to "refused")
            .map { (action, outcome) -> mapOf("screen" to "movement_form", "action" to action, "outcome" to outcome) } +
            listOf("ok", "refused", "failed").map { mapOf("screen" to "routine_editor", "action" to "save", "outcome" to it) }
        val content = mapOf("name" to "private", "targets" to "private", "equipment" to "private", "exercise_id" to "private")
        for (labels in allowed) assertEquals(labels, GymEvents.schemas.properties("gym_action", labels + content))
        for (labels in listOf(
            mapOf("screen" to "movement_form", "action" to "create", "outcome" to "staged"),
            mapOf("screen" to "movement_form", "action" to "stage", "outcome" to "private"),
            mapOf("screen" to "routine_editor", "action" to "save", "outcome" to "staged"),
        )) assertEquals(emptyMap<String, String>(), GymEvents.schemas.properties("gym_action", labels + content))
    }

    @Test fun liveMovementCreationAndInsertionKeepOnlyTheirBoundedOutcomes() {
        for (action in listOf("create", "add")) for (outcome in listOf("ok", "refused", "failed")) {
            val labels = mapOf("screen" to "movement_form", "action" to action, "outcome" to outcome)
            assertEquals(labels, GymEvents.schemas.properties("gym_action", labels + mapOf(
                "name" to "PRIVATE_MOVEMENT", "id" to "PRIVATE_ID", "equipment" to "PRIVATE_EQUIPMENT",
                "weight" to "PRIVATE_WEIGHT", "search" to "PRIVATE_SEARCH")))
        }
    }

    @Test fun deletionActionsKeepOnlyTheirBoundedLabelsAndPreserveNotificationAndTileEvents() {
        val valid = listOf(
            Triple("finish", "discard", "ok"), Triple("finish", "discard", "cancelled"),
            Triple("finish", "discard", "refused"), Triple("finish", "discard", "failed"),
            Triple("finish", "keep", "ok"), Triple("finish", "done", "ok"),
            Triple("session", "discard", "ok"), Triple("log", "discard", "ok"),
            Triple("log", "open_workout", "ok"), Triple("log", "open_bodyweight", "ok"), Triple("log", "open_record", "ok"),
            Triple("log", "share", "ok"), Triple("log", "share", "refused"), Triple("log", "share", "failed"),
            Triple("routines", "delete", "ok"), Triple("session", "delete", "refused"), Triple("notes", "delete", "failed"), Triple("note_editor", "delete", "ok"),
            Triple("note_editor", "delete", "refused"), Triple("note_editor", "delete", "failed"),
            Triple("note_editor", "save", "ok"), Triple("note_editor", "save", "refused"), Triple("note_editor", "save", "failed"),
            Triple("record", "edit", "ok"), Triple("record", "edit", "refused"), Triple("record", "edit", "failed"),
            Triple("workout", "remove", "ok"), Triple("workout", "remove", "refused"), Triple("workout", "reorder", "ok"),
            Triple("workout", "picker_open", "ok"), Triple("workout", "picker_cancel", "ok"),
            Triple("workout", "picker_add", "ok"), Triple("workout", "picker_add", "refused"),
            Triple("workout", "movement_switch", "ok"), Triple("workout", "open_workout", "ok"),
            Triple("workout", "fix", "ok"), Triple("workout", "fix", "refused"), Triple("workout", "fix", "failed"),
            Triple("session", "fix", "ok"), Triple("session", "fix", "refused"), Triple("session", "fix", "failed"),
            Triple("bodyweight", "delete", "held"), Triple("bodyweight", "delete", "closed"),
            Triple("bodyweight", "undo", "ok"), Triple("bodyweight", "undo", "closed"),
            Triple("bodyweight", "cancel", "rewritten"), Triple("bodyweight", "calendar_open", "ok"),
            Triple("bodyweight", "calendar_confirm", "ok"), Triple("bodyweight", "calendar_cancel", "ok"), Triple("notification", "log_set", "ok"),
            Triple("notification", "open", "refused"), Triple("tile", "open", "ok"), Triple("tile", "routines", "failed"),
        )
        for ((screen, action, outcome) in valid) {
            val labels = mapOf("screen" to screen, "action" to action, "outcome" to outcome, "platform" to "android")
            assertEquals(labels, GymEvents.schemas.properties("gym_action", labels + mapOf(
                "date" to "2026-09-01", "weight" to "81.25", "name" to "private", "operation" to "private")))
        }
        for (screen in listOf("finish", "session", "log")) {
            val shown = mapOf("screen" to screen, "action" to "discard", "state" to "shown")
            assertEquals(shown, GymEvents.schemas.properties("gym_action", shown + mapOf("request_id" to "private", "question" to "private")))
        }
        for (labels in listOf(
            mapOf("screen" to "private", "action" to "delete", "outcome" to "ok"),
            mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "acknowledged"),
            mapOf("screen" to "bodyweight", "action" to "undo", "outcome" to "private"),
            mapOf("screen" to "notes", "action" to "private", "outcome" to "ok"),
            mapOf("screen" to "record", "action" to "edit", "outcome" to "private"),
            mapOf("screen" to "record", "action" to "delete", "outcome" to "ok"),
        )) assertEquals(emptyMap<String, String>(), GymEvents.schemas.properties("gym_action", labels))
    }

    @Test fun workoutVisibilityActionsRetainOnlyTheirBoundedSteps() {
        val common = mapOf("platform" to "android", "app_version" to "test", "build" to "123",
            "release" to "android-test", "environment" to "verification")
        val content = mapOf("workout" to "private", "routine" to "private", "elapsed_ms" to "123",
            "load" to "47.5", "request_id" to "private", "question" to "private", "operation" to "private",
            "status" to "private", "duration_ms" to "123", "state" to "shown")
        val doors = listOf("workout" to "hide", "workout" to "show_notification", "workout_bar" to "open")
        for ((screen, action) in doors) {
            for (outcome in listOf("ok", "refused")) {
                val expected = common + mapOf("screen" to screen, "action" to action, "outcome" to outcome)
                assertEquals(expected, GymEvents.schemas.properties("gym_action", expected + content))
            }
            for (outcome in listOf("failed", "cancelled", "private")) {
                assertEquals(common, GymEvents.schemas.properties("gym_action",
                    common + content + mapOf("screen" to screen, "action" to action, "outcome" to outcome)))
            }
        }
        for ((screen, action) in listOf("workout_bar" to "hide", "notification" to "show_notification",
            "coach" to "hide", "workout" to "private")) {
            assertEquals(common, GymEvents.schemas.properties("gym_action",
                common + content + mapOf("screen" to screen, "action" to action, "outcome" to "ok")))
        }
    }

    @Test fun coachArchiveActionsAndDeletionDialogRejectContentAndUnboundedLabels() {
        val steps = listOf("fresh_entry", "history_open", "draft_restored", "reply_open", "read_sources", "copy", "jump_latest", "choose", "continue_draft")
        val allowed = steps.map { mapOf("screen" to "coach", "action" to it, "outcome" to "ok") } +
            listOf(mapOf("screen" to "coach", "action" to "copy", "outcome" to "failed")) +
            listOf("available", "bound", "unavailable").map { mapOf("screen" to "coach", "action" to "access", "outcome" to it) } +
            listOf("ok", "refused", "failed", "cancelled").map { mapOf("screen" to "threads", "action" to "delete", "outcome" to it) } +
            listOf(mapOf("screen" to "threads", "action" to "delete", "state" to "shown"))
        val content = mapOf("chat_id" to "private", "question" to "private", "photo" to "private",
            "chip_label" to "private", "draft_text" to "private", "answerPreview" to "private", "operation" to "private", "status" to "private")
        allowed.forEach { properties ->
            assertEquals(properties, GymEvents.schemas.properties("gym_action", properties + content))
        }
        for (properties in listOf(
            mapOf("screen" to "coach", "action" to "private", "outcome" to "ok"),
            mapOf("screen" to "coach", "action" to "history_open", "outcome" to "private"),
            mapOf("screen" to "coach", "action" to "access", "outcome" to "private"),
            mapOf("screen" to "threads", "action" to "delete", "state" to "private"),
            mapOf("screen" to "private", "action" to "delete", "state" to "shown"),
        )) assertEquals(emptyMap<String, String>(), GymEvents.schemas.properties("gym_action", properties + content))
    }

    @Test fun signOutEventsContainOnlyTheFiniteChoiceAndOutcomeLabels() {
        for (action in listOf("keep", "discard", "cancel")) for (outcome in listOf("completed", "failed")) {
            assertEquals(mapOf("action" to action, "outcome" to outcome),
                GymEvents.schemas.properties("gym_sign_out", mapOf("action" to action, "outcome" to outcome,
                    "account" to "private-account", "email" to "lifter@example.com", "secret" to "private-secret", "unsent" to "3")))
        }
        assertEquals(mapOf("state" to "shown"), GymEvents.schemas.properties("gym_sign_out", mapOf("state" to "shown")))
        assertEquals(emptyMap<String, String>(), GymEvents.schemas.properties("gym_sign_out",
            mapOf("state" to "private-account", "action" to "private-secret", "outcome" to "private-content")))
    }

    @Test fun coachImportEventsAcceptOnlyTheirFiniteOutcomes() {
        assertEquals(mapOf("outcome" to "committed"), GymEvents.schemas.properties("gym_coach_import",
            mapOf("outcome" to "committed", "recordId" to "private-record", "fingerprint" to "private-fingerprint")))
        assertEquals(emptyMap<String, String>(), GymEvents.schemas.properties("gym_coach_import", mapOf("outcome" to "private-credential")))
    }

    @Test
    fun onboardingEventsRetainOnlyTheirFiniteSchemaAndReachTheQueueSender() = runTest {
        var disk: String? = null
        val sent = mutableListOf<EventBatchIn>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, bearer ->
            assertNull(bearer)
            sent += batch
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope, now = { 123L }, schemas = GymEvents.schemas)
        val metadata = mapOf(
            "platform" to "android", "app_version" to "0.1", "build" to "123",
            "release" to "android-test", "environment" to "verification",
        )
        val valid = linkedMapOf(
            "onboarding_opened" to mapOf("state" to "first_launch"),
            "onboarding_page_viewed" to mapOf("state" to "replay", "screen" to "windmill"),
            "onboarding_action" to mapOf("state" to "first_launch", "screen" to "roadmap", "action" to "swipe"),
            "onboarding_exited" to mapOf("state" to "replay", "screen" to "gym", "outcome" to "completed"),
        )
        for ((name, properties) in valid) {
            queue.add(name, mapOf(
                "state" to "private_state", "screen" to "private_workout", "action" to "private_action",
                "outcome" to "private_outcome", "storage" to "private_storage", "operation" to "private_operation",
                "route" to "/private_workout", "question" to "private_question", "duration_ms" to "100",
            ) + properties + metadata)
        }
        runCurrent()
        assertEquals(1, sent.size)
        assertEquals(valid.keys.toList(), sent.single().events.map { it.name })
        assertEquals(valid.values.map { props -> (props + metadata).mapValues { JsonPrimitive(it.value) } },
            sent.single().events.map { it.props })
        assertTrue(sent.single().events.all { it.clientMs == 123L })
        assertFalse(WindmillJson.encodeToString(EventBatchIn.serializer(), sent.single()).contains("private"))
        assertTrue(disk!!.contains("\"events\":[]"))
    }

    @Test
    fun onboardingNamesAreExactAndAllPropertyEnumsAreFinite() = runTest {
        var disk: String? = null
        val failures = mutableListOf<String>()
        val sent = mutableListOf<EventBatchIn>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, _ ->
            sent += batch
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope, schemas = GymEvents.schemas)
        val originalDisk = disk
        for (name in listOf("onboarding_custom", "onboarding_opened_private", "ONBOARDING_OPENED", "onboarding_")) {
            queue.add(name, mapOf("state" to "first_launch"))
        }
        runCurrent()
        assertEquals(List(4) { "telemetry_event_name" }, failures)
        assertEquals(originalDisk, disk)
        assertTrue(sent.isEmpty())

        for (state in listOf("first_launch", "replay")) {
            queue.add("onboarding_opened", mapOf("state" to state))
            for (screen in listOf("windmill", "roadmap", "journal", "gym")) {
                queue.add("onboarding_page_viewed", mapOf("state" to state, "screen" to screen))
                for (action in listOf("next", "back", "swipe", "adjust")) {
                    queue.add("onboarding_action", mapOf("state" to state, "screen" to screen, "action" to action))
                }
                for (outcome in listOf("skipped", "completed", "back", "closed")) {
                    queue.add("onboarding_exited", mapOf("state" to state, "screen" to screen, "outcome" to outcome))
                }
            }
        }
        queue.add("onboarding_action", mapOf("state" to "private_state", "screen" to "private_screen", "action" to "private_action"))
        queue.add("onboarding_exited", mapOf("state" to "private_state", "screen" to "private_screen", "outcome" to "private_outcome"))
        runCurrent()
        val events = sent.flatMap { it.events }
        assertEquals(76, events.size)
        assertEquals(74, events.count { it.props.isNotEmpty() })
        assertEquals(listOf(emptyMap<String, JsonPrimitive>(), emptyMap()), events.takeLast(2).map { it.props })
        assertFalse(WindmillJson.encodeToString(EventBatchIn.serializer(), sent.last()).contains("private"))
    }
}
