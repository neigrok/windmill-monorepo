import SwiftUI
import DomainKit
import GymDomain

// Coach's new routines from an archived signed-out answer, decided on one card under it: each routine a heading that opens
// in place to its movements as added blocks — one open at a time — then Apply, which saves every routine on this phone,
// and Reject, which drops them here.
struct CoachDraftsCard: View {
  // What a save came to: saved, a kept note that leaves Apply for another try, or a closed note that retires it.
  enum Outcome: Equatable { case saved, kept(String), closed(String) }

  let coach: CoachConversation
  // The card's key, the answer's request: what Reject records and Apply imports.
  let id: String
  let routines: [CoachRoutine]
  @State var open = 0
  @State var busy = false
  @State var note: String?
  @State var closed = false
  var gym: GymModel { coach.gym }
  var count: String { GymCount.of(routines.count, "routine") }
  var body: some View {
    if coach.saved.rejectedDrafts?.contains(id) == true {
      RejectedLine(subject: count).accessibilityIdentifier("coach-drafts-rejected")
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
                        fields: ProposalDiff.fields(before: nil, after: EntryTargets(entry), each: MovementEquipment(gym.catalogue.find(entry.exerciseId)).each))
              .padding(.vertical, 14)
          }
        }
      }
      if let note {
        Text(note).font(.subheadline).foregroundStyle(GymPalette.inkDim).padding(.top, 14).accessibilityIdentifier("coach-save-routines-note")
      }
      VStack(spacing: 10) {
        Button { apply() } label: {
          HStack(spacing: RoomSpace.related) { if busy { ProgressView().tint(GymPalette.onAccent) }; Text("Apply") }
        }.buttonStyle(ChangeCardButtonStyle(prominent: true)).disabled(busy || closed)
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
    defer { busy = false }
    switch coach.saveRoutines(id) {
    case .saved: break
    case .kept(let text): note = text
    case .closed(let text): note = text; closed = true
    }
  }
}

extension CoachConversation {
  // Reject drops the drafts on this phone: nothing was saved, so nothing needs the server.
  func rejectDrafts(_ id: String) {
    var next = saved; next.rejectedDrafts = (next.rejectedDrafts ?? []) + [id]
    if keep(next, failure: "Your choice couldn’t be saved. Try again.") { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "drafts_rejected"]) }
  }
  // Apply saves the answer's routines on this phone, by the answer's own id, so a second Apply changes nothing.
  func saveRoutines(_ requestId: String) -> CoachDraftsCard.Outcome {
    guard let owner, allowed else { return .closed(CoachCopy.accountChanged) }
    guard let record = saved.onboarding?.first(where: { $0.id == requestId }) else { return .closed(CoachCopy.draftGone) }
    do { try importOnboarding(record, owner: owner); error = nil; return .saved }
    catch {
      gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "save_routines", "outcome": "failed"])
      if error is CancellationError { return .closed(CoachCopy.accountChanged) }
      return .kept((error as? AppFailure)?.message ?? CoachCopy.confirmRetry)
    }
  }
}
