import Foundation
import Sentry
import Testing
import SyncEngine
import SyncTesting
import DomainKit
import DomainKitTesting
import GymDomain
import JournalDomain
import SyncModelServer
import SyncSchema
import Synchronization
@testable import Windmill

nonisolated final class TelemetryDelivery: Sendable {
  struct State { var requests: [URLRequest] = []; var statuses: [Int] = []; var accepted: Int? }
  let state = Mutex(State())
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as! [String: Any]
    let count = (body["events"] as! [Any]).count
    let (status, accepted) = state.withLock { state -> (Int, Int) in
      state.requests.append(request)
      return (state.statuses.isEmpty ? 202 : state.statuses.removeFirst(), state.accepted ?? count)
    }
    return (Data("{\"accepted\":\(accepted)}".utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
  }
}

nonisolated final class TelemetryRecorder: Telemetry {
  struct Entry: Sendable { let name: String; let properties: [String: String] }
  let entries = Mutex<[Entry]>([])
  func event(_ name: String, properties: [String: String], durationMs: Int64?) { entries.withLock { $0.append(Entry(name: name, properties: properties)) } }
  func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) { event("client_error", properties: ["operation": operation, "failure_kind": kind], durationMs: durationMs) }
}

nonisolated final class TelemetryBuffer<Value: Sendable>: Sendable {
  let state: Mutex<Value>
  init(_ value: Value) { state = Mutex(value) }
  func withLock<Result>(_ body: (inout sending Value) throws -> sending Result) rethrows -> sending Result { try state.withLock(body) }
}

@Suite(.serialized) @MainActor struct TelemetryTests {
  let info: [String: Any] = ["WMSentryDSN": "https://ios@example.invalid/42", "WMDebugTelemetry": "YES",
                             "CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "71", "WMSourceRevision": "abc123", "WMTelemetryEnvironment": "test"]
  func directory() -> URL { URL.temporaryDirectory.appending(path: UUID().uuidString) }
  func queue(file: URL, delivery: TelemetryDelivery, identity: TelemetryBuffer<AppTelemetry.Identity>? = nil,
             failures: TelemetryBuffer<[String]>? = nil) -> EventQueue {
    EventQueue(file: file, baseURL: URL(string: "https://first-party.invalid")!, metadata: TelemetryMetadata(info: info),
               credentials: { identity?.withLock { $0 } ?? AppTelemetry.Identity() },
               report: { operation, _, _, _ in failures?.withLock { $0.append(operation) } }, deliver: delivery.send, retryInterval: 0)
  }

  @Test func debugIsOptInAndMetadataMatchesReleaseConvention() {
    #expect(CrashReports.options(info: [:], debug: true) == nil)
    var disabled = info; disabled["WMDebugTelemetry"] = "NO"
    #expect(CrashReports.options(info: disabled, debug: true) == nil)
    #expect(CrashReports.options(info: disabled, debug: false)?.releaseName == "ios-0.2.0-abc123")
    #expect(CrashReports.options(info: info, debug: true)?.dist == "71")
    let options = CrashReports.options(info: info, debug: false)
    #expect(options?.enableAppHangTracking == true && options?.appHangTimeoutInterval == 2 && options?.enableMetricKit == false)
  }

  @Test func propertyFilterExcludesAllContentAndRetainsNumericLatency() throws {
    let filtered = TelemetryPrivacy.properties(["email": "private-marker", "text": "private-marker", "mood": "8", "energy": "2",
                                                "operation": "private-marker", "screen": "code", "status": "502", "failure_kind": "http"], durationMs: 123)
    #expect(filtered == ["screen": .label("code"), "status": .label("502"), "failure_kind": .label("http"), "duration_ms": .number(123)])
    let bytes = try JSONEncoder().encode(filtered)
    #expect(!String(decoding: bytes, as: UTF8.self).contains("private-marker"))
  }

  @Test func writingChoicesRetainOnlyBoundedLabels() {
    for action in ["write", "done_writing"] {
      #expect(TelemetryPrivacy.properties(["screen": "journal", "action": action, "text": "private-marker", "mood": "8"]) ==
              ["screen": .label("journal"), "action": .label(action)])
    }
    #expect(TelemetryPrivacy.properties(["action": "private-marker"]).isEmpty)
  }

  @Test func gymEventsRetainBoundedLabelsAndRejectTrainingContent() {
    #expect(TelemetryPrivacy.events.isSuperset(of: ["gym_activity_set_logged", "gym_activity_offer_refused", "gym_session_started", "gym_session_finished", "gym_set_logged", "gym_routine_saved", "gym_ask_started", "gym_ask_outcome", "gym_proposal_outcome"]))
    for screen in ["routine", "routine_editor", "routine_targets", "routine_movement", "movement", "session", "fix_set", "record", "bodyweight", "weigh_in", "session_share", "history", "notes", "note", "review", "connected_log", "connected_log_guide", "on_this_phone"] {
      #expect(TelemetryPrivacy.properties(["screen": screen, "name": "private-marker", "load": "100", "note": "private-marker", "question": "private-marker"]) == ["screen": .label(screen)])
    }
    #expect(TelemetryPrivacy.properties(["action": "apply", "outcome": "decided", "method": "PUT", "cap": "daily", "storage": "device"]) ==
            ["action": .label("apply"), "outcome": .label("decided"), "method": .label("PUT"), "cap": .label("daily")])
    #expect(TelemetryPrivacy.properties(["cap": "private-marker", "screen": "private-marker", "action": "private-marker"]).isEmpty)
    #expect(TelemetryPrivacy.properties(["screen": "settings"]).isEmpty && TelemetryPrivacy.properties(["screen": "sign_out"]).isEmpty)
    #expect(TelemetryPrivacy.events.contains("gym_hidden_workout") && TelemetryPrivacy.properties(["action": "hide"]) == ["action": .label("hide")])
    #expect(TelemetryPrivacy.properties(["action": "open", "door": "accessory", "name": "private-marker"]) == ["action": .label("open"), "door": .label("accessory")])
    #expect(TelemetryPrivacy.events.contains("coach_turn") && TelemetryPrivacy.events.contains("coach_ability"))
    #expect(TelemetryPrivacy.properties(["state": "completed", "seat": "anon", "ability_calls": "7", "answer_bytes": "120", "code": "subject_exhausted", "text": "private-marker"])
            == ["state": .label("completed"), "seat": .label("anon"), "ability_calls": .number(7), "answer_bytes": .number(120), "code": .label("subject_exhausted")])
    #expect(TelemetryPrivacy.properties(["name": "save_note", "outcome": "seat-required", "refusals": "not-a-count"]) == ["name": .label("save_note"), "outcome": .label("seat-required")])
    // Every ability the catalog offers Coach is a name its event carries; a proposal's outcome names what it changes.
    for ability in Catalog.offered(seat: .bound) + Catalog.offered(seat: .anon) {
      #expect(TelemetryPrivacy.properties(["name": ability.name]) == ["name": .label(ability.name)], Comment(rawValue: ability.name))
    }
    #expect(TelemetryPrivacy.properties(["target": "workout", "action": "apply", "outcome": "decided"]) == ["target": .label("workout"), "action": .label("apply"), "outcome": .label("decided")])
    #expect(TelemetryPrivacy.properties(["target": "routine"]) == ["target": .label("routine")] && TelemetryPrivacy.properties(["target": "Push A"]).isEmpty)
    for outcome in ["started", "saved", "refused", "failed"] {
      #expect(TelemetryPrivacy.properties(["outcome": outcome, "routine": "private-marker"]) == ["outcome": .label(outcome)])
    }
  }

  @Test func anUndoOfAnActReportsOutcomesAndCountsAndDropsItsIds() {
    #expect(TelemetryPrivacy.events.contains("sync_inverse"))
    for outcome in ["ok", "pending", "unavailable", "failed"] {
      #expect(TelemetryPrivacy.properties(["outcome": outcome, "requestId": "g_private0001"]) == ["outcome": .label(outcome)])
    }
    let settled: [String: EventValue] = ["outcome": .label("settled"), "applied": .number(2), "skipped": .number(1), "skip_reason": .label("history-changed")]
    #expect(TelemetryPrivacy.properties(["outcome": "settled", "applied": "2", "skipped": "1", "skip_reason": "history-changed",
                                         "inverseActId": "g_private0002"]) == settled)
    #expect(TelemetryPrivacy.labels["skip_reason"] == ["none", "history-changed", "epoch-changed", "reference-unbound", "version-changed",
                                                       "record-changed", "record-present", "scope-changed", "other"])
    #expect(TelemetryPrivacy.properties(["skip_reason": "stale"]).isEmpty && TelemetryPrivacy.properties(["skip_reason": "g_private0003"]).isEmpty)
    #expect(TelemetryPrivacy.properties(["outcome": "adopted", "given_up": "2", "actId": "g_private0004", "record": "card0001"]) ==
            ["outcome": .label("adopted"), "given_up": .number(2)])
    let waiting: [String: EventValue] = ["outcome": .label("pending"), "waiting": .number(3), "age_ms": .number(10_000_000)]
    #expect(TelemetryPrivacy.properties(["outcome": "pending", "waiting": "3", "age_ms": "86400000", "actId": "card0001"]) == waiting)
    #expect(TelemetryPrivacy.properties(["outcome": "settled", "applied": "card0001"]) == ["outcome": .label("settled")])
  }

  @Test func receiptAndConfirmationStepsRetainOnlyBoundedActionLabels() {
    #expect(TelemetryPrivacy.properties(["screen": "workout", "action": "share", "sessionId": "private-id", "question": "private-text"]) ==
            ["screen": .label("workout"), "action": .label("share")])
    #expect(TelemetryPrivacy.properties(["screen": "receipt", "action": "keep", "sessionId": "private-id"]) == ["screen": .label("receipt"), "action": .label("keep")])
    for screen in ["workout", "log", "session", "on_this_phone", "history"] {
      #expect(TelemetryPrivacy.properties(["screen": screen, "action": "discard", "state": "shown", "name": "private-title"]) ==
              ["screen": .label(screen), "action": .label("discard"), "state": .label("shown")])
      #expect(TelemetryPrivacy.properties(["screen": screen, "action": "cancel", "outcome": "cancelled", "threadId": "private-id"]) ==
              ["screen": .label(screen), "action": .label("cancel"), "outcome": .label("cancelled")])
    }
    #expect(!TelemetryPrivacy.events.contains("gym_undo") && TelemetryPrivacy.properties(["operation": "gym_undo"]).isEmpty)
  }

  @Test func theRoadmapRoomTellsItsOpeningAndItsFailedReadAndNothingOfARoadmap() {
    #expect(TelemetryPrivacy.events.contains("roadmap_room_opened"))
    #expect(TelemetryPrivacy.properties(["room": "roadmap", "action": "open_roadmap", "operation": "roadmap_read", "failure_kind": "decode",
                                         "title": "private-marker", "tree": "private-id", "step": "private-id", "label": "private-marker"]) ==
            ["room": .label("roadmap"), "action": .label("open_roadmap"), "operation": .label("roadmap_read"), "failure_kind": .label("decode")])
  }

  @Test func theRoadmapRoomTellsItsWritesByTheirKindAndNothingOfAStep() {
    let events = ["roadmap_board_complete", "roadmap_board_delete", "roadmap_board_undo", "roadmap_write_refused"]
    #expect(events.filter(TelemetryPrivacy.events.contains) == events)
    #expect(TelemetryPrivacy.properties(["door": "swipe", "act": "delete", "step": "held", "view": "board", "write": "DeleteNode", "refusal": "startingStep",
                                         "outcome": "unavailable", "operation": "roadmap_write", "failure_kind": "storage",
                                         "title": "private-marker", "tree": "private-id", "node": "private-id", "steps": "8"]) ==
            ["door": .label("swipe"), "act": .label("delete"), "step": .label("held"), "view": .label("board"), "write": .label("DeleteNode"),
             "refusal": .label("startingStep"), "outcome": .label("unavailable"), "operation": .label("roadmap_write"), "failure_kind": .label("storage")])
    #expect(TelemetryPrivacy.properties(["door": "menu", "act": "complete", "write": "mark", "refusal": "gone", "step": "Read the wind"]) ==
            ["door": .label("menu"), "act": .label("complete"), "write": .label("mark"), "refusal": .label("gone")])
  }

  @Test func aStepsPageTellsItsOpeningAndItsActsByTheirKindAndNothingOfTheStep() {
    let events = ["roadmap_board_step_open", "roadmap_board_step_action"]
    #expect(events.filter(TelemetryPrivacy.events.contains) == events)
    for (door, column) in [("card", "upNext"), ("step", "locked"), ("card", "done")] {
      #expect(TelemetryPrivacy.properties(["surface": "document", "door": door, "column": column, "step": "private-id", "title": "private-marker"]) ==
              ["surface": .label("document"), "door": .label(door), "column": .label(column)])
    }
    for action in ["complete", "reset", "delete"] {
      #expect(TelemetryPrivacy.properties(["surface": "document", "action": action, "node": "private-id", "label": "Read the wind", "locked": "2"]) ==
              ["surface": .label("document"), "action": .label(action)])
    }
    #expect(TelemetryPrivacy.properties(["act": "reset", "outcome": "ok", "steps": "2"]) == ["act": .label("reset"), "outcome": .label("ok")])
    #expect(TelemetryPrivacy.properties(["step": "held", "door": "page", "view": "board", "tree": "private-id"]) ==
            ["step": .label("held"), "door": .label("page"), "view": .label("board")])
  }

  @Test func theGraphTellsItsSwitchItsSelectionAndItsReportsAndNothingOfAStep() {
    let events = ["roadmap_view_switch", "roadmap_graph_select", "roadmap_board_step_open", "roadmap_board_create", "roadmap_whats_next",
                  "roadmap_graph_fit"]
    #expect(events.filter(TelemetryPrivacy.events.contains) == events)
    for view in ["board", "graph"] {
      #expect(TelemetryPrivacy.properties(["view": view, "tree": "private-id", "title": "private-marker"]) == ["view": .label(view)])
    }
    // A Graph that comes up carries the roadmap's size as a bucket, up to the steps a roadmap may hold, never its count.
    for steps in ["1-100", "101-1000", "1001-5000", "5001-10000"] {
      #expect(TelemetryPrivacy.properties(["view": "graph", "steps": steps]) == ["view": .label("graph"), "steps": .label(steps)])
    }
    #expect(TelemetryPrivacy.properties(["view": "graph", "steps": "10000"]) == ["view": .label("graph")])
    for column in ["upNext", "locked", "done"] {
      #expect(TelemetryPrivacy.properties(["column": column, "step": "private-id", "label": "Read the wind"]) == ["column": .label(column)])
    }
    #expect(TelemetryPrivacy.properties(["surface": "document", "door": "graph", "column": "upNext", "node": "private-id"]) ==
            ["surface": .label("document"), "door": .label("graph"), "column": .label("upNext")])
    #expect(TelemetryPrivacy.properties(["step": "open", "door": "foot", "view": "graph", "node": "private-id"]) ==
            ["step": .label("open"), "door": .label("foot"), "view": .label("graph")])
    // *Next* tells its menu's opening and a pick with the steps Up next as a bucket, never their count or the step
    // picked; Fit tells that it was shown and left.
    for (step, count) in [("open", "1"), ("pick", "2-5"), ("pick", "6-20"), ("open", "21+")] {
      #expect(TelemetryPrivacy.properties(["step": step, "count": count, "node": "private-id", "label": "Read the wind"]) ==
              ["step": .label(step), "count": .label(count)])
    }
    #expect(TelemetryPrivacy.properties(["step": "pick", "count": "170"]) == ["step": .label("pick")])
    for step in ["open", "close"] {
      #expect(TelemetryPrivacy.properties(["step": step, "tree": "private-id", "zoom": "0.85"]) == ["step": .label(step)])
    }
    // A report says which layout or budget, and the roadmap's size as a bucket: never its count of steps.
    for kind in ["fallback", "unseated"] {
      #expect(TelemetryPrivacy.properties(["operation": "roadmap_layout", "failure_kind": kind, "tree": "private-id", "steps": "4999"]) ==
              ["operation": .label("roadmap_layout"), "failure_kind": .label(kind)])
    }
    for (budget, steps) in [("first_frame", "1-100"), ("frames", "101-1000"), ("frames", "1001-5000")] {
      #expect(TelemetryPrivacy.properties(["operation": "roadmap_canvas", "failure_kind": "budget", "budget": budget, "steps": steps, "title": "private-marker"]) ==
              ["operation": .label("roadmap_canvas"), "failure_kind": .label("budget"), "budget": .label(budget), "steps": .label(steps)])
    }
    #expect(TelemetryPrivacy.properties(["budget": "first_frame", "steps": "5000", "ms": "1200"]) == ["budget": .label("first_frame")])
  }

  @Test func theRoomsRoadmapsTellTheirStepsByKindAndNothingOfARoadmap() {
    let events = ["roadmap_sheet", "birth", "roadmap_board_create", "roadmap_deletion"]
    #expect(events.filter(TelemetryPrivacy.events.contains) == events)
    for (step, door) in [("switch", "menu"), ("switch", "list"), ("new", "menu"), ("new", "list"), ("new", "empty"), ("ask", "menu"), ("ask", "list")] {
      #expect(TelemetryPrivacy.properties(["step": step, "door": door, "tree": "private-id", "title": "private-marker", "roadmaps": "9"]) ==
              ["step": .label(step), "door": .label(door)])
    }
    for step in ["open", "search", "rename", "confirm", "cancel"] {
      #expect(TelemetryPrivacy.properties(["step": step, "name": "Learn to sail", "query": "private-marker", "count": "9"]) == ["step": .label(step)])
    }
    #expect(TelemetryPrivacy.properties(["step": "cancel", "door": "blank", "name": "Learn to sail"]) == ["step": .label("cancel"), "door": .label("blank")])
    for openers in ["none", "some"] {
      #expect(TelemetryPrivacy.properties(["step": "held", "door": "list", "openers": openers, "steps": "1", "in": "Become a day skipper"]) ==
              ["step": .label("held"), "door": .label("list"), "openers": .label(openers)])
    }
    for outcome in ["cancelled", "released"] {
      #expect(TelemetryPrivacy.properties(["step": "undo", "outcome": outcome, "tree": "private-id"]) == ["step": .label("undo"), "outcome": .label(outcome)])
    }
    for write in ["createRoadmap", "title", "deleteRoadmap"] {
      #expect(TelemetryPrivacy.properties(["write": write, "refusal": "invalid", "title": "private-marker"]) == ["write": .label(write), "refusal": .label("invalid")])
    }
  }

  @Test func theStepFormTellsItsStepsByKindAndNothingOfTheStep() {
    let events = ["roadmap_board_create", "roadmap_step_edit", "roadmap_board_edit", "roadmap_board_undo", "roadmap_write_refused", "roadmap_board_delete"]
    #expect(events.filter(TelemetryPrivacy.events.contains) == events)
    for (step, door) in [("open", "foot"), ("open", "empty"), ("open", "page"), ("cancel", "foot"), ("cancel", "page"), ("discard", "empty"), ("discard", "page")] {
      #expect(TelemetryPrivacy.properties(["step": step, "door": door, "view": "board", "node": "private-id", "label": "Reefing basics"]) ==
              ["step": .label(step), "door": .label(door), "view": .label("board")])
    }
    for column in ["locked", "upNext"] {
      #expect(TelemetryPrivacy.properties(["step": "saved", "column": column, "label": "Reefing basics", "requires": "2"]) ==
              ["step": .label("saved"), "column": .label(column)])
    }
    #expect(TelemetryPrivacy.properties(["step": "saved", "name": "true", "description": "false", "kind": "true", "prerequisites": "false", "opens": "true",
                                         "label": "Reefing basics", "color": "olive"]) ==
            ["step": .label("saved"), "name": .label("true"), "description": .label("false"), "kind": .label("true"), "prerequisites": .label("false"),
             "opens": .label("true")])
    #expect(TelemetryPrivacy.properties(["name": "Reefing basics", "description": "How to reduce sail area.", "kind": "olive", "opens": "3"]).isEmpty)
    for (write, refusal) in [("CreateNode", "noName"), ("CreateNode", "loop"), ("EditNode", "loop"), ("EditNode", "invalid"), ("CreateNode", "full")] {
      #expect(TelemetryPrivacy.properties(["write": write, "refusal": refusal, "step": "Leave the dock"]) == ["write": .label(write), "refusal": .label(refusal)])
    }
    for act in ["create", "edit"] {
      #expect(TelemetryPrivacy.properties(["act": act, "outcome": "ok", "node": "private-id"]) == ["act": .label(act), "outcome": .label("ok")])
    }
    #expect(TelemetryPrivacy.properties(["step": "held", "door": "form", "view": "board", "tree": "private-id"]) ==
            ["step": .label("held"), "door": .label("form"), "view": .label("board")])
    #expect(TelemetryPrivacy.properties(["operation": "roadmap_write", "failure_kind": "storage", "write": "EditNode", "error": "private-marker"]) ==
            ["operation": .label("roadmap_write"), "failure_kind": .label("storage"), "write": .label("EditNode")])
  }

  @Test func aStepsWorkspaceTellsItsActsByKindAndNothingThePersonWrote() {
    let events = ["roadmap_board_workspace", "roadmap_board_step_action", "roadmap_board_edit", "roadmap_write_refused"]
    #expect(events.filter(TelemetryPrivacy.events.contains) == events)
    for action in ["subtaskAdd", "subtaskToggle", "subtaskDelete", "linkOpen", "linkCancel", "linkAdd", "linkDelete", "noteSave"] {
      #expect(TelemetryPrivacy.properties(["action": action, "label": "Check the harbour flag", "text": "private-marker", "title": "Telltale guide",
                                           "url": "https://rya.org.uk/telltales", "node": "private-id", "count": "2"]) == ["action": .label(action)])
    }
    for act in ["subtaskToggle", "subtaskDelete", "linkDelete"] {
      #expect(TelemetryPrivacy.properties(["action": "undo", "act": act, "outcome": "ok", "label": "Check the harbour flag"]) ==
              ["action": .label("undo"), "act": .label(act), "outcome": .label("ok")])
    }
    #expect(TelemetryPrivacy.properties(["surface": "document", "action": "editNote", "text": "private-marker"]) ==
            ["surface": .label("document"), "action": .label("editNote")])
    #expect(TelemetryPrivacy.properties(["step": "saved", "links": "true", "url": "https://rya.org.uk/telltales"]) == ["step": .label("saved"), "links": .label("true")])
    #expect(TelemetryPrivacy.properties(["links": "https://rya.org.uk/telltales", "action": "Check the harbour flag", "act": "Telltale guide"]).isEmpty)
    for write in ["workspace", "note"] {
      #expect(TelemetryPrivacy.properties(["write": write, "refusal": "gone", "label": "Check the harbour flag"]) == ["write": .label(write), "refusal": .label("gone")])
      #expect(TelemetryPrivacy.properties(["operation": "roadmap_write", "failure_kind": "storage", "write": write, "error": "private-marker"]) ==
              ["operation": .label("roadmap_write"), "failure_kind": .label("storage"), "write": .label(write)])
    }
  }

  // The Board's Find, sort and filter, branch and selection, and the Kinds sheet: each step by its kind, the kinds shown
  // and the steps chosen as buckets, and never Find's words, a kind's name or description, a step's name or an id.
  @Test func theBoardsQueryItsSelectionAndKindsTellWhatWasDoneAndNothingWritten() {
    let events = ["roadmap_board_menu", "roadmap_board_sort", "roadmap_board_filter", "roadmap_board_clear", "roadmap_board_branch",
                  "roadmap_board_search", "roadmap_board_select", "roadmap_board_bulk", "roadmap_kinds", "roadmap_board_edit", "roadmap_board_undo"]
    #expect(events.filter(TelemetryPrivacy.events.contains) == events)
    #expect(TelemetryPrivacy.properties(["menu": "sortFilter", "sort": "newest", "query": "reef", "search": "sail"]) ==
            ["menu": .label("sortFilter"), "sort": .label("newest")])
    #expect(TelemetryPrivacy.properties(["count": "2-5", "kinds": "olive,sky", "what": "kinds", "from": "empty"]) ==
            ["count": .label("2-5"), "what": .label("kinds"), "from": .label("empty")])
    #expect(TelemetryPrivacy.properties(["count": "4", "what": "Learn", "from": "Tie a bowline"]).isEmpty)
    #expect(TelemetryPrivacy.properties(["step": "start", "door": "tool", "steps": "private-id"]) == ["step": .label("start"), "door": .label("tool")])
    #expect(TelemetryPrivacy.properties(["step": "end", "via": "act"]) == ["step": .label("end"), "via": .label("act")])
    #expect(TelemetryPrivacy.properties(["step": "delete_refused", "reason": "last_root", "node": "private-id"]) ==
            ["step": .label("delete_refused"), "reason": .label("last_root")])
    #expect(TelemetryPrivacy.properties(["surface": "board", "action": "openInGraph"]) == ["surface": .label("board"), "action": .label("openInGraph")])
    #expect(TelemetryPrivacy.properties(["step": "saved", "legend": "rename", "label": "Practice", "description": "Hours on the water"]) ==
            ["step": .label("saved"), "legend": .label("rename")])
    #expect(TelemetryPrivacy.properties(["act": "removeKind", "outcome": "ok"]) == ["act": .label("removeKind"), "outcome": .label("ok")])
    for write in ["BulkRecolor", "BulkDelete", "AddKind", "RenameKind", "DescribeKind", "RecolorKind", "RemoveKind"] {
      #expect(TelemetryPrivacy.properties(["write": write, "refusal": "full"]) == ["write": .label(write), "refusal": .label("full")])
    }
  }

  @Test func workoutPickerStepsExcludeMovementAndRackContent() {
    #expect(TelemetryPrivacy.events.contains("gym_workout_picker"))
    for action in ["open", "select", "cancel"] {
      #expect(TelemetryPrivacy.properties(["action": action, "outcome": "refused", "query": "private-marker",
                                           "exerciseId": "private-id", "name": "private-marker", "weightKg": "105", "reps": "5"]) ==
              ["action": .label(action), "outcome": .label("refused")])
    }
  }

  @Test func workoutPlanChangesCarryOnlyTheirActionOutcomeAndDoor() {
    #expect(TelemetryPrivacy.events.contains("gym_workout_plan_changed"))
    for action in ["retarget", "add_set", "remove_set", "swap", "add_movement", "remove_movement", "rest"] {
      #expect(TelemetryPrivacy.properties(["action": action, "outcome": "refused", "door": "workout", "exerciseId": "private-id",
                                           "name": "private-marker", "weightKg": "105", "reps": "5", "restSeconds": "120"]) ==
              ["action": .label(action), "outcome": .label("refused"), "door": .label("workout")])
    }
    // A Coach change applied to the workout reports as gym_proposal_outcome, so no plan change carries a proposal door.
    #expect(TelemetryPrivacy.properties(["action": "swap", "outcome": "ok", "door": "proposal"]) == ["action": .label("swap"), "outcome": .label("ok")])
  }

  @Test func editSetsIsAScreenOfItsOwn() {
    #expect(TelemetryPrivacy.properties(["screen": "edit_sets", "exerciseId": "private-id"]) == ["screen": .label("edit_sets")])
  }

  @Test func receiptPlanSavesCarryOnlyTheirOutcome() {
    #expect(TelemetryPrivacy.events.contains("gym_receipt_plan_saved"))
    for outcome in ["ok", "refused", "failed"] {
      #expect(TelemetryPrivacy.properties(["outcome": outcome, "routine": "private-marker", "changes": "2"]) == ["outcome": .label(outcome)])
    }
  }

  @Test func restTargetReachedCarriesItsScreenAndNoTime() {
    #expect(TelemetryPrivacy.events.contains("gym_rest_target_reached"))
    #expect(TelemetryPrivacy.properties(["screen": "workout", "restSeconds": "120", "since": "134", "exerciseId": "private-id",
                                         "name": "private-marker", "weightKg": "105", "reps": "5"]) == ["screen": .label("workout")])
  }

  @Test func workoutLoadTypingCarriesOnlyItsScreenAndAction() {
    #expect(TelemetryPrivacy.events.contains("gym_workout_load_typed"))
    for action in ["open", "land"] {
      #expect(TelemetryPrivacy.properties(["screen": "workout", "action": action, "weightKg": "105", "typed": "10.5", "exerciseId": "private-id"]) ==
              ["screen": .label("workout"), "action": .label(action)])
    }
  }

  @Test func logWeightActionsExcludeMeasurementContent() {
    for item in ["weigh_in", "bodyweight"] {
      #expect(TelemetryPrivacy.properties(["screen": "log", "action": "open", "item": item, "weightKg": "82.5",
                                           "day": "2026-10-24", "recordedAt": "1792857600000", "id": "private-id"]) ==
              ["screen": .label("log"), "action": .label("open"), "item": .label(item)])
    }
  }

  @Test func coachConversationActionsExcludeContentAndIdentifiers() {
    for action in ["new_chat", "view_answer", "open_conversation", "delete_conversation"] {
      for door in ["tab", "history", "handoff", "new_chat", "workout"] {
        #expect(TelemetryPrivacy.properties(["screen": "coach", "action": action, "door": door, "outcome": "ok",
                                             "draft": "private-marker", "question": "private-marker", "photo": "private-marker",
                                             "threadId": "private-id", "requestId": "private-id", "ownerId": "private-id"]) ==
                ["screen": .label("coach"), "action": .label(action), "door": .label(door), "outcome": .label("ok")])
      }
    }
  }

  @Test func weighInDateActionsExcludeSelectedDateAndMeasurement() {
    for action in ["open", "apply", "cancel"] {
      #expect(TelemetryPrivacy.properties(["screen": "weigh_in", "action": action, "item": "date", "weightKg": "82.5",
                                           "day": "2026-10-24", "recordedAt": "1792857600000", "id": "private-id"]) ==
              ["screen": .label("weigh_in"), "action": .label(action), "item": .label("date")])
    }
  }

  @Test func receiptMenuAndRetryExcludeWorkoutContent() {
    for action in ["menu", "retry"] {
      #expect(TelemetryPrivacy.properties(["screen": "receipt", "action": action, "name": "private-marker",
                                           "sessionId": "private-id", "sets": "7", "volume": "3980", "review": "private-marker"]) ==
              ["screen": .label("receipt"), "action": .label(action)])
    }
  }

  @Test func routineEditorStagesAndSavesExcludeIdentityAndTargets() {
    for item in ["movement", "targets"] {
      #expect(TelemetryPrivacy.properties(["screen": "routine_movement_editor", "action": "stage", "item": item, "outcome": "ok",
                                           "name": "private-marker", "exerciseId": "private-id", "equipment": "barbell",
                                           "sets": "4", "reps": "8", "weightKg": "82.5"]) ==
              ["screen": .label("routine_movement_editor"), "action": .label("stage"), "item": .label(item), "outcome": .label("ok")])
    }
    for outcome in ["saved", "refused", "failed"] {
      #expect(TelemetryPrivacy.properties(["screen": "routine_editor", "action": "update", "item": "routine", "outcome": outcome,
                                           "name": "private-marker", "routineId": "private-id", "entries": "private-marker"]) ==
              ["screen": .label("routine_editor"), "action": .label("update"), "item": .label("routine"), "outcome": .label(outcome)])
    }
  }

  @Test func echoNamesAndDiagnosticsAllowOnlyContentFreeLabels() {
    #expect(TelemetryPrivacy.events.filter { $0.hasPrefix("journal_echo_") } ==
            Set(["journal_echo_shown", "journal_echo_opened", "journal_echo_dismissed", "journal_echo_useful", "journal_echo_ink",
                 "journal_echo_reader_opened", "journal_echo_intro_dismissed"]))
    #expect(TelemetryPrivacy.properties(["action": "open"]) == ["action": .label("open")])
    #expect(TelemetryPrivacy.properties(["action": "close"]) == ["action": .label("close")])
    let content = ["text": "private-marker", "excerpt": "private-marker", "reason": "private-marker",
                   "date": "2026-10-08", "source_day": "2025-01-01", "target_day": "2026-10-08",
                   "score": "0.94", "count": "3", "echo_id": "private-marker", "page_id": "private-marker",
                   "source_id": "private-marker", "target_id": "private-marker"]
    #expect(TelemetryPrivacy.properties(content).isEmpty)
    let diagnostics = content.merging(["operation": "journal_echoes", "route": "/v1/journal", "method": "GET",
                                       "failure_kind": "http", "status": "503"]) { _, new in new }
    #expect(TelemetryPrivacy.properties(diagnostics, durationMs: 42) ==
            ["operation": .label("journal_echoes"), "route": .label("/v1/journal"), "method": .label("GET"),
             "failure_kind": .label("http"), "status": .label("503"), "duration_ms": .number(42)])
    #expect(TelemetryPrivacy.properties(["operation": "journal_echoes_private-marker",
                                        "route": "/v1/journal/echoes/private-marker"]).isEmpty)
  }

  @Test func restoredEchoEventsStripTextDatesScoresIdentifiersAndCounts() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    var stored = EventQueue.State()
    stored.events = ["journal_echo_shown", "journal_echo_opened", "journal_echo_dismissed", "journal_echo_useful"].map {
      EventQueue.Item(id: UUID().uuidString, name: $0, clientMs: 1,
                      props: ["text": .label("private-marker"), "excerpt": .label("private-marker"),
                              "reason": .label("private-marker"), "date": .label("2026-10-08"),
                              "source_day": .label("2025-01-01"), "target_day": .label("2026-10-08"),
                              "score": .label("0.94"), "count": .number(3), "echo_id": .label("private-marker"),
                              "page_id": .label("private-marker"), "source_id": .label("private-marker"),
                              "target_id": .label("private-marker")], account: nil)
    }
    let bytes = try JSONEncoder().encode(stored)
    let metadata = TelemetryMetadata(info: info)
    let events = EventQueue(file: file, baseURL: URL(string: "https://first-party.invalid")!, metadata: metadata,
                           credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in },
                           deliver: delivery.send, load: { _ in bytes })
    await events.flush()
    let body = try #require(delivery.state.withLock { $0.requests.first?.httpBody })
    let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    let submitted = try #require(json["events"] as? [[String: Any]])
    #expect(submitted.compactMap { $0["id"] as? String } == stored.events.map(\.id))
    #expect(submitted.compactMap { $0["name"] as? String } == stored.events.map(\.name))
    for event in submitted {
      let properties = try #require(event["props"] as? [String: Any])
      let filtered = try JSONDecoder().decode([String: EventValue].self, from: JSONSerialization.data(withJSONObject: properties))
      #expect(filtered == metadata.properties)
    }
    #expect(!String(decoding: body, as: UTF8.self).contains("private-marker"))
    #expect(await events.state.events.isEmpty)
  }

  @Test func echoFailureScrubberPreservesStaticOperationAndRejectsContent() throws {
    let event = Event(level: .error)
    event.message = SentryMessage(formatted: "private-marker")
    event.tags = ["operation": "journal_echoes", "route": "/v1/journal", "failure_kind": "decode", "method": "GET",
                  "text": "private-marker", "excerpt": "private-marker", "date": "2026-10-08",
                  "score": "0.94", "echo_id": "private-marker", "count": "3"]
    event.extra = ["body": "private-marker"]
    event.context = ["echo": ["text": "private-marker", "date": "2026-10-08", "count": 3]]
    let scrubbed = try #require(CrashReports.scrub(event))
    #expect(scrubbed.tags == ["operation": "journal_echoes", "route": "/v1/journal", "failure_kind": "decode",
                              "method": "GET", "platform": "ios"])
    #expect(scrubbed.message == nil && scrubbed.extra == nil)
    #expect(scrubbed.context?.isEmpty != false)
    let bytes = try JSONSerialization.data(withJSONObject: scrubbed.serialize())
    #expect(!String(decoding: bytes, as: UTF8.self).contains("private-marker"))
  }

  @Test func inkLabelsAreBoundedWithoutReplayAction() {
    #expect(TelemetryPrivacy.properties(["screen": "ink_notes", "action": "dismiss_ink", "text": "private-marker"]) ==
            ["screen": .label("ink_notes"), "action": .label("dismiss_ink")])
    #expect(TelemetryPrivacy.properties(["action": "show_ink"]).isEmpty)
    #expect(TelemetryPrivacy.persistedProperties(["screen": .label("journal"), "action": .label("show_ink")],
                                               fallback: TelemetryMetadata(info: info)) ==
            ["screen": .label("journal")].merging(TelemetryMetadata(info: info).properties) { _, new in new })
  }

  @Test func sdkScrubsPrivateFieldsBeforeDelivery() async throws {
    let options = try #require(CrashReports.options(info: info, debug: true))
    let delivered = TelemetryBuffer<String?>(nil)
    options.beforeSend = { event in
      let scrubbed = CrashReports.scrub(event)!
      delivered.withLock { $0 = String(decoding: (try? JSONSerialization.data(withJSONObject: scrubbed.serialize())) ?? Data(), as: UTF8.self) }
      return nil
    }
    SentrySDK.start(options: options)
    defer { SentrySDK.close() }
    let event = Event(level: .error)
    event.message = SentryMessage(formatted: "private-marker"); event.user = User(userId: "private-marker")
    event.request = SentryRequest(); event.request?.url = "https://private-marker.invalid"
    event.extra = ["text": "private-marker"]; event.breadcrumbs = [Breadcrumb(level: .info, category: "private-marker")]
    event.tags = ["operation": "auth_request_code", "failure_kind": "http", "email": "private-marker"]
    event.context = ["custom": ["text": "private-marker"], "app": ["device_app_hash": "private-marker", "view_names": ["private-marker"]], "telemetry": ["duration_ms": 123, "text": "private-marker"]]
    let exception = Exception(value: "private-marker", type: "BoundaryFailure")
    exception.mechanism = Mechanism(type: "handled"); exception.mechanism?.handled = true
    exception.mechanism?.data = ["text": "private-marker"]; exception.mechanism?.desc = "private-marker"
    event.exceptions = [exception]
    SentrySDK.capture(event: event)
    for _ in 0..<500 { if delivered.withLock({ $0 != nil }) { break }; try await Task.sleep(for: .milliseconds(10)) }
    let json = try #require(delivered.withLock { $0 })
    #expect(!json.contains("private-marker"))
    #expect(json.contains("duration_ms") && json.contains("123") && json.contains("BoundaryFailure"))
    #expect(json.contains("ios-0.2.0-abc123"))
    for operation in ["gym_activity_request", "gym_activity_update"] {
      delivered.withLock { $0 = nil }
      CrashReports.failure(operation, kind: "storage", properties: ["title": "private-marker", "load": "private-marker"], durationMs: nil)
      for _ in 0..<500 { if delivered.withLock({ $0 != nil }) { break }; try await Task.sleep(for: .milliseconds(10)) }
      let activityFailure = try #require(delivered.withLock { $0 })
      #expect(activityFailure.contains(operation) && activityFailure.contains("WindmillHandledFailure"))
      #expect(!activityFailure.contains("private-marker"))
    }
  }

  @Test(.timeLimit(.minutes(1)), arguments: [false, true]) func offlineRetriesReachSentryAndTheQueueOnceWithoutContentOrIssues(telemetryDeliveryFirst: Bool) async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let (requests, submitted) = AsyncStream<URLRequest>.makeStream()
    defer { submitted.finish() }
    let telemetry = AppTelemetry(info: info, baseURL: URL(string: "https://offline.invalid"), directory: dir, debug: true,
                                 deliver: { request in submitted.yield(request); throw URLError(.timedOut) })
    let delivered = TelemetryBuffer<[String]>([])
    let options = try #require(CrashReports.options(info: info, debug: true))
    options.beforeSend = { event in
      let safe = CrashReports.scrub(event)!
      delivered.withLock { $0.append(String(decoding: (try? JSONSerialization.data(withJSONObject: safe.serialize())) ?? Data(), as: UTF8.self)) }
      return nil
    }
    SentrySDK.start(options: options)
    defer { SentrySDK.close() }
    let queue = try #require(telemetry.queue)
    if telemetryDeliveryFirst { await queue.report("telemetry_delivery", "timeout", ["route": "/v1/events", "message": "private-marker"], 60_000) }
    for _ in 0..<50 {
      telemetry.event("api_request_failed", properties: ["operation": "sync_hello", "failure_kind": "timeout", "email": "private-marker"])
      telemetry.failure("sync_hello", kind: "timeout")
    }
    await queue.report("telemetry_delivery", "timeout", ["route": "/v1/events", "message": "private-marker"], 60_000)
    var submissions = requests.makeAsyncIterator()
    let request = try #require(await submissions.next())
    #expect(request.httpMethod == "POST" && request.url?.path == "/v1/events")
    #expect(!String(decoding: request.httpBody ?? Data(), as: UTF8.self).contains("private-marker"))
    for _ in 0..<100 {
      if delivered.withLock({ $0.count == 1 }), await queue.state.events.count == 1 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let events = await queue.state.events
    #expect(events.map(\.name) == ["api_request_failed"])
    #expect(events.first?.props["failure_kind"] == .label("offline"))
    #expect(!String(decoding: try JSONEncoder().encode(events), as: UTF8.self).contains("private-marker"))
    let sent = delivered.withLock { $0 }
    #expect(sent.count == 1)
    #expect(sent.first?.contains("offline") == true && sent.first?.contains("info") == true)
    #expect(sent.allSatisfy { !$0.contains("private-marker") && !$0.contains("WindmillHandledFailure") })
    #expect(telemetry.connectionRequired)
    telemetry.event("sync_pull_outcome", properties: ["outcome": "ok"])
    #expect(!telemetry.connectionRequired)
    telemetry.event("api_request_failed", properties: ["operation": "sync_hello", "failure_kind": "offline"])
    for _ in 0..<100 where delivered.withLock({ $0.count < 2 }) { try await Task.sleep(for: .milliseconds(10)) }
    #expect(delivered.withLock { $0.count } == 2)
  }

  @Test func retryAndRelaunchKeepEventIdsAndPersistNoCredentials() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    delivery.state.withLock { $0.statuses = [503] }
    let first = queue(file: file, delivery: delivery)
    await first.record("journal_line_saved", properties: ["day_kind": .label("today")], account: nil)
    let before = try JSONDecoder().decode(EventQueue.State.self, from: Data(contentsOf: file))
    #expect(before.events.count == 1)
    let restored = queue(file: file, delivery: delivery)
    await restored.flush()
    let requests = delivery.state.withLock { $0.requests }
    let bodies = try requests.map { try JSONSerialization.jsonObject(with: $0.httpBody!) as! [String: Any] }
    #expect(bodies.count == 2)
    #expect((bodies[0]["events"] as! [[String: Any]])[0]["id"] as? String == before.events[0].id)
    #expect((bodies[1]["events"] as! [[String: Any]])[0]["id"] as? String == before.events[0].id)
    #expect(bodies[0]["sessionKey"] as? String == bodies[1]["sessionKey"] as? String)
    #expect(await restored.state.events.isEmpty)
    #expect(!String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("Bearer"))
  }

  @Test func persistedQueueIsFilteredAgainBeforeDelivery() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    var state = EventQueue.State()
    state.events = [EventQueue.Item(id: UUID().uuidString, name: "journal_line_saved", clientMs: 1,
                                  props: ["text": .label("private-marker"), "mood": .number(8), "energy": .number(2), "day_kind": .label("today")], account: nil)]
    try JSONEncoder().encode(state).write(to: file)
    let events = queue(file: file, delivery: delivery); await events.flush()
    let body = try #require(delivery.state.withLock { $0.requests.first?.httpBody })
    let json = String(decoding: body, as: UTF8.self)
    #expect(!json.contains("private-marker") && !json.contains("mood") && !json.contains("energy"))
    #expect(json.contains("day_kind") && json.contains("ios-0.2.0-abc123"))
  }

  @Test func batchesNeverExceedFifty() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    var state = EventQueue.State()
    state.events = (0..<123).map { _ in EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: nil) }
    try JSONEncoder().encode(state).write(to: file)
    let events = queue(file: file, delivery: delivery); await events.flush()
    let counts = try delivery.state.withLock { try $0.requests.map { ((try JSONSerialization.jsonObject(with: $0.httpBody!) as! [String: Any])["events"] as! [Any]).count } }
    #expect(counts == [50, 50, 23])
  }

  @Test func anonymousAndAccountShelvesUseOnlyTheirOwnCredentials() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    let identity = TelemetryBuffer(AppTelemetry.Identity())
    let events = queue(file: file, delivery: delivery, identity: identity)
    await events.record("app_started", properties: [:], account: "account-a")
    await events.record("app_started", properties: [:], account: "account-b")
    await events.record("app_started", properties: [:], account: nil)
    #expect(await events.state.events.count == 2)
    identity.withLock { $0 = AppTelemetry.Identity(account: "account-a", token: SessionToken("token-a")) }
    await events.flush()
    #expect(await events.state.events.map(\.account) == ["account-b"])
    identity.withLock { $0 = AppTelemetry.Identity(account: "account-b", token: SessionToken("token-b")) }
    await events.flush()
    #expect(delivery.state.withLock { $0.requests.map { $0.value(forHTTPHeaderField: "Authorization") } } == [nil, "Bearer token-a", "Bearer token-b"])
    #expect(!String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("token-"))
  }

  @Test func partialAcceptanceDropsSubmittedBatchWithoutRecursion() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([])
    delivery.state.withLock { $0.accepted = 0 }
    let events = queue(file: dir.appending(path: "events.json"), delivery: delivery, failures: failures)
    await events.record("app_started", properties: [:], account: nil)
    #expect(await events.state.events.isEmpty)
    #expect(failures.withLock { $0 } == ["telemetry_rejected"])
  }

  @Test func invalidAcknowledgementRetriesAndReportsOncePerFailureStreak() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([])
    delivery.state.withLock { $0.accepted = 99 }
    let events = queue(file: dir.appending(path: "events.json"), delivery: delivery, failures: failures)
    await events.record("app_started", properties: [:], account: nil)
    await events.flush()
    #expect(await events.state.events.count == 1)
    #expect(failures.withLock { $0 } == ["telemetry_delivery"])
    delivery.state.withLock { $0.accepted = nil }
    await events.flush()
    #expect(await events.state.events.isEmpty)
    delivery.state.withLock { $0.accepted = 99 }
    await events.record("app_started", properties: [:], account: nil)
    #expect(failures.withLock { $0 } == ["telemetry_delivery", "telemetry_delivery"])
  }

  @Test func fullQueueRejectsNewEventsWithoutEvictingAnotherAccount() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([])
    var state = EventQueue.State()
    state.events = (0..<500).map { _ in EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: "dormant-account") }
    try JSONEncoder().encode(state).write(to: file)
    let events = queue(file: file, delivery: delivery, failures: failures)
    await events.record("app_started", properties: [:], account: nil)
    await events.record("app_started", properties: [:], account: nil)
    #expect(await events.state.events.map(\.id) == state.events.map(\.id))
    #expect(await events.state.events.map(\.account) == state.events.map(\.account))
    #expect(failures.withLock { $0 } == ["telemetry_overflow"])
    #expect(delivery.state.withLock { $0.requests.isEmpty })
  }

  @Test func restorationDoesNotBlockStartupAndPreservesEventsDuringLoad() async throws {
    let entered = TelemetryBuffer(false), release = DispatchSemaphore(value: 0)
    let delivery = TelemetryDelivery(), dir = directory()
    defer { release.signal(); try? FileManager.default.removeItem(at: dir) }
    var stored = EventQueue.State()
    stored.events = [EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: nil)]
    let bytes = try JSONEncoder().encode(stored)
    let start = ContinuousClock.now
    let events = EventQueue(file: dir.appending(path: "events.json"), baseURL: URL(string: "https://first-party.invalid")!,
                            metadata: TelemetryMetadata(info: info), credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in },
                            deliver: delivery.send, load: { _ in
      entered.withLock { $0 = true }
      _ = release.wait(timeout: .now() + 5)
      return bytes
    })
    #expect(start.duration(to: .now) < .seconds(1))
    let recording = Task { await events.record("app_foregrounded", properties: [:], account: nil) }
    for _ in 0..<100 { if entered.withLock({ $0 }) { break }; try await Task.sleep(for: .milliseconds(10)) }
    #expect(entered.withLock { $0 })
    #expect(delivery.state.withLock { $0.requests.isEmpty })
    release.signal()
    await recording.value
    let request = try #require(delivery.state.withLock { $0.requests.first })
    let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
    let submitted = body["events"] as! [[String: Any]]
    #expect(submitted.map { $0["name"] as! String } == ["app_started", "app_foregrounded"])
    #expect(submitted.first?["id"] as? String == stored.events.first?.id)
  }

  @Test func restorationBoundsBytesBeforeReadingAndIfFileGrows() throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json")
    #expect(FileManager.default.createFile(atPath: file.path, contents: Data()))
    let handle = try FileHandle(forWritingTo: file)
    try handle.truncate(atOffset: UInt64(EventQueue.maximumBytes + 1)); try handle.close()
    var reads = 0
    #expect(throws: CocoaError.self) { try EventQueue.read(file) { _, _ in reads += 1; return Data() } }
    #expect(reads == 0)
    try Data().write(to: file)
    #expect(throws: CocoaError.self) {
      try EventQueue.read(file) { _, limit in
        #expect(limit == EventQueue.maximumBytes + 1)
        return Data(count: limit)
      }
    }
  }

  @Test func fullDirtyQueueRetriesStorageBeforeDeliveryAndRecovers() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([]), attempts = TelemetryBuffer(0)
    var stored = EventQueue.State()
    stored.events = (0..<499).map { _ in EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: nil) }
    let bytes = try JSONEncoder().encode(stored)
    let events = EventQueue(file: dir.appending(path: "events.json"), baseURL: URL(string: "https://first-party.invalid")!,
                            metadata: TelemetryMetadata(info: info), credentials: { AppTelemetry.Identity() },
                            report: { operation, _, _, _ in failures.withLock { $0.append(operation) } }, deliver: delivery.send,
                            retryInterval: 0, load: { _ in bytes }, save: { data, file in
      let count = attempts.withLock { $0 += 1; return $0 }
      if count <= 2 { throw CocoaError(.fileWriteOutOfSpace) }
      try EventQueue.write(data, to: file)
    })
    await events.record("app_foregrounded", properties: [:], account: nil)
    let ids = await events.state.events.map(\.id)
    #expect(ids.count == 500 && delivery.state.withLock { $0.requests.isEmpty })
    await events.record("app_backgrounded", properties: [:], account: nil) // Capacity must still permit a storage retry.
    #expect(await events.state.events.map(\.id) == ids)
    #expect(delivery.state.withLock { $0.requests.isEmpty })
    await events.flush() // The same scheduled flush path recovers without relaunch or another event.
    #expect(await events.state.events.isEmpty)
    let requests = delivery.state.withLock { $0.requests }
    #expect(requests.count == 10)
    let sent = try requests.flatMap { request in
      ((try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any])["events"] as! [[String: Any]]).map { $0["id"] as! String }
    }
    #expect(sent == ids)
    #expect(failures.withLock { $0 } == ["telemetry_storage", "telemetry_overflow"])
  }

  @Test func storageRetriesBackOffAndStayBounded() async throws {
    let dir = directory(), attempts = TelemetryBuffer(0), clock = TelemetryBuffer(Date())
    let events = EventQueue(file: dir.appending(path: "events.json"), baseURL: URL(string: "https://first-party.invalid")!,
                            metadata: TelemetryMetadata(info: info), credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in },
                            load: { _ in nil }, save: { _, _ in attempts.withLock { $0 += 1 }; throw CocoaError(.fileWriteOutOfSpace) },
                            now: { clock.withLock { $0 } })
    await events.record("app_started", properties: [:], account: nil)
    await events.record("app_foregrounded", properties: [:], account: nil)
    #expect(attempts.withLock { $0 } == 1)
    for delay in [1.0, 2, 4, 8, 16, 30, 30] {
      let before = attempts.withLock { $0 }
      clock.withLock { $0 = $0.addingTimeInterval(delay - 0.125) }
      await events.flush()
      #expect(attempts.withLock { $0 } == before)
      clock.withLock { $0 = $0.addingTimeInterval(0.125) }
      await events.flush()
      #expect(attempts.withLock { $0 } == before + 1)
    }
    #expect(await events.state.events.count == 2)
  }

  @Test func firstRunReportsChoicesAndSaveWithoutText() throws {
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let recorder = TelemetryRecorder()
    let model = try AppModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!, telemetry: recorder)
    model.openJournal(); model.journal.type("private-marker"); #expect(model.journal.save()); model.journal.done(); model.keep(); model.closeKeep()
    let entries = recorder.entries.withLock { $0 }
    #expect(entries.filter { $0.name == "journal_line_saved" }.count == 1)
    #expect(!entries.contains { $0.name.hasPrefix("scale_invitation") })
    #expect(entries.contains { $0.properties == ["screen": "journal", "action": "keep"] })
    #expect(entries.allSatisfy { !$0.properties.values.contains("private-marker") && $0.properties["mood"] == nil && $0.properties["energy"] == nil })
    model.journal.saveTask?.cancel()
  }
}
