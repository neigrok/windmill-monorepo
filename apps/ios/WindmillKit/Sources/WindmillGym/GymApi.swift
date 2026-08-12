import Foundation
import WindmillPlatform

// The one place the native gym talks to the backend — the twin of web/src/products/gym/gymApi.js,
// against the same routes:
//   GET  /v1/gym/exercises            ·  POST /v1/gym/exercises
//   PATCH /v1/gym/exercises/:id       ·  GET /v1/gym/exercises/:id/record
//   POST /v1/gym/sessions             ·  POST /v1/gym/sessions/:id/sets
//   PATCH /v1/gym/sessions/:id/sets/:setId  ·  DELETE /v1/gym/sessions/:id/sets/:setId
//   POST /v1/gym/sessions/:id/finish  ·  DELETE /v1/gym/sessions/:id
//   GET  /v1/gym/sessions?before=&beforeId=&limit=   ·  GET /v1/gym/sessions/:id
//   GET  /v1/gym/sessions/:id/review  ·  GET /v1/gym/last?exercise=
//   GET  /v1/gym/exercises/last
//   GET  /v1/gym/routines             ·  POST /v1/gym/routines
//   PUT  /v1/gym/routines/:id         ·  DELETE /v1/gym/routines/:id
//   GET  /v1/gym/proposals            ·  GET /v1/gym/proposals/:id
//   POST /v1/gym/proposals/:id/apply  ·  POST /v1/gym/proposals/:id/dismiss
//   POST /v1/gym/sessions/:id/share   ·  DELETE /v1/gym/sessions/:id/share
//   GET  /v1/gym/preferences          ·  PUT /v1/gym/preferences
//   POST /v1/gym/ask
//
// `GET /v1/gym/stats` is NOT here and its absence is deliberate: the statistics ENGINE stays on the
// server, where an agent asking "how has my squat moved" reads it through `get_stats`, but the room
// it fed was retired with the board (W1c). What this phone asks for now is one movement's record.
// The session rides as a Bearer header rather than a cookie (WindmillApi); nothing else differs.
//
// `GET /v1/gym/shared/:token` — the coach's own read, and the one unauthenticated route in the
// product — is deliberately NOT here. Nothing on this phone reads a shared session: the lifter is
// the owner and reads their own log through the owner-scoped doors above. The token this client
// mints is spelled as an address for somebody else to open (CoachShare.swift).
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
    func renameExercise(_ exerciseId: String, to name: String) async throws -> Exercise?
    func record(of exerciseId: String) async throws -> MovementRecord?

    func startSession(_ start: SessionStart) async throws -> Session
    func appendSet(to sessionId: String, _ write: SetWrite) async throws -> TrainingSet
    func fixSet(_ setId: String, in sessionId: String, _ fix: SetFix) async throws -> TrainingSet
    func deleteSet(_ setId: String, in sessionId: String) async throws
    func finishSession(_ sessionId: String, at finishedAtMs: Int64) async throws -> Session
    func discardSession(_ sessionId: String) async throws

    func sessions(before: Int64?, beforeId: String?, limit: Int) async throws -> [SessionSummary]
    func session(_ id: String) async throws -> SessionDetail?
    func review(of sessionId: String) async throws -> Review
    func lastTime(_ exerciseId: String) async throws -> LastTime
    func lastSets() async throws -> [LastSet]

    func routines() async throws -> [Routine]
    func routine(_ id: String) async throws -> Routine?
    func createRoutine(_ write: RoutineWrite) async throws -> Routine
    func replaceRoutine(_ id: String, with write: RoutineWrite) async throws -> Routine
    func deleteRoutine(_ id: String) async throws

    func proposals() async throws -> [ProposalHead]
    func proposal(_ id: String) async throws -> Proposal?
    func applyProposal(_ id: String) async throws -> AppliedProposal
    func dismissProposal(_ id: String) async throws -> Proposal

    func share(_ sessionId: String) async throws -> SessionShare
    func revokeShare(_ sessionId: String) async throws

    func preferences() async throws -> GymPreferences
    func savePreferences(_ preferences: GymPreferences) async throws -> GymPreferences
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

    // ONE FIELD, and the id it answers with is the id that went out — that is the promise the record
    // page exists to make visible. A movement this account did not create keeps its global row and
    // gains a per-account display name on the server; from here both are one call and one answer.
    // Absent and another account's are the same 404, folded into the type as every other read folds
    // it, because the caller draws nothing either way.
    public func renameExercise(_ exerciseId: String, to name: String) async throws -> Exercise? {
        do {
            return try await api.send("PATCH", "/v1/gym/exercises/\(exerciseId)",
                                      body: ExerciseRename(name: name), as: Exercise.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    // One movement's whole record — the counts, the two standing bests, the twelve-week series, the
    // record ladder and the recent days, in ONE read. The window is the server's: a client that asked
    // for a slice of it would be the second place in the product deciding what twelve weeks is.
    public func record(of exerciseId: String) async throws -> MovementRecord? {
        do {
            return try await api.get("/v1/gym/exercises/\(exerciseId)/record", as: MovementRecord.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
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

    // THE ONE WRITE THAT MOVES A SET THAT ALREADY STANDS (§G18). It answers the stored row, so the
    // same body sent again comes back byte-identical and the queue may send it any number of times.
    // The log moves and the program does not: nothing on this route can reach a frozen plan snapshot
    // or a routine.
    //
    // Unlike every read above, its 404 is THROWN rather than folded into the type. The queue tells
    // writes apart by CODE, and `set-not-found` is a correction that will never land — a fact the
    // lifter is owed out loud — where an absent READ is only a screen that draws nothing.
    public func fixSet(_ setId: String, in sessionId: String, _ fix: SetFix) async throws -> TrainingSet {
        try await api.send("PATCH", "/v1/gym/sessions/\(sessionId)/sets/\(setId)",
                           body: fix, as: TrainingSet.self)
    }

    // 204, and it says the same 204 however the truth is spelled: already gone, never there, another
    // account's. Absent stays byte-identical to forbidden, and a reply lost on the way back is safe
    // to send again — which is the whole reason this route carries no 400, no 404 and no 409.
    public func deleteSet(_ setId: String, in sessionId: String) async throws {
        try await api.send("DELETE", "/v1/gym/sessions/\(sessionId)/sets/\(setId)")
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

    // The picker's meta: every movement's last line in ONE read, sparse — only the movements this
    // account has trained come back, and a movement that is absent is one it never has. Sixty-two
    // calls to `lastTime` would be the same answer and the N+1 the log read already refused once.
    //
    // It is a PICKER-OPEN read and never a per-keystroke one: the live filter runs over the catalog
    // this client already holds, and these join onto it by id. `last` cannot collide with a movement
    // id: nothing a lifter mints can be shorter than eight characters (`wellFormedId`,
    // backend/products/gym/domain/Training.cpp), and none of the sixty-four seeds — which ARE
    // shorter, `dip` and `plank` among them — is called that. So this route stays reachable however
    // many movements a lifter mints.
    public func lastSets() async throws -> [LastSet] {
        try await api.get("/v1/gym/exercises/last", as: LastSets.self).movements
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

    // EVERY PROPOSAL ON THE ACCOUNT, newest first, in ONE read — pending and settled together,
    // because the room needs both: the pending ones are the cards that wait on Today and on the
    // routine, and the settled ones are the routine's History. The route can filter by routine and
    // by state and this client asks for neither: one read answers every card and every history row,
    // where a filter per routine would be the N+1 the picker's own meta already refused.
    //
    // There is no signed-out half of this route and no 404 to fold: no account, no proposal.
    public func proposals() async throws -> [ProposalHead] {
        try await api.get("/v1/gym/proposals", as: Ledger.self).proposals
    }

    // The whole diff. Absent, another account's and never-existed are the same 404, one fact, so the
    // absence folds into the type exactly as a routine's and a session's do.
    public func proposal(_ id: String) async throws -> Proposal? {
        do {
            return try await api.get("/v1/gym/proposals/\(id)", as: Proposal.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    // THE TAP. It is atomic against the base the diff was written on: a routine that moved
    // underneath is refused 409 rather than merged over the top, and asking again for a decision
    // already taken REPLAYS rather than erroring. Both refusals are thrown whole — the store reads
    // the code and decides, because this is the one call in gym where a 409 is the answer and not a
    // failure.
    public func applyProposal(_ id: String) async throws -> AppliedProposal {
        try await api.send("POST", "/v1/gym/proposals/\(id)/apply", as: AppliedProposal.self)
    }

    // Dismissing changes nothing and asks for no reason. It answers the settled row, because the
    // proposal stays on the routine as a dated record — the decision is part of the program's
    // history and not a card that vanishes.
    public func dismissProposal(_ id: String) async throws -> Proposal {
        try await api.send("POST", "/v1/gym/proposals/\(id)/dismiss", as: Settled.self).proposal
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

    // The settings document, and it NEVER 404s: an account that has never opened the screen is served
    // the defaults, so the room always has a rest dial and a plate set to draw. That is what lets the
    // absence of a stored row and the presence of a default one be the same thing to every caller.
    public func preferences() async throws -> GymPreferences {
        try await api.get("/v1/gym/preferences", as: GymPreferences.self)
    }

    // A whole-document replace, exactly as a routine's PUT is: the body is settings as they should now
    // stand, so a read-modify-write that dropped a field would reset it to its default rather than
    // leave it. The reply is the STORED document — draw that, never what went out — and last write
    // wins, which is what makes the claim's replay of this device's copy the one that stands.
    public func savePreferences(_ preferences: GymPreferences) async throws -> GymPreferences {
        try await api.send("PUT", "/v1/gym/preferences", body: preferences, as: GymPreferences.self)
    }

    // THE WHOLE THREAD, EVERY TIME. The server keeps no conversation — there is no table and no id
    // for one — so what this sends is the entire exchange it wants answered, and what comes back is
    // an answer with the accounting for the rows that produced it.
    //
    // It is deliberately NOT part of `TrainingSyncing`. That protocol is what the live session needs
    // of the network — the reads and writes a set's survival depends on, which is why the store owns
    // them, queues them and replays them. A question has none of that: nothing is minted, nothing is
    // owed, and a question nobody answered is simply a question nobody answered. Folding it into the
    // store would have put a chat inside the file that owns whether a lift is lost. It is a plain
    // method rather than a second protocol because nothing injects it: the room hands the screen a
    // closure over this call (`AskDoors.send`), so an abstraction with one conformer and no consumer
    // would be a seam that only looks like one.
    //
    // Nothing here is folded into an optional: an Ask that did not answer is never a screen that
    // draws nothing, it is a sentence the lifter is owed, and `AskRefusal` writes that sentence from
    // the status and whatever the server sent with it — the codes ride along on the wire and this
    // client branches on none of them, because every one of them reads the same to a lifter.
    public func ask(_ turns: [AskTurn]) async throws -> AskAnswer {
        try await api.send("POST", "/v1/gym/ask", body: AskRequest(turns: turns), as: AskAnswer.self)
    }

    // Ids are [A-Za-z0-9_-] by the server's own rule, so this only ever has work to do on the two
    // punctuation marks in that set — and doing it anyway costs nothing and cannot be forgotten
    // later, when an id from somewhere else reaches a query string.
    private func escaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    private struct AskRequest: Encodable { let turns: [AskTurn] }
    private struct Catalog: Decodable { let exercises: [Exercise] }
    private struct LastSets: Decodable { let movements: [LastSet] }
    private struct Log: Decodable { let sessions: [SessionSummary] }
    private struct Routines: Decodable { let routines: [Routine] }
    private struct Ledger: Decodable { let proposals: [ProposalHead] }
    private struct Settled: Decodable { let proposal: Proposal }
}
