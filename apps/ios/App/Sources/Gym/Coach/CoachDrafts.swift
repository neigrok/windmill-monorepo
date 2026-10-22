import SwiftUI
import DomainKit
import GymDomain

// One save of new routines: a server-held draft by its request and operation, or the phone's own drafts by their request.
struct CoachRoutineReview: Identifiable {
  let id: String
  let requestId: String?
  let drafts: [CoachRoutine]
  let operationId: String?
  // A signed-in draft is saved by its request and operation; one that arrived without its request cannot be.
  var savable: Bool { operationId == nil || requestId != nil }
}

// What a save came to: saved, a kept note that leaves Apply for another try, or a closed note that retires it.
enum CoachRoutineSave: Equatable { case saved, kept(String), closed(String) }

// Coach's new routines, decided on one card under its answer: each routine a heading that opens in place to its movements
// as added blocks — one open at a time — then Apply, which saves every routine, and Reject, which drops them here.
struct CoachDraftsCard: View {
  let coach: CoachConversation
  // The card's key, its request: what Reject records.
  let id: String
  let routines: [CoachRoutine]
  // What Apply saves, in order: each server-held draft by its operation, or the phone's own drafts at once.
  let saves: [CoachRoutineReview]
  @State var open = 0
  @State var busy = false
  @State var note: String?
  @State var closed = false
  var gym: GymModel { coach.gym }
  var count: String { GymCount.of(routines.count, "routine") }
  var body: some View {
    if coach.saved.rejectedDrafts?.contains(id) == true {
      Label("Rejected · " + count, systemImage: "xmark").labelStyle(ChangeBadgeStyle()).font(.subheadline).foregroundStyle(GymPalette.inkDim)
        .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading)
        .accessibilityElement(children: .combine).accessibilityIdentifier("coach-drafts-rejected")
    } else { card }
  }
  var card: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(routines.count == 1 ? "1 new routine" : "\(routines.count) new routines").font(.footnote.weight(.semibold)).textCase(.uppercase)
        .foregroundStyle(GymPalette.accent).padding(.bottom, 12)
      ForEach(Array(routines.enumerated()), id: \.offset) { index, routine in
        Divider().overlay(GymPalette.line)
        heading(routine, index: index)
        if routines.count == 1 || open == index {
          ForEach(Array(routine.entries.enumerated()), id: \.offset) { _, entry in
            Divider().overlay(GymPalette.line)
            ChangeBlock(kind: .added, title: gym.catalogue.find(entry.exerciseId)?.name ?? "New movement",
                        fields: ProposalDiff.fields(before: nil, after: EntryTargets(entry), each: gym.catalogue.find(entry.exerciseId).map { $0.equipment == "dumbbell" && $0.loadCount == 2 } ?? false))
              .padding(.vertical, 14)
          }
        }
      }
      if let note = note ?? (saves.allSatisfy(\.savable) ? nil : CoachCopy.draftUnsavable) {
        Text(note).font(.subheadline).foregroundStyle(GymPalette.inkDim).padding(.top, 14).accessibilityIdentifier("coach-save-routines-note")
      }
      VStack(spacing: 10) {
        Button { apply() } label: {
          HStack(spacing: RoomSpace.related) { if busy { ProgressView().tint(GymPalette.onAccent) }; Text("Apply") }
        }.buttonStyle(ChangeCardButtonStyle(prominent: true)).disabled(busy || closed || !saves.allSatisfy(\.savable))
          .accessibilityIdentifier("coach-save-routines")
        Button("Reject") { coach.rejectDrafts(id) }.buttonStyle(ChangeCardButtonStyle()).disabled(busy).accessibilityIdentifier("coach-reject-routines")
      }.padding(.top, 16)
    }.modifier(ChangeCard(stroke: GymPalette.accent)).accessibilityElement(children: .contain).accessibilityIdentifier("coach-drafts")
  }
  // *Full body A* over its movements while it is open; closed, *3 movements* and the door chevron. A lone routine has no chevron.
  @ViewBuilder func heading(_ routine: CoachRoutine, index: Int) -> some View {
    let title = Text(routine.name).font(.title3.weight(.semibold)).foregroundStyle(GymPalette.ink)
    if routines.count == 1 { title.frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading) }
    else {
      Button { withAnimation { open = index } } label: {
        HStack(spacing: RoomSpace.related) {
          title
          Spacer(minLength: 0)
          if open == index { Image(systemName: "chevron.down").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkDim) }
          else {
            Text(GymCount.of(routine.entries.count, "movement")).foregroundStyle(GymPalette.inkDim)
            DoorChevron(room: .gym)
          }
        }.frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityValue(open == index ? "expanded" : "collapsed").accessibilityIdentifier("coach-draft-\(index)")
    }
  }
  func apply() {
    busy = true; note = nil
    Task {
      defer { busy = false }
      for save in saves {
        switch await coach.saveRoutines(save) {
        case .saved: continue
        case .kept(let text): note = text; return
        case .closed(let text): note = text; closed = true; return
        }
      }
    }
  }
}

extension CoachConversation {
  // Reject drops the drafts on this phone: nothing was saved, so nothing needs the server.
  func rejectDrafts(_ id: String) {
    var next = saved; next.rejectedDrafts = (next.rejectedDrafts ?? []) + [id]
    if keep(next, failure: "Your choice couldn’t be saved. Try again.") { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "drafts_rejected"]) }
  }
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
