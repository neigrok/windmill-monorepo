import SwiftUI
import DomainKit
import GymDomain

struct CoachRoutineReview: Identifiable {
  let id: String
  let requestId: String?
  let drafts: [CoachRoutine]
  let operationId: String?
  // A signed-in draft is saved by its request and operation; one that arrived without its request cannot be.
  var savable: Bool { operationId == nil || requestId != nil }
}

// What a Save came to: saved closes the review, a kept note leaves Save for another try, a closed note retires it.
enum CoachRoutineSave: Equatable { case saved, kept(String), closed(String) }

struct CoachRoutineReviewSheet: View {
  let coach: CoachConversation
  let review: CoachRoutineReview
  @State var busy = false
  @State var note: String?
  @State var closed = false
  @Environment(\.dismiss) var dismiss
  var body: some View {
    NavigationStack {
      List {
        ForEach(Array(review.drafts.enumerated()), id: \.offset) { routineIndex, routine in
          Section(routine.name) {
            ForEach(Array(routine.entries.enumerated()), id: \.offset) { entryIndex, entry in
              let exercise = coach.gym.catalogue.find(entry.exerciseId)
              let basis = exercise.map(MovementEquipment.init)
              VStack(alignment: .leading, spacing: RoomSpace.small) {
                Text(exercise?.name ?? "New movement").font(.headline)
                if let basis { Label(basis.title, systemImage: basis.symbol).font(.subheadline).foregroundStyle(GymPalette.inkDim) }
                if let targets = entry.sets, !targets.isEmpty {
                  ForEach(Array(targets.enumerated()), id: \.offset) { index, target in
                    let values: [String?] = [target.reps.map { GymCount.of($0, "rep") },
                      target.weightKg.map { Readout.weight($0) + " " + (basis?.unit ?? "kg") }]
                    let line = "Set \(index + 1) · " + values.compactMap { $0 }.joined(separator: " · ")
                    let isLast = routineIndex == review.drafts.count - 1 && entryIndex == routine.entries.count - 1 && index == targets.count - 1
                    let identifier = isLast ? "coach-review-final-set" : "coach-review-set-\(routineIndex)-\(entryIndex)-\(index)"
                    Text(line)
                      .font(.subheadline).monospacedDigit()
                      .accessibilityIdentifier(identifier)
                  }
                } else { Text("Sets to choose").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
                if let rest = entry.restSeconds { Text("Rest \(rest) seconds").font(.footnote).foregroundStyle(GymPalette.inkDim) }
              }.padding(.vertical, RoomSpace.small)
            }
          }.listRowBackground(GymPalette.card)
        }
      }.listStyle(.insetGrouped).modifier(GymPage()).navigationTitle(review.drafts.count == 1 ? "Review routine" : "Review routines")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
        .reachBand(onSurface: true) {
          VStack(spacing: RoomSpace.small) {
            if let note = note ?? (review.savable ? nil : CoachCopy.draftUnsavable) {
              Text(note).font(.footnote).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("coach-save-routines-note")
            }
            if review.savable, !closed {
              Button {
                busy = true; note = nil
                Task {
                  defer { busy = false }
                  switch await coach.saveRoutines(review) {
                  case .saved: dismiss()
                  case .kept(let text): note = text
                  case .closed(let text): note = text; closed = true
                  }
                }
              } label: {
                HStack { if busy { ProgressView() }; Text(review.drafts.count == 1 ? "Save routine" : "Save routines") }
                  .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget)
              }.modifier(RoomPrimaryStyle(room: .gym)).disabled(busy).accessibilityIdentifier("coach-save-routines")
            }
          }.padding(RoomSpace.inset)
        }
    }.onAppear { coach.gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "review_routines"]) }
      .onDisappear { coach.gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "review_closed"]) }
  }
}

extension CoachConversation {
  // Signed in, Save confirms the server-held draft and reports started, then saved, refused (4xx) or failed (5xx or no answer).
  func saveRoutines(_ review: CoachRoutineReview) async -> CoachRoutineSave {
    guard let owner, allowed else { return .closed(CoachCopy.accountChanged) }
    guard let operation = review.operationId else {
      guard let record = saved.onboarding?.first(where: { $0.id == review.requestId }) else { return .closed(CoachCopy.draftGone) }
      do { try importOnboarding(record, owner: owner, generation: workGeneration); error = nil; return .saved }
      catch {
        gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "save_routines", "outcome": "failed"])
        if error is CancellationError { return .closed(CoachCopy.accountChanged) }
        return .kept((error as? AppFailure)?.message ?? CoachCopy.confirmRetry)
      }
    }
    guard !anonymous, let requestId = review.requestId else { return .closed(CoachCopy.draftUnsavable) }
    let thread = saved.threadId
    gym.telemetry.event("gym_coach_routine_confirm", properties: ["outcome": "started"])
    let response: CoachSnapshot
    do {
      let data = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(thread))/generations/\(CoachCopy.escaped(requestId))/routines/\(CoachCopy.escaped(operation))/confirm",
        method: "POST", body: Data("{}".utf8), expectedAccount: owner)
      response = try JSONDecoder().decode(CoachSnapshot.self, from: data)
      guard response.thread == thread, response.generation.requestId == requestId,
            response.generation.routineDrafts.contains(where: { $0.operationId == operation && $0.state == "saved" }) else { throw URLError(.badServerResponse) }
    } catch {
      if error is CancellationError || (error as? URLError)?.code == .cancelled { return self.owner == owner ? .kept(CoachCopy.confirmRetry) : .closed(CoachCopy.accountChanged) }
      if let status = (error as? GymRESTFailure)?.status, (400..<500).contains(status) {
        gym.telemetry.event("gym_coach_routine_confirm", properties: ["outcome": "refused"])
        switch status {
        case 404: return .closed(CoachCopy.draftGone)
        case 400, 422: return .closed(CoachCopy.draftUnsavable)
        case 401: return .kept(CoachCopy.draftSignIn)
        default: return .kept(CoachCopy.confirmRetry)
        }
      }
      gym.telemetry.event("gym_coach_routine_confirm", properties: ["outcome": "failed"])
      if error is DecodingError || (error as? URLError)?.code == .badServerResponse { gym.report("gym_rest", error) }
      return .kept(CoachCopy.confirmRetry)
    }
    gym.telemetry.event("gym_coach_routine_confirm", properties: ["outcome": "saved"])
    CoachFixture.applySetupResults(response.generation.results, gym: gym)
    gym.refresh()
    guard self.owner == owner, allowed else { return .closed(CoachCopy.accountChanged) }
    guard saved.threadId == thread else { return .saved }
    var next = saved
    if next.generation?.requestId == requestId { next.generation = response.generation }
    if next.thread?.generation?.requestId == requestId { next.thread?.generation = response.generation }
    if let index = next.exchanges.firstIndex(where: { $0.requestId == requestId }) { next.exchanges[index] = response.generation }
    if let index = next.thread?.turns.firstIndex(where: { $0.from != "lifter" && $0.generationId == response.generation.id }) {
      next.thread?.turns[index].routineDrafts = response.generation.routineDrafts
      next.thread?.turns[index].results = response.generation.results
    }
    let relink = "The routine was saved. Retry to restore its link."
    guard keep(next, failure: relink) else { return .kept(relink) }
    gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "routines_saved"])
    error = nil
    return .saved
  }
}
