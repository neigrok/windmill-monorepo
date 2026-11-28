import Foundation
import Sentry
import SyncCore
import SyncEngine
import SyncReplica
import SyncSchema
import Synchronization

nonisolated struct TelemetryMetadata: Sendable {
  let version: String
  let build: String
  let release: String
  let environment: String

  init(info: [String: Any]) {
    func label(_ key: String, fallback: String) -> String {
      guard let value = info[key] as? String, !value.isEmpty, value.count <= 96,
            value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }) else { return fallback }
      return value
    }
    version = label("CFBundleShortVersionString", fallback: "0")
    build = label("CFBundleVersion", fallback: "0")
    release = "ios-\(version)-\(label("WMSourceRevision", fallback: "local"))"
    let configured = label("WMTelemetryEnvironment", fallback: "development")
    environment = ["production", "development", "test"].contains(configured) ? configured : "development"
  }

  var properties: [String: EventValue] {
    ["platform": .label("ios"), "version": .label(version), "build": .label(build),
     "release": .label(release), "environment": .label(environment)]
  }
}

// The room's telemetry port under a name of its own, for the files that also see the Coach engine's `Telemetry`.
typealias EventTelemetry = Telemetry

nonisolated enum TelemetryPrivacy {
  static let events: Set<String> = [
    "app_started", "app_foregrounded", "app_backgrounded", "auth_restore", "auth_code_requested",
    "auth_code_sent", "auth_sign_in_started", "auth_signed_in", "auth_signed_out",
    "first_run_screen_viewed", "first_run_choice",
    "journal_line_saved", "journal_save_refused", "journal_echo_shown", "journal_echo_opened", "journal_echo_dismissed", "journal_echo_useful",
    "journal_echo_ink", "journal_echo_reader_opened", "journal_echo_intro_dismissed",
    "sync_pull_outcome", "sync_push_outcome", "sync_inverse", "api_request_failed", "client_error",
    "onboarding_screen_viewed", "onboarding_skipped", "onboarding_finished", "onboarding_replayed", "room_switched", "room_adoption_answered", "gym_screen_viewed", "gym_action",
    "gym_activity_set_logged", "gym_activity_offer_refused", "gym_session_started", "gym_session_finished", "gym_set_logged", "gym_routine_saved",
    "gym_workout_adjusted", "gym_exercise_updated", "gym_setup_step", "gym_ask_started", "gym_ask_outcome", "coach_turn", "coach_ability", "gym_proposal_outcome", "gym_connect_tool", "gym_import_recovery",
    "gym_workout_picker", "gym_rest_target_reached", "gym_workout_plan_changed", "gym_receipt_plan_saved", "gym_workout_load_typed",
    "gym_moment_opened", "gym_hidden_workout", "client_update_required", "appearance_chosen",
    "gym_intent_opened", "quick_action", "sign_in_restore", "account_delete", "roadmap_room_opened",
    "roadmap_board_complete", "roadmap_board_delete", "roadmap_board_undo", "roadmap_write_refused",
    "roadmap_board_step_open", "roadmap_board_step_action", "roadmap_sheet", "birth", "roadmap_board_create", "roadmap_deletion",
    "roadmap_step_edit", "roadmap_board_edit", "roadmap_view_switch", "roadmap_graph_select", "roadmap_whats_next", "roadmap_graph_fit",
    "roadmap_board_workspace", "roadmap_board_menu", "roadmap_board_sort", "roadmap_board_filter", "roadmap_board_clear",
    "roadmap_board_branch", "roadmap_board_search", "roadmap_board_select", "roadmap_board_bulk", "roadmap_kinds", "roadmap_activity",
    "roadmap_first_read", "roadmap_guide", "roadmap_link_opened", "roadmap_cover", "fork_attempt", "fork_claim",
    "roadmap_tree_open", "roadmap_tree_back", "roadmap_subtree_open", "roadmap_subtree_back", "roadmap_tree_attach",
    "roadmap_landing", "roadmap_write_cannot_land", "roadmap_kept", "roadmap_verb", "roadmap_export", "roadmap_gallery",
    "roadmap_coach_opened", "roadmap_coach_ask_refused", "roadmap_coach_turn", "roadmap_coach_ability", "roadmap_coach_stopped", "roadmap_coach_write_undone"
  ]
  static let labels: [String: Set<String>] = [
    "room": ["journal", "gym", "roadmap"],
    "page": ["windmill", "roadmap", "journal", "gym"],
    "presentation": ["first_launch", "replay"],
    "screen": ["routine", "routine_editor", "edit_sets", "routine_movement_editor", "receipt", "routine_targets", "routine_movement", "movement", "session", "fix_set", "record", "bodyweight", "weigh_in", "session_share", "history", "notes", "note", "review", "connected_log", "connected_log_guide", "sources", "gym", "routines", "log", "on_this_phone", "coach", "workout", "welcome", "journal", "ink_notes", "keep", "address", "code", "you", "adoption", "discard_adoption", "23a", "23b", "23c", "24c", "24d", "apple_no_account", "apple_expired", "auth_pending", "room_sign_in"],
    "field": ["weight", "reps"],
    "action": ["rename", "equipment", "drafts_rejected", "save_routines", "sign_in", "shown", "screenshot", "describe", "goal", "just_log", "build_manually", "open_routine", "routines_saved", "keep_routines", "photo_selected", "photo_removed", "create", "update", "share", "apply", "reject", "open_gym", "open_journal", "open_roadmap", "dismiss_ink", "write", "done_writing", "keep", "close", "email", "back", "change_email", "resend", "add", "discard", "cancel", "sign_out", "use_account", "create_account", "remove_apple", "retry", "inspect", "fix", "open", "connect", "manage", "hide", "select", "menu", "stage", "new_chat", "view_answer", "open_conversation", "delete_conversation", "retarget", "add_set", "remove_set", "swap", "add_movement", "remove_movement", "rest", "land", "complete", "reset", "delete", "editNote",
               "subtaskAdd", "subtaskToggle", "subtaskDelete", "linkOpen", "linkCancel", "linkAdd", "linkDelete", "noteSave", "undo",
               "openInGraph", "viewBranch", "clear", "copyLink"],
    "outcome": ["available", "empty", "signed_out", "unauthenticated", "busy", "answered", "capped", "fresh", "absent", "offline", "stalled", "decided", "refused", "ok", "completed", "failed", "cancelled", "signed_in", "paused", "anonymous", "linked", "started", "saved", "not-offered", "seat-required", "invalid-input", "invalid-arguments", "load-floor", "result-too-large", "coach-turn-volume", "pending", "unavailable", "settled", "released", "adopted", "read", "left", "cleared", "own", "readable", "unreadable", "copied", "roadmap-unavailable", "unknown-roadmap", "roadmap-not-ready", "not-owner", "out-of-scope", "over-limit", "unknown-step", "closes-cycle", "takes-every-start", "unknown-kind", "address-not-allowed", "opens-roadmap", "step-locked", "hue-taken", "roadmap-changed", "no-change", "product-refused", "stopped", "one-proposal", "undone", "skipped"],
    "reason": ["invalid", "too_large", "claim_conflict", "session-open", "session-overlap", "id-taken", "bad-instant", "too-many-sets", "invalid-set", "unknown-exercise", "session-finished", "unsent", "other", "last_root", "closed", "forked", "copy_late", "replaced", "refused", "device", "empty", "denied", "roadmapDeleted", "capFilled", "accessEnded", "noteTooLong", "offline", "allowanceUsed", "capacityUsed", "busy", "signIn", "update", "switchedOff", "didNotAnswer"],
    "cap": ["daily", "ceiling", "allowance"],
    "state": ["shown", "opened", "completed", "declined", "failed", "stopped", "interrupted"],
    "seat": ["anon", "bound"],
    // Roadmap Coach (roadmap-coach.md §13): where a person opened it, whether a turn's answer was cut at its output cap, and
    // the ability an Undo of a direct write took back.
    "entry": ["foot", "step", "row", "sheet"],
    "truncated": ["true", "false"],
    "ability": ["set_progress", "update_node", "create_node", "connect"],
    "target": ["workout", "routine", "none", "roadmap", "step"],
    "name": ["list_routines", "list_exercises", "list_sessions", "get_session", "get_sessions", "last_time", "get_last_times", "get_stats", "get_record", "list_notes", "list_bodyweight", "get_preferences", "create_routine", "create_exercise", "save_note", "share_session", "share_log", "propose_routine_change", "propose_routine_removal", "propose_workout_change", "revoke_share", "true", "false", "get_tree", "get_nodes", "find_nodes", "get_progress", "get_diagnostics", "list_trees", "set_progress", "update_node", "create_node", "connect", "propose_roadmap_change", "unoffered"],
    "code": Set(["subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted", "debt_outstanding", "device_bound", "invalid_installation", "coach-bad-request", "coach-update-required", "coach-turn-conflict", "coach-turn-unknown", "coach-turn-order", "coach-turn-volume", "coach-rate-limited", "coach-busy", "coach-vendor-error", "coach-stream-replaced", "coach-replica-syncing", "transport", "decode", "storage", "refusal", "other", "unauthenticated", "invalid_network", "busy", "paused", "rate_limited", "provider_unavailable", "provider_failed", "provider_rejected", "accounting_unavailable", "result_gone", "call_unknown", "conflict", "funding_required", "invalid_request", "too_large", "picture_gone", "pass_expired", "pass_missing", "pass_signature", "pass_audience", "pass_malformed", "client-update-required", "anonymous_ai_unavailable", "not-found", "offline", "invalid-answer", "answer-timeout", "model-call-limit", "unavailable", "roadmap-unavailable", "unknown-roadmap", "roadmap-not-ready", "not-owner", "out-of-scope", "over-limit", "unknown-step", "closes-cycle", "takes-every-start", "unknown-kind", "address-not-allowed", "opens-roadmap", "step-locked", "hue-taken", "roadmap-changed", "no-change", "product-refused", "stopped", "one-proposal", "not-offered", "invalid-input", "seat-required"])
      // A notice's refusal code: the engine's, and each product's its registry declares.
      .union(RefusalCode.engine.map(\.text)).union(SyncSchema.registry.products.flatMap(\.codes).map(\.text)),
    "surface": ["activity", "control", "shortcut", "document", "board", "history"],
    "intent": ["start_workout", "open_workout"],
    "item": ["write", "start", "open_workout", "weigh_in", "bodyweight", "date", "movement", "targets", "routine"],
    "stage": ["started", "room_opened", "complete"],
    "trigger": ["sync", "sign_in"],
    "door": ["accessory", "row", "tab", "history", "handoff", "new_chat", "workout", "swipe", "menu", "page", "card", "step", "list", "empty", "blank", "foot", "form", "graph", "find", "tool", "bulk", "activity", "link", "import", "file", "paste", "band", "more", "gallery"],
    // The Roadmap room, in the web's vocabulary: the act a Board event tells of, the step of a delete, of the roadmaps'
    // switcher, of a new roadmap or of the step form, the view a step's delete was made on, the group a step stands in
    // when its page opens or its form makes it, whether a step of another roadmap opens the one deleted, the write a
    // refusal or a failure names, and the refusal's kind. A step's page is the web's document, and its acts are the three
    // actions above. A saved edit says of each part of the step whether it changed: `name` above, and the five below.
    // Of the Graph: the view the switch chose or a roadmap opened on, with the roadmap's size as a bucket where the
    // Graph comes up, *Next*'s menu opened and a step picked from it with the steps Up next as a bucket, Fit shown and
    // left, and under a missed budget which one and the roadmap's size as a bucket.
    // Of a step's workspace: the act, among the actions above in the web's words, and the act its Undo took back.
    // Of the Board's query, its selection and the Kinds sheet: the menu opened, the order chosen, what a Clear cleared and
    // where, the way a selection ended, the edit a kind's change made, and the kinds shown as a bucket under `count`.
    // Of Activity and a step's History: what their read came to as they opened, rows or none, and a fold opened; of the
    // room's first read, its spinner shown and how its wait ended. Of the Guide: whether guides from above apply as it
    // opens, how a draft began, a saved guide's length as a bucket, a draft gone past its limit, a save that wrote over a
    // guide written elsewhere, and why a save was not written: refused by the domain, or failed on the device.
    // Of a plan: New Roadmap's door, a copied plan or a file, as it was read back, cleared or could not be read, and the
    // roadmap made with its steps as a bucket under `count`; Paste Steps read back, added with its steps as a bucket,
    // refused with the domain's refusal, cancelled, undone, or reading nothing for an empty clipboard or a paste not
    // allowed, and Settings opened from that band. Of a step that opens a roadmap: attached, changed or detached, and the
    // attach list opened, a link pasted into it and a roadmap forked first.
    "act": ["complete", "reset", "delete", "create", "edit", "subtaskToggle", "subtaskDelete", "linkDelete", "recolor", "removeKind", "guide", "graft",
            "attach", "change", "detach"],
    "step": ["confirm", "cancel", "held", "ask", "undo", "open", "switch", "search", "new", "rename", "saved", "discard", "pick", "close",
             "start", "end", "recolor", "delete", "delete_refused", "kind", "unfold", "shown", "ended", "edit", "save", "tooLong", "conflict",
             "read", "clear", "unread", "settings", "refused", "paste", "fork", "attach", "change", "detach", "copy", "discardAll",
             "publish", "private", "link", "sign_in", "load", "page", "retry", "row"],
    "menu": ["sortFilter"],
    "sort": ["roadmap", "newest", "oldest"],
    "what": ["kinds"],
    "from": ["row", "empty"],
    "via": ["done", "act", "edit", "add"],
    "read": ["loaded", "empty", "missing", "offline", "seeds", "failed"],
    "above": ["none", "some"],
    "length": ["0", "1-500", "501-2000", "2001-4500", "4501-5000"],
    // A roadmap's link and a shared roadmap's cover: the claimed form the address came in, whether the roadmap it named was
    // the person's own, and Fork's two ways, the web's instant one on a roadmap's own screen and browse on a gallery row;
    // a failed fork's request names its door, cover, attach or browse.
    // Share, Export and the gallery (§7.3, §7.4): the verb Share's steps are told under, each step of the sheet, a page of
    // the gallery read with what it came to, and Export's door, the root's title menu or a roadmap gone into's … menu,
    // with whether the file was saved.
    "address": ["share", "app"],
    "mine": ["true", "false"],
    "mode": ["instant", "browse", "cover", "attach"],
    "verb": ["share"],
    "legend": ["add", "rename", "describe", "recolor", "remove"],
    "count": ["0", "1", "2-5", "6-20", "21+"],
    "view": ["board", "graph"],
    "column": ["locked", "upNext", "done"],
    "openers": ["none", "some"],
    "description": ["true", "false"],
    "kind": ["true", "false"],
    "prerequisites": ["true", "false"],
    "opens": ["true", "false"],
    "links": ["true", "false"],
    "roadmap": ["true", "false"],
    // Of a step that opens a roadmap: who went into a subtree, and whether a Done mark was set aside or came back.
    "role": ["owner", "reader"],
    "mark": ["kept", "none"],
    "budget": ["first_frame", "frames"],
    // What the room tells once of a change that met one made elsewhere (§6): the rule that told it, a step that now
    // follows something else or one brought back, and where it was told, the band or the step's page. The reason a change
    // set aside could not land is under `reason` above, a Copy that reached the pasteboard under `outcome`, and the code
    // of a notice no rule lists under `code`.
    "rule": ["follows", "cameBack"],
    "place": ["band", "step"],
    "steps": ["1-100", "101-1000", "1001-5000", "5001-10000"],
    "write": ["mark", "DeleteNode", "undo", "release", "createRoadmap", "title", "deleteRoadmap", "CreateNode", "EditNode", "workspace", "note",
              "BulkRecolor", "BulkDelete", "AddKind", "RenameKind", "DescribeKind", "RecolorKind", "RemoveKind", "guide", "ImportSubgraph", "pointer", "clearLanding", "dismissNotice",
              "visibility", "coachUndo", "coachDelete"],
    "refusal": ["invalid", "gone", "taken", "tooLarge", "full", "roadmapGone", "unreachable", "notARoot", "stepOpensARoadmap", "depthLimit", "other", "startingStep", "noName", "loop"],
    "appearance": ["light", "dark", "system"],
    "method": ["GET", "POST", "PUT", "DELETE", "email", "apple"],
    "day_kind": ["today"],
    "scope_kind": ["product", "tree", "overlay", "unknown"],
    // A file New Roadmap could not read, or Export could not write: its error's domain, and its code as a bucket.
    "error_domain": ["cocoa", "posix", "other"],
    "error_code": ["missing", "permission", "space", "unreadable", "cancelled", "other"],
    // Why an Undo of an act skipped operations when it settled (`sync_inverse`): the engine's closed list, never a code
    // beyond it.
    "skip_reason": Set(InverseSkipReason.allCases.map(\.rawValue)),
    "route": ["/v1/ai", "/v1/auth", "/v1/me", "/v1/sync", "/v1/events", "/v1/gym", "/v1/journal", "/v1/trees", "/v1/gallery"],
    "failure_kind": ["offline", "timeout", "transport", "http", "decode", "encode", "storage", "refusal", "keychain", "flush", "unexpected", "admission", "digest_reset", "doubt_exhausted", "overflow", "rejected", "tls", "sqlite", "digest_mismatch", "malformed", "unexpected_admission", "backoff_exhausted", "fallback", "unseated", "budget", "marks", "host", "wire"],
    "operation": ["ai_installation", "gym_coach_turn", "gym_activity_request", "gym_activity_update", "gym_control_update", "gym_read", "gym_action", "gym_flush", "gym_rest", "gym_import_fix", "gym_import_keep", "gym_import_retry", "gym_import_discard", "auth_request_code", "auth_verify_code", "auth_apple", "auth_apple_create", "auth_methods", "auth_apple_remove", "auth_logout", "auth_restore", "app_open", "journal_read", "journal_save", "journal_draft", "journal_choice", "journal_echoes", "roadmap_read", "roadmap_write", "roadmap_layout", "roadmap_canvas", "roadmap_progress", "roadmap_fork", "roadmap_gallery", "roadmap_export", "roadmap_subscribe", "auth_sign_in", "auth_sign_out", "auth_adopt", "account_delete", "telemetry_storage", "telemetry_delivery", "telemetry_overflow", "telemetry_rejected", "sync_hello", "sync_push", "sync_pull", "sync_live", "sync_live_send", "sync_live_receive", "sync_digest", "sync_admission", "sync_doubt", "storage_open", "storage_read", "storage_write", "storage_prepare", "storage_fork_guard", "keychain_read", "keychain_save", "keychain_delete", "keychain_accounts", "roadmap_plant", "roadmap_file", "roadmap_landing", "roadmap_kept", "agent-host", "ai-call", "ai-pass", "roadmap-coach-turn"],
  ]

  // The counts a Coach turn carries (Coach §10.2) and an Undo of an act's operations, requests, wait and the targets a
  // sign-in's Add gave up (`sync_inverse`): bounded numbers, never a word.
  static let counts: Set<String> = ["ability_calls", "refusals", "answer_bytes", "applied", "skipped", "waiting", "age_ms", "given_up"]

  static func properties(_ input: [String: String], durationMs: Int64? = nil) -> [String: EventValue] {
    var result: [String: EventValue] = [:]
    for (key, value) in input {
      if labels[key]?.contains(value) == true { result[key] = .label(value) }
      if key == "status", let status = Int(value), (100...599).contains(status) { result[key] = .label(String(status)) }
      if counts.contains(key), let count = Int64(value) { result[key] = .number(min(max(0, count), 10_000_000)) }
    }
    if let durationMs { result["duration_ms"] = .number(min(max(0, durationMs), 86_400_000)) }
    return result
  }

  static func persistedProperties(_ input: [String: EventValue], fallback: TelemetryMetadata) -> [String: EventValue] {
    var labels: [String: String] = [:]
    for (key, value) in input { if case .label(let label) = value { labels[key] = label } }
    let duration: Int64?
    if case .number(let number) = input["duration_ms"] { duration = number } else { duration = nil }
    var result = properties(labels, durationMs: duration).merging(fallback.properties) { _, new in new }
    for key in ["version", "build", "release"] {
      if let value = labels[key], !value.isEmpty, value.count <= 96,
         value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }) { result[key] = .label(value) }
    }
    if let environment = labels["environment"], ["production", "development", "test"].contains(environment) { result["environment"] = .label(environment) }
    return result
  }
}

nonisolated enum CrashReports {
  static func options(info: [String: Any], debug: Bool) -> Options? {
    guard !debug || info["WMDebugTelemetry"] as? String == "YES",
          let dsn = info["WMSentryDSN"] as? String,
          let url = URL(string: dsn), ["https", "http"].contains(url.scheme), url.user != nil, url.host != nil else { return nil }
    let metadata = TelemetryMetadata(info: info)
    let options = Options()
    options.dsn = dsn
    guard options.parsedDsn != nil else { return nil }
    options.releaseName = metadata.release
    options.dist = metadata.build
    options.environment = metadata.environment
    options.sendDefaultPii = false
    options.enableMemoryIntrospection = false
    options.attachScreenshot = false
    options.attachViewHierarchy = false
    options.enableAutoBreadcrumbTracking = false
    options.enableNetworkBreadcrumbs = false
    options.enableNetworkTracking = false
    options.enableCaptureFailedRequests = false
    options.enableSwizzling = false
    options.enableAutoPerformanceTracing = false
    options.enableUIViewControllerTracing = false
    options.enableUserInteractionTracing = false
    options.enableFileIOTracing = false
    options.enableCoreDataTracing = false
    options.enableDataSwizzling = false
    options.enableFileManagerSwizzling = false
    options.enableMetricKit = false
    // App Hangs stay on: a main thread blocked for 2 seconds is the one report of a freeze.
    options.appHangTimeoutInterval = 2
    options.enableStandaloneAppStartTracing = false
    options.enablePersistingTracesWhenCrashing = false
    options.enablePropagateTraceparent = false
    options.configureProfiling = { profile in profile.sessionSampleRate = 0; profile.profileAppStarts = false }
    options.enableAutoSessionTracking = false
    options.enableLogs = false
    options.enableMetrics = false
    options.tracesSampleRate = 0
    options.sessionReplay.sessionSampleRate = 0
    options.sessionReplay.onErrorSampleRate = 0
    options.beforeBreadcrumb = { _ in nil }
    options.beforeSend = scrub
    return options
  }

  static func scrub(_ event: Event) -> Event? {
    event.serverName = nil; event.transaction = nil; event.fingerprint = nil
    event.message = nil; event.request = nil; event.breadcrumbs = nil; event.extra = nil; event.user = nil
    event.tags = TelemetryPrivacy.properties(event.tags ?? [:]).compactMapValues {
      if case .label(let label) = $0 { return label }; return nil
    }.merging(["platform": "ios"]) { _, new in new }
    let duration = event.context?["telemetry"]?["duration_ms"] as? NSNumber
    let contextFields: [String: Set<String>] = [
      "app": ["app_identifier", "app_name", "app_version", "app_build", "app_start_time", "build_type"],
      "device": ["arch", "family", "model", "model_id", "simulator", "memory_size", "free_memory", "usable_memory", "processor_count", "thermal_state", "low_power_mode"],
      "os": ["name", "version", "build", "kernel_version", "rooted"],
      "runtime": ["name", "version"]
    ]
    event.context = event.context?.filter { contextFields[$0.key] != nil }
    for (key, value) in event.context ?? [:] { event.context?[key] = value.filter { contextFields[key]?.contains($0.key) == true } }
    if let duration {
      event.context = (event.context ?? [:]).merging(["telemetry": ["duration_ms": min(max(0, duration.int64Value), 86_400_000)]]) { _, new in new }
    }
    for exception in event.exceptions ?? [] {
      exception.value = nil; exception.mechanism?.desc = nil; exception.mechanism?.data = nil
    }
    return event
  }

  static func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {
    let event = Event(level: .error)
    let exception = Exception(value: "", type: "WindmillHandledFailure")
    exception.mechanism = Mechanism(type: "handled")
    exception.mechanism?.handled = true
    event.exceptions = [exception]
    event.tags = properties.merging(["operation": operation, "failure_kind": kind]) { _, new in new }
    if let durationMs { event.context = ["telemetry": ["duration_ms": min(max(0, durationMs), 86_400_000)]] }
    SentrySDK.capture(event: event)
  }

  static func offline(properties: [String: String]) {
    let event = Event(level: .info)
    event.tags = properties.merging(["failure_kind": "offline"]) { _, value in value }
    SentrySDK.capture(event: event)
  }
}

nonisolated final class AppTelemetry: Telemetry, Sendable {
  struct Identity: Sendable { var account: String?; var token: SessionToken? }
  final class Session: Sendable {
    let identity = Mutex(Identity())
    let offline = Mutex(false)
    let sentryOffline = Mutex(false)
  }
  let session = Session()
  let queue: EventQueue?
  let enabled: Bool
  var connectionRequired: Bool { session.offline.withLock { $0 } || session.sentryOffline.withLock { $0 } }

  init(info: [String: Any], baseURL: URL?, directory: URL, debug: Bool, deliver: EventQueue.Delivery? = nil) {
    enabled = !debug || info["WMDebugTelemetry"] as? String == "YES"
    if let options = CrashReports.options(info: info, debug: debug) { SentrySDK.start(options: options) }
    if enabled, let baseURL {
      let session = self.session
      queue = EventQueue(file: directory.appending(path: "events.json"), baseURL: baseURL,
                         metadata: TelemetryMetadata(info: info), credentials: { session.identity.withLock { $0 } },
                         report: { operation, kind, properties, duration in
                           if ["offline", "timeout"].contains(kind) {
                             let first = session.sentryOffline.withLock { value in let first = !value; value = true; return first }
                             if first { CrashReports.offline(properties: properties.merging(["operation": operation]) { _, value in value }) }
                           } else { CrashReports.failure(operation, kind: kind, properties: properties, durationMs: duration) }
                         }, deliver: deliver)
    } else { queue = nil }
    if let queue {
      Task { [weak queue] in
        while !Task.isCancelled {
          guard let queue else { return }
          await queue.flush()
          try? await Task.sleep(for: .seconds(30))
        }
      }
    }
  }

  func setIdentity(account: String?, token: SessionToken?) {
    session.identity.withLock { $0 = Identity(account: account, token: token) }
    if let queue { Task { await queue.flush() } }
  }

  func event(_ name: String, properties: [String: String], durationMs: Int64?) {
    var properties = properties
    if name == "api_request_failed", ["offline", "timeout"].contains(properties["failure_kind"]) {
      let first = session.offline.withLock { value in
        let first = !value; value = true; return first
      }
      guard first else { return }
      properties["failure_kind"] = "offline"
      let firstSentry = session.sentryOffline.withLock { value in let first = !value; value = true; return first }
      if enabled, firstSentry { CrashReports.offline(properties: properties) }
    } else if ["sync_pull_outcome", "sync_push_outcome", "auth_code_sent", "auth_signed_in"].contains(name), properties["outcome"] == "ok" {
      session.offline.withLock { $0 = false }
      session.sentryOffline.withLock { $0 = false }
    } else if ["sync_pull_outcome", "sync_push_outcome"].contains(name), properties["outcome"] == "failed", connectionRequired {
      return
    }
    guard let queue, TelemetryPrivacy.events.contains(name) else { return }
    let account = session.identity.withLock { $0.account }
    let props = TelemetryPrivacy.properties(properties, durationMs: durationMs)
    Task { await queue.record(name, properties: props, account: account) }
  }

  func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {
    if ["offline", "timeout"].contains(kind) {
      event("api_request_failed", properties: properties.merging(["operation": operation, "failure_kind": kind]) { _, value in value }, durationMs: durationMs)
      return
    }
    guard enabled else { return }
    let props = properties.merging(["operation": operation, "failure_kind": kind]) { _, new in new }
    CrashReports.failure(operation, kind: kind, properties: properties, durationMs: durationMs)
    event("client_error", properties: props, durationMs: durationMs)
  }
}
