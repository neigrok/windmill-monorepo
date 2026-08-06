import Foundation
import WindmillPlatform

// The one place the native gym talks to the backend — the twin of web/src/products/gym/gymApi.js,
// against the same routes:
//   GET  /v1/gym/exercises            ·  POST /v1/gym/exercises
//   POST /v1/gym/sessions             ·  POST /v1/gym/sessions/:id/sets
//   POST /v1/gym/sessions/:id/finish  ·  DELETE /v1/gym/sessions/:id
//   GET  /v1/gym/sessions?before=&beforeId=&limit=   ·  GET /v1/gym/sessions/:id
//   GET  /v1/gym/sessions/:id/review  ·  GET /v1/gym/last?exercise=
//   GET  /v1/gym/routines             ·  POST /v1/gym/routines
//   PUT  /v1/gym/routines/:id         ·  DELETE /v1/gym/routines/:id
//   GET  /v1/gym/stats
//   POST /v1/gym/sessions/:id/share   ·  DELETE /v1/gym/sessions/:id/share
// The session rides as a Bearer header rather than a cookie (WindmillApi); nothing else differs.
//
// `GET /v1/gym/shared/:token` — the coach's own read, and the one unauthenticated route in the
// product — is deliberately NOT here. Nothing on this phone reads a shared session: the lifter is
// the owner and reads their own log through the sixteen owner-scoped doors above. The token this
// client mints is spelled as an address for somebody else to open (CoachShare.swift).
//
// EVERY PATH IS PASSED WHOLE, query included. `appendingPathComponent` treats the whole string as one
// segment and percent-encodes `?` and `&` into it, which silently 404'd the journal's window read and
// its delta feed — RequestURLTests in the platform suite exists to keep that fixed.

// What the room needs of the network, and nothing more. TrainingStore depends on this rather than on
// GymApi so the offline and refusal paths — the two that decide whether a set somebody lifted
// survives — can be driven in a test without a server, a socket, or a stubbed URLProtocol.
public protocol TrainingSyncing {
    func exercises() async throws -> [Exercise]
    func createExercise(_ write: ExerciseWrite) async throws -> Exercise

    func startSession(_ start: SessionStart) async throws -> Session
    func appendSet(to sessionId: String, _ write: SetWrite) async throws -> TrainingSet
    func finishSession(_ sessionId: String, at finishedAtMs: Int64) async throws -> Session
    func discardSession(_ sessionId: String) async throws

    func sessions(before: Int64?, beforeId: String?, limit: Int) async throws -> [SessionSummary]
    func session(_ id: String) async throws -> SessionDetail?
    func review(of sessionId: String) async throws -> Review
    func lastTime(_ exerciseId: String) async throws -> LastTime

    func routines() async throws -> [Routine]
    func routine(_ id: String) async throws -> Routine?
    func createRoutine(_ write: RoutineWrite) async throws -> Routine
    func replaceRoutine(_ id: String, with write: RoutineWrite) async throws -> Routine
    func deleteRoutine(_ id: String) async throws

    func statistics() async throws -> TrainingStatistics
    func share(_ sessionId: String) async throws -> SessionShare
    func revokeShare(_ sessionId: String) async throws
}

public struct GymApi: TrainingSyncing {
    private let api: WindmillApi

    public init(api: WindmillApi) {
        self.api = api
    }

    public func exercises() async throws -> [Exercise] {
        try await api.get("/v1/gym/exercises", as: Catalog.self).exercises
    }

    public func createExercise(_ write: ExerciseWrite) async throws -> Exercise {
        try await api.send("POST", "/v1/gym/exercises", body: write, as: Exercise.self)
    }

    // A start JOINS whatever session is already open, so the session that comes back may not be the
    // one that went out — the caller has to compare the ids rather than assume.
    public func startSession(_ start: SessionStart) async throws -> Session {
        try await api.send("POST", "/v1/gym/sessions", body: start, as: Session.self)
    }

    // Converges on exactly one row per minted id: a replay answers 200 with the stored set and its
    // server-assigned number, whether or not the session has since been finished.
    public func appendSet(to sessionId: String, _ write: SetWrite) async throws -> TrainingSet {
        try await api.send("POST", "/v1/gym/sessions/\(sessionId)/sets", body: write, as: TrainingSet.self)
    }

    public func finishSession(_ sessionId: String, at finishedAtMs: Int64) async throws -> Session {
        try await api.send("POST", "/v1/gym/sessions/\(sessionId)/finish",
                           body: SessionFinish(finishedAtMs: finishedAtMs), as: Session.self)
    }

    // Discard — the one destructive action in the product. It refuses a LIVE session 409
    // `session-open`, because only the device holding the queue knows every set landed, so the
    // finish screen is the only place it is offered.
    public func discardSession(_ sessionId: String) async throws {
        try await api.send("DELETE", "/v1/gym/sessions/\(sessionId)")
    }

    // A page of the log, newest first. The cursor is BOTH halves of the sort key: two sessions can
    // share an instant, and an instant alone would repeat one across the page edge or skip it.
    public func sessions(before: Int64?, beforeId: String?, limit: Int) async throws -> [SessionSummary] {
        var query = "?limit=\(limit)"
        if let before { query += "&before=\(before)" }
        if let beforeId { query += "&beforeId=\(escaped(beforeId))" }
        return try await api.get("/v1/gym/sessions\(query)", as: Log.self).sessions
    }

    // One session and its sets. Absent and another account's are the same 404, and that is not an
    // error — the caller draws nothing — so the absence is folded into the type rather than thrown.
    public func session(_ id: String) async throws -> SessionDetail? {
        do {
            return try await api.get("/v1/gym/sessions/\(id)", as: SessionDetail.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    public func review(of sessionId: String) async throws -> Review {
        try await api.get("/v1/gym/sessions/\(sessionId)/review", as: Review.self)
    }

    // The prefill. A movement trained for the first time is answered 200 with the movement and
    // nothing else, so this never folds a 404 — a 404 here would mean the movement does not exist,
    // which is a different and false thing.
    public func lastTime(_ exerciseId: String) async throws -> LastTime {
        try await api.get("/v1/gym/last?exercise=\(escaped(exerciseId))", as: LastTime.self)
    }

    public func routines() async throws -> [Routine] {
        try await api.get("/v1/gym/routines", as: Routines.self).routines
    }

    // The read half of a read-modify-write. Absent and another account's are the same 404, one fact,
    // so the absence folds into the type exactly as a session's does.
    public func routine(_ id: String) async throws -> Routine? {
        do {
            return try await api.get("/v1/gym/routines/\(id)", as: Routine.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    public func createRoutine(_ write: RoutineWrite) async throws -> Routine {
        try await api.send("POST", "/v1/gym/routines", body: write, as: Routine.self)
    }

    // A whole-document replace: the body is the routine as it should now stand, so a read-modify-write
    // that dropped a line would delete it.
    public func replaceRoutine(_ id: String, with write: RoutineWrite) async throws -> Routine {
        try await api.send("PUT", "/v1/gym/routines/\(id)", body: write, as: Routine.self)
    }

    public func deleteRoutine(_ id: String) async throws {
        try await api.send("DELETE", "/v1/gym/routines/\(id)")
    }

    // The long window, computed on every read and cached nowhere — server-side or here. There is no
    // parameter: the window is the whole finished log, and a client that asked for a slice of it
    // would be the second place in the product deciding what a week is.
    public func statistics() async throws -> TrainingStatistics {
        try await api.get("/v1/gym/stats", as: TrainingStatistics.self)
    }

    // Idempotent on the SESSION and not on a client-minted id — there is no id for a client to mint
    // here, because the token is unguessable and therefore the server's to make. Tapping Share twice
    // answers with the link already live, so a lifter never sends two capabilities to revoke apart.
    public func share(_ sessionId: String) async throws -> SessionShare {
        try await api.send("POST", "/v1/gym/sessions/\(sessionId)/share", as: SessionShare.self)
    }

    // Revoked is deleted: the row IS the capability, so there is nothing to mark and nothing left to
    // describe. Nothing to revoke answers the same 404 an absent session gives.
    public func revokeShare(_ sessionId: String) async throws {
        try await api.send("DELETE", "/v1/gym/sessions/\(sessionId)/share")
    }

    // Ids are [A-Za-z0-9_-] by the server's own rule, so this only ever has work to do on the two
    // punctuation marks in that set — and doing it anyway costs nothing and cannot be forgotten
    // later, when an id from somewhere else reaches a query string.
    private func escaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    private struct Catalog: Decodable { let exercises: [Exercise] }
    private struct Log: Decodable { let sessions: [SessionSummary] }
    private struct Routines: Decodable { let routines: [Routine] }
}
