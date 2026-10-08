import Foundation
import Sentry
import SyncEngine
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

nonisolated enum TelemetryPrivacy {
  static let events: Set<String> = [
    "app_started", "app_foregrounded", "app_backgrounded", "auth_restore", "auth_code_requested",
    "auth_code_sent", "auth_sign_in_started", "auth_signed_in", "auth_signed_out",
    "first_run_screen_viewed", "first_run_choice", "scale_invitation_shown", "scale_invitation_answered",
    "journal_line_saved", "journal_echo_shown", "journal_echo_opened", "journal_echo_dismissed", "journal_echo_useful",
    "sync_pull_outcome", "sync_push_outcome", "api_request_failed", "client_error",
    "onboarding_screen_viewed", "onboarding_skipped", "onboarding_finished", "onboarding_replayed", "room_switched", "room_adoption_answered", "gym_screen_viewed", "gym_action", "gym_undo",
    "gym_activity_set_logged", "gym_activity_offer_refused", "gym_session_started", "gym_session_finished", "gym_set_logged", "gym_routine_saved",
    "gym_ask_started", "gym_ask_outcome", "gym_proposal_outcome"
  ]
  static let labels: [String: Set<String>] = [
    "room": ["journal", "gym"],
    "page": ["windmill", "roadmap", "journal", "gym"],
    "presentation": ["first_launch", "replay"],
    "screen": ["routine", "routine_editor", "movement", "proposal", "session", "fix_set", "record", "bodyweight", "weigh_in", "session_share", "history", "notes", "note", "settings", "review", "connected_log", "gym", "routines", "log", "coach", "workout", "welcome", "journal", "ink_notes", "keep", "address", "code", "you", "adoption", "discard_adoption", "sign_out", "23a", "23b", "23c", "24a", "24b", "24c", "24d", "apple_no_account", "apple_expired", "auth_pending"],
    "action": ["create", "update", "apply", "dismiss", "open_gym", "open_journal", "dismiss_ink", "write", "done_writing", "keep", "close", "email", "back", "change_email", "resend", "add", "discard", "cancel", "sign_out", "answered", "declined", "use_account", "create_account", "remove_apple", "retry"],
    "outcome": ["answered", "capped", "fresh", "absent", "decided", "refused", "ok", "failed", "cancelled", "signed_in", "signed_out", "paused", "anonymous", "linked"],
    "storage": ["device", "server"],
    "cap": ["daily", "ceiling"],
    "method": ["GET", "POST", "PUT", "DELETE", "email", "apple"],
    "day_kind": ["today"],
    "scope_kind": ["product", "tree", "overlay", "unknown"],
    "route": ["/v1/auth", "/v1/me", "/v1/sync", "/v1/events", "/v1/gym", "/v1/journal"],
    "failure_kind": ["offline", "timeout", "transport", "http", "decode", "encode", "storage", "keychain", "unexpected", "admission", "digest_reset", "doubt_exhausted", "overflow", "rejected", "tls", "sqlite", "digest_mismatch", "malformed", "unexpected_admission", "backoff_exhausted"],
    "operation": ["gym_activity_request", "gym_activity_update", "gym_read", "gym_action", "gym_undo", "gym_flush", "gym_rest", "auth_request_code", "auth_verify_code", "auth_apple", "auth_apple_create", "auth_methods", "auth_apple_remove", "auth_logout", "auth_restore", "app_open", "journal_read", "journal_save", "journal_draft", "journal_choice", "journal_echoes", "auth_sign_in", "auth_sign_out", "auth_adopt", "telemetry_storage", "telemetry_delivery", "telemetry_overflow", "telemetry_rejected", "sync_hello", "sync_push", "sync_pull", "sync_live", "sync_live_send", "sync_live_receive", "sync_digest", "sync_admission", "sync_doubt", "storage_open", "storage_read", "storage_write", "storage_prepare", "storage_fork_guard", "keychain_read", "keychain_save", "keychain_delete", "keychain_accounts"]
  ]

  static func properties(_ input: [String: String], durationMs: Int64? = nil) -> [String: EventValue] {
    var result: [String: EventValue] = [:]
    for (key, value) in input {
      if labels[key]?.contains(value) == true { result[key] = .label(value) }
      if key == "status", let status = Int(value), (100...599).contains(status) { result[key] = .label(String(status)) }
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

  init(info: [String: Any], baseURL: URL?, directory: URL, debug: Bool) {
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
                         })
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
