import Foundation
import DomainKit
import GymDomain
import SyncCore
import SyncSchema

// The signed-out onboarding answers earlier versions kept on this phone: their shape, so an archived conversation still
// draws them, and the one door they keep, applying the routines an answer drafted.

nonisolated struct CoachOnboardingIn: Codable, Equatable, Sendable {
  struct Image: Codable, Equatable, Sendable { let mimeType: String; let data: String }
  let requestId: String
  let mode: String
  var goal: String?
  var daysPerWeek: Int?
  var equipment: String?
  var program: String?
  var image: Image?
  var note: String?
  struct Context: Codable, Equatable, Sendable { let role: String; let text: String }
  var text: String?
  var context: [Context]?
  var question: String { text ?? goal ?? program ?? note ?? "Turn this program into routines." }
}

nonisolated struct CoachOnboardingOut: Codable, Equatable, Sendable {
  struct Routine: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable {
      struct Set: Codable, Equatable, Sendable { let reps: Int?; let weightKg: Double? }
      let exerciseId: String
      let sets: [Set]
      let restSeconds: Int?
    }
    let name: String
    let entries: [Entry]
    var domain: CoachRoutine {
      CoachRoutine(name: name, entries: entries.map { entry in
        RoutineEntry(exerciseId: ID(RecordID(entry.exerciseId)), sets: entry.sets.isEmpty ? nil : entry.sets.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) }, restSeconds: entry.restSeconds)
      })
    }
  }
  let requestId: String
  let resultId: String
  let status: String
  let expiresAtMs: Int64
  let routines: [Routine]
  let errorCode: String?
  let allowance: AiAllowance
  var message: String?
  // The answer needed an account — a change to a routine, a note — so Coach said so and offered Sign in under it.
  var needsAccount: Bool?
}

nonisolated struct CoachOnboardingRecord: Codable, Equatable, Identifiable {
  let request: CoachOnboardingIn
  var photo: CoachAttachment?
  var response: CoachOnboardingOut?
  var results: [CoachResult] = []
  var stopped = false
  var refusalCode: String?
  var id: String { request.requestId }
  var finished: Bool { refusalCode != nil || !results.isEmpty || response?.status == "completed" || response?.status == "failed" || response?.status == "expired" }
}

extension CoachConversation {
  // Signed out, the newest answer that needs an account offers Sign in; once signed in, its adopted answer offers nothing.
  func offersSignIn(_ record: CoachOnboardingRecord) -> Bool {
    anonymous && record.response?.needsAccount == true && record.id == saved.onboarding?.last?.id
  }
  // The signed-out allowance a question was refused on, said only while signed out: an account has its own allowance.
  func spentAllowance(_ record: CoachOnboardingRecord) -> AiAllowance? {
    guard anonymous, let response = record.response, response.status == "failed", AiAllowance.refusalCodes.contains(response.errorCode ?? "") else { return nil }
    return response.allowance
  }

  // Apply on an archived answer's drafts: one gesture, replayed by the result identity so a retry makes no new routines.
  func importOnboarding(_ record: CoachOnboardingRecord, owner: String) throws {
    guard self.owner == owner, allowed, let response = record.response, response.status == "completed" else { throw CancellationError() }
    let refused = AppFailure(message: "These routines couldn’t be saved. Your response is kept; try again.")
    let result: Outcome<CoachImportReceipt, GymRefusal>
    do {
      let replica = try gym.runner.read(Gym.scope) { $0.replica }
      let drafts = response.routines.map(\.domain).map { routine in
        CoachRoutineImport(id: gym.runner.mint(Routine.self), name: routine.name, entries: routine.entries)
      }
      result = try gym.runner.run(ImportCoachRoutineBatch(replica: replica, resultId: response.resultId, drafts: drafts, at: gym.runner.moment()))
    } catch is Violation {
      throw refused
    } catch {
      gym.report("gym_action", error)
      gym.telemetry.event("gym_action", properties: ["screen": "coach", "outcome": "failed"])
      throw AppFailure(message: "Your routines couldn’t be saved. The response is kept on this phone; try again.")
    }
    guard let ids = result.value?.routines else { throw refused }
    guard ids.count == response.routines.count else { throw URLError(.badServerResponse) }
    var completed = record
    completed.results = zip(ids, response.routines).enumerated().map { index, item in
      CoachResult(kind: "routine-created", operationId: response.resultId + "-" + String(index), routineId: item.0.description,
        routineName: item.1.name, movementCount: item.1.entries.count)
    }
    var next = saved; if let index = next.onboarding?.firstIndex(where: { $0.id == record.id }) { next.onboarding?[index] = completed }
    guard keep(next, failure: "Your routines are saved. Check the response to restore their links.") else { throw AppFailure(message: "Your routines are saved. Check the response to restore their links.") }
    gym.refresh()
    gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "routines_saved"])
  }
}
