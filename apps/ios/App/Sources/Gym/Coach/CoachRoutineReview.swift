import SwiftUI
import DomainKit
import GymDomain

struct CoachRoutineReview: Identifiable {
  let id: String
  let requestId: String
  let drafts: [CoachRoutine]
  let operationId: String?
}

struct CoachRoutineReviewSheet: View {
  let coach: CoachConversation
  let review: CoachRoutineReview
  @State var busy = false
  @State var error: String?
  @Environment(\.dismiss) var dismiss
  var body: some View {
    NavigationStack {
      List {
        ForEach(Array(review.drafts.enumerated()), id: \.offset) { routineIndex, routine in
          Section(routine.name) {
            ForEach(Array(routine.entries.enumerated()), id: \.offset) { entryIndex, entry in
              let exercise = coach.gym.catalogue.find(entry.exerciseId)
              let equipment = MovementEquipment(exercise?.equipment ?? "bodyweight")
              VStack(alignment: .leading, spacing: RoomSpace.small) {
                Text(exercise?.name ?? "Exercise unavailable").font(.headline)
                Label(equipment.title, systemImage: equipment.symbol).font(.subheadline).foregroundStyle(GymPalette.inkDim)
                if let targets = entry.sets, !targets.isEmpty {
                  ForEach(Array(targets.enumerated()), id: \.offset) { index, target in
                    let values: [String?] = [target.reps.map { GymCount.of($0, "rep") },
                      target.weightKg.map { Readout.weight($0) + " " + equipment.unit }]
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
            if let error { Text(error).font(.footnote).foregroundStyle(GymPalette.inkDim) }
            Button {
              busy = true; error = nil
              Task {
                defer { busy = false }
                if await coach.saveRoutines(review) { dismiss() }
                else { error = coach.error ?? "Your routine couldn’t be saved. Try again." }
              }
            } label: {
              HStack { if busy { ProgressView() }; Text(review.drafts.count == 1 ? "Save routine" : "Save routines") }
                .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget)
            }.modifier(RoomPrimaryStyle(room: .gym)).disabled(busy).accessibilityIdentifier("coach-save-routines")
          }.padding(RoomSpace.inset)
        }
    }.onAppear { coach.gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "review_routines"]) }
      .onDisappear { coach.gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "review_closed"]) }
  }
}

extension CoachConversation {
  func saveRoutines(_ review: CoachRoutineReview) async -> Bool {
    guard allowed, let owner else { return false }
    do {
      if let operation = review.operationId {
        guard !anonymous else { return false }
        let thread = saved.threadId
        let data = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(thread))/generations/\(CoachCopy.escaped(review.requestId))/routines/\(CoachCopy.escaped(operation))/confirm",
          method: "POST", body: Data("{}".utf8), expectedAccount: owner)
        guard self.owner == owner, allowed, saved.threadId == thread else { return false }
        let response = try JSONDecoder().decode(CoachSnapshot.self, from: data)
        guard response.thread == thread, response.generation.requestId == review.requestId,
              response.generation.routineDrafts.contains(where: { $0.operationId == operation && $0.state == "saved" }) else { throw URLError(.badServerResponse) }
        var next = saved
        if next.generation?.requestId == review.requestId { next.generation = response.generation }
        if next.thread?.generation?.requestId == review.requestId { next.thread?.generation = response.generation }
        if let index = next.exchanges.firstIndex(where: { $0.requestId == review.requestId }) { next.exchanges[index] = response.generation }
        if let index = next.thread?.turns.firstIndex(where: { $0.from != "lifter" && $0.generationId == response.generation.id }) {
          next.thread?.turns[index].routineDrafts = response.generation.routineDrafts
          next.thread?.turns[index].results = response.generation.results
        }
        guard keep(next, failure: "The routine was saved. Retry to restore its link.") else { return false }
        CoachFixture.applySetupResults(response.generation.results, gym: gym)
        gym.refresh()
        gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "routines_saved"])
      } else {
        guard let record = saved.onboarding?.first(where: { $0.id == review.requestId }) else { return false }
        try importOnboarding(record, owner: owner, generation: workGeneration)
      }
      error = nil
      return true
    } catch {
      self.error = "Your routine couldn’t be saved. The draft is kept; try again."
      if error is DecodingError || (error as? URLError)?.code == .badServerResponse { gym.report("gym_rest", error) }
      gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "save_routines", "outcome": "failed"])
      return false
    }
  }
}
