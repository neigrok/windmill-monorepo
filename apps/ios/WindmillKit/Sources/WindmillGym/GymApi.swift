import Foundation
import WindmillPlatform

// Every path is passed whole, query included: `appendingPathComponent` treats the whole string as
// one segment and percent-encodes `?` and `&` into it.

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

    public func renameExercise(_ exerciseId: String, to name: String) async throws -> Exercise? {
        do {
            return try await api.send("PATCH", "/v1/gym/exercises/\(exerciseId)",
                                      body: ExerciseRename(name: name), as: Exercise.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    public func record(of exerciseId: String) async throws -> MovementRecord? {
        do {
            return try await api.get("/v1/gym/exercises/\(exerciseId)/record", as: MovementRecord.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    // A start joins whatever session is already open: compare the ids on the reply.
    public func startSession(_ start: SessionStart) async throws -> Session {
        try await api.send("POST", "/v1/gym/sessions", body: start, as: Session.self)
    }

    // A replay answers 200 with the stored set and its server-assigned number, finished or not.
    public func appendSet(to sessionId: String, _ write: SetWrite) async throws -> TrainingSet {
        try await api.send("POST", "/v1/gym/sessions/\(sessionId)/sets", body: write, as: TrainingSet.self)
    }

    // Its 404 is thrown rather than folded: `set-not-found` is a correction that will never land.
    public func fixSet(_ setId: String, in sessionId: String, _ fix: SetFix) async throws -> TrainingSet {
        try await api.send("PATCH", "/v1/gym/sessions/\(sessionId)/sets/\(setId)",
                           body: fix, as: TrainingSet.self)
    }

    // 204 however the truth is spelled, so a reply lost on the way back is safe to send again.
    public func deleteSet(_ setId: String, in sessionId: String) async throws {
        try await api.send("DELETE", "/v1/gym/sessions/\(sessionId)/sets/\(setId)")
    }

    public func finishSession(_ sessionId: String, at finishedAtMs: Int64) async throws -> Session {
        try await api.send("POST", "/v1/gym/sessions/\(sessionId)/finish",
                           body: SessionFinish(finishedAtMs: finishedAtMs), as: Session.self)
    }

    public func discardSession(_ sessionId: String) async throws {
        try await api.send("DELETE", "/v1/gym/sessions/\(sessionId)")
    }

    // Newest first. The cursor is both halves of the sort key: two sessions can share an instant.
    public func sessions(before: Int64?, beforeId: String?, limit: Int) async throws -> [SessionSummary] {
        var query = "?limit=\(limit)"
        if let before { query += "&before=\(before)" }
        if let beforeId { query += "&beforeId=\(escaped(beforeId))" }
        return try await api.get("/v1/gym/sessions\(query)", as: Log.self).sessions
    }

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

    // A movement trained for the first time answers 200 with the movement and nothing else; a 404
    // here means the movement does not exist.
    public func lastTime(_ exerciseId: String) async throws -> LastTime {
        try await api.get("/v1/gym/last?exercise=\(escaped(exerciseId))", as: LastTime.self)
    }

    public func lastSets() async throws -> [LastSet] {
        try await api.get("/v1/gym/exercises/last", as: LastSets.self).movements
    }

    public func routines() async throws -> [Routine] {
        try await api.get("/v1/gym/routines", as: Routines.self).routines
    }

    // The only read that carries a routine's `history`; the list read has none.
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

    // A whole-document replace: a dropped line is a deleted line.
    public func replaceRoutine(_ id: String, with write: RoutineWrite) async throws -> Routine {
        try await api.send("PUT", "/v1/gym/routines/\(id)", body: write, as: Routine.self)
    }

    public func deleteRoutine(_ id: String) async throws {
        try await api.send("DELETE", "/v1/gym/routines/\(id)")
    }

    public func proposals() async throws -> [ProposalHead] {
        try await api.get("/v1/gym/proposals", as: Ledger.self).proposals
    }

    public func proposal(_ id: String) async throws -> Proposal? {
        do {
            return try await api.get("/v1/gym/proposals/\(id)", as: Proposal.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    // Atomic against the base the diff was written on: a routine that moved underneath is refused 409
    // rather than merged, thrown whole because here a 409 is an answer.
    public func applyProposal(_ id: String) async throws -> AppliedProposal {
        try await api.send("POST", "/v1/gym/proposals/\(id)/apply", as: AppliedProposal.self)
    }

    public func dismissProposal(_ id: String) async throws -> Proposal {
        try await api.send("POST", "/v1/gym/proposals/\(id)/dismiss", as: Settled.self).proposal
    }

    // Idempotent on the session: the token is the server's, and tapping twice answers the live link.
    public func share(_ sessionId: String) async throws -> SessionShare {
        try await api.send("POST", "/v1/gym/sessions/\(sessionId)/share", as: SessionShare.self)
    }

    // The row is the capability, so revoked is deleted; nothing to revoke answers 404.
    public func revokeShare(_ sessionId: String) async throws {
        try await api.send("DELETE", "/v1/gym/sessions/\(sessionId)/share")
    }

    // Never 404s: an account that has never opened the screen is served the defaults.
    public func preferences() async throws -> GymPreferences {
        try await api.get("/v1/gym/preferences", as: GymPreferences.self)
    }

    // A whole-document replace, last write wins. Draw the reply, never what went out.
    public func savePreferences(_ preferences: GymPreferences) async throws -> GymPreferences {
        try await api.send("PUT", "/v1/gym/preferences", body: preferences, as: GymPreferences.self)
    }

    // The server keeps the conversation, so this sends the question and its thread id and never a
    // turns array: a fresh id opens a conversation, a known one continues it.
    public func ask(_ question: String, in threadId: String) async throws -> AskAnswer {
        try await api.send("POST", "/v1/gym/ask",
                           body: AskRequest(thread: threadId, question: question), as: AskAnswer.self)
    }

    // Newest-asked first. The server serves at most one page and sends no total, so nothing here
    // can count the account.
    public func threads() async throws -> [AskThread] {
        try await api.get("/v1/gym/threads", as: ThreadList.self).threads
    }

    public func thread(_ id: String) async throws -> AskThread? {
        do {
            return try await api.get("/v1/gym/threads/\(id)", as: AskThread.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    // Deleting takes the conversation and not the consequence: a proposal it minted outlives it.
    public func deleteThread(_ id: String) async throws {
        do {
            try await api.send("DELETE", "/v1/gym/threads/\(id)")
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return }
            throw error
        }
    }

    // Sorted by position; an account with none answers an empty list.
    public func notes() async throws -> [Note] {
        try await api.get("/v1/gym/notes", as: NoteList.self).notes
    }

    // Upsert by the id this client minted: a replay with the same body answers the stored row.
    public func writeNote(_ id: String, _ write: NoteWrite) async throws -> Note {
        try await api.send("PUT", "/v1/gym/notes/\(id)", body: write, as: SavedNote.self).note
    }

    // 204 whether or not the row was still there.
    public func deleteNote(_ id: String) async throws {
        try await api.send("DELETE", "/v1/gym/notes/\(id)")
    }

    // Whole-order replace: every note of the account, exactly once.
    public func reorderNotes(_ order: [String]) async throws -> [Note] {
        try await api.send("PUT", "/v1/gym/notes", body: NoteOrder(order: order), as: NoteList.self).notes
    }

    private func escaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }

    private struct AskRequest: Encodable { let thread: String; let question: String }
    private struct ThreadList: Decodable { let threads: [AskThread] }
    private struct NoteList: Decodable { let notes: [Note] }
    private struct SavedNote: Decodable { let note: Note }
    private struct NoteOrder: Encodable { let order: [String] }
    private struct Catalog: Decodable { let exercises: [Exercise] }
    private struct LastSets: Decodable { let movements: [LastSet] }
    private struct Log: Decodable { let sessions: [SessionSummary] }
    private struct Routines: Decodable { let routines: [Routine] }
    private struct Ledger: Decodable { let proposals: [ProposalHead] }
    private struct Settled: Decodable { let proposal: Proposal }
}
