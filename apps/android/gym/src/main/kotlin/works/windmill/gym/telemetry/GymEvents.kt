package works.windmill.gym.telemetry

import works.windmill.platform.telemetry.EventSchema
import works.windmill.platform.telemetry.EventSchemas
import works.windmill.platform.telemetry.LabelSchema

// gym_action: each screen's actions with the outcomes each may report. An action that asks first also reports
// state=shown, without an outcome, when its question opens.
object GymActions : EventSchema {
    val screens: Map<String, Map<String, Set<String>>> = mapOf(
        "routines" to mapOf("delete" to setOf("ok", "refused", "failed")),
        "notes" to mapOf("delete" to setOf("ok", "refused", "failed")),
        "log" to mapOf(
            "discard" to setOf("ok", "cancelled", "refused", "failed"),
            "open_workout" to setOf("ok"), "open_bodyweight" to setOf("ok"), "open_record" to setOf("ok"),
            "share" to setOf("ok", "refused", "failed"),
            "retry" to setOf("requested", "refused", "ok", "failed"),
        ),
        "finish" to mapOf("discard" to setOf("ok", "cancelled", "refused", "failed"), "keep" to setOf("ok"), "done" to setOf("ok")),
        "session" to mapOf(
            "discard" to setOf("ok", "cancelled", "refused", "failed"),
            "delete" to setOf("ok", "refused", "failed"),
            "fix" to setOf("ok", "refused", "failed"),
            "share" to setOf("ok", "failed"),
        ),
        "note_editor" to mapOf("delete" to setOf("ok", "refused", "failed"), "save" to setOf("ok", "refused", "failed")),
        "record" to mapOf("edit" to setOf("ok", "refused", "failed")),
        "routine_editor" to mapOf("save" to setOf("ok", "refused", "failed"), "discard" to setOf("ok", "cancelled")),
        "movement_form" to mapOf(
            "open" to setOf("ok"), "stage" to setOf("ok", "refused"), "cancel" to setOf("ok"),
            "discard" to setOf("ok", "cancelled"),
            "create" to setOf("ok", "refused", "failed"), "add" to setOf("ok", "refused", "failed"),
        ),
        "bodyweight" to mapOf(
            "delete" to setOf("held", "closed", "refused", "failed"),
            "undo" to setOf("ok", "closed", "failed"),
            "cancel" to setOf("rewritten"),
            "calendar_open" to setOf("ok"), "calendar_confirm" to setOf("ok"), "calendar_cancel" to setOf("ok"),
        ),
        "coach" to listOf("fresh_entry", "history_open", "draft_restored", "reply_open", "read_sources", "choose", "continue_draft", "jump_latest")
            .associateWith { setOf("ok") } + mapOf("copy" to setOf("ok", "failed"), "access" to setOf("available", "bound", "unavailable")),
        "threads" to mapOf("delete" to setOf("ok", "refused", "failed", "cancelled")),
        "notification" to mapOf("open" to setOf("ok", "refused"), "log_set" to setOf("ok", "refused")),
        "workout_bar" to mapOf("open" to setOf("ok", "refused")),
        "workout" to mapOf(
            "hide" to setOf("ok", "refused"), "show_notification" to setOf("ok", "refused"),
            "movement_switch" to setOf("ok"), "open_workout" to setOf("ok"),
            "remove" to setOf("ok", "refused"), "reorder" to setOf("ok"),
            "picker_open" to setOf("ok"), "picker_cancel" to setOf("ok"), "picker_add" to setOf("ok", "refused"),
            "fix" to setOf("ok", "refused", "failed"),
        ),
        "tile" to mapOf("open" to setOf("ok", "failed"), "routines" to setOf("ok", "failed")),
    )
    val asking: Map<String, Set<String>> = mapOf(
        "threads" to setOf("delete"), "finish" to setOf("discard"), "session" to setOf("discard"), "log" to setOf("discard"),
        "routine_editor" to setOf("discard"), "movement_form" to setOf("discard"),
    )

    override fun allowedKeys(properties: Map<String, String>): Set<String> {
        val screen = properties["screen"]
        val action = properties["action"]
        if (properties["state"] == "shown" && properties["outcome"] == null && action in asking[screen].orEmpty())
            return setOf("screen", "action", "state")
        if (properties["outcome"] in screens[screen]?.get(action).orEmpty()) return setOf("screen", "action", "outcome")
        return emptySet()
    }
}

// Every gym event with a schema. The onboarding pager owns the onboarding_ prefix: an unregistered onboarding name is refused.
object GymEvents {
    private val onboardingStates = setOf("first_launch", "replay")
    private val onboardingScreens = setOf("windmill", "roadmap", "journal", "gym")

    val schemas = EventSchemas(
        mapOf(
            "gym_action" to GymActions,
            "gym_setup_step" to LabelSchema(mapOf(
                "screen" to setOf("coach"),
                "action" to setOf("shown", "screenshot", "build_manually", "photo_selected", "photo_removed", "sign_in"),
            )),
            "gym_coach_import" to LabelSchema(mapOf("outcome" to setOf("started", "committed", "replayed", "refused", "failed"))),
            "gym_sign_out" to LabelSchema(mapOf(
                "state" to setOf("shown"), "action" to setOf("keep", "discard", "cancel"), "outcome" to setOf("completed", "failed"),
            )),
            "onboarding_opened" to LabelSchema(mapOf("state" to onboardingStates)),
            "onboarding_page_viewed" to LabelSchema(mapOf("state" to onboardingStates, "screen" to onboardingScreens)),
            "onboarding_action" to LabelSchema(mapOf(
                "state" to onboardingStates, "screen" to onboardingScreens, "action" to setOf("next", "back", "swipe", "adjust"),
            )),
            "onboarding_exited" to LabelSchema(mapOf(
                "state" to onboardingStates, "screen" to onboardingScreens, "outcome" to setOf("skipped", "completed", "back", "closed"),
            )),
        ),
        reservedPrefixes = setOf("onboarding_"),
    )
}
