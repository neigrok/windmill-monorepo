import SwiftUI
import DomainKit
import GymDomain

// The Routines row's door to a proposal it lists, when the conversation on screen does not hold its card.
nonisolated struct CoachProposalID: Identifiable { let id: String }

// A proposal in the conversation, decided where it stands: its changes as blocks, the first two until *Show all*, the
// movements it leaves folded into one line, then Apply and Reject. Applied, it stays as the record of what changed;
// rejected, it folds to one line; out of date, it says why nothing was applied.
struct ProposalCard: View {
  let gym: GymModel
  let id: String
  var stallAfter: Duration = .seconds(15)
  @State var stalled = false
  @State var resent = 0
  @State var retrying = false
  @Environment(\.scenePhase) var phase

  init(gym: GymModel, id: String, stallAfter: Duration = .seconds(15)) { self.gym = gym; self.id = id; self.stallAfter = stallAfter }
  // Where the conversation scrolls to show this card.
  static func anchor(_ id: String) -> String { "coach-proposal-" + id }

  var proposal: Proposal? { gym.proposals.first { $0.id.record.string == id } }
  // The routine as the proposal found it, so an applied rename still reads *Applied · Push A*.
  var routineName: String { proposal?.baseName ?? proposal.flatMap(gym.coachRoutine)?.name ?? "Routine" }
  var removal: Bool { proposal?.intent == "remove" }
  // Only an Apply this phone sent that the log took bounces the check and plays the haptic, as it lands: never one refused
  // before it was sent, one applied elsewhere, or one that landed before this card was drawn.
  var landed: Bool { proposal.map { gym.landedCoachApplies.contains($0.id) } ?? false }
  // The decision the log has not answered yet, while it waits.
  var waiting: CoachQueuedDecision? { proposal.flatMap { gym.coachQueuedDecision($0.id) } }
  var pending: Bool { waiting != nil }
  var decidable: Bool {
    guard let proposal, proposal.state == "pending", !gym.coachProposalOutOfDate(proposal) else { return false }
    return !pending && gym.coachAccountAvailable && !gym.readFailed
  }
  var stance: ProposalStance { proposal.map(gym.coachProposalStance) ?? .open }
  // Why an out-of-date proposal has no buttons, said once where they stood.
  var outOfDate: String? {
    guard case .outOfDate(let reason) = stance else { return nil }
    return CoachCopy.outOfDateReason(reason, routine: routineName, catalogue: gym.catalogue)
  }
  // Why the Apply did not land, said once over the buttons, only from what the engine or the log answered: no network or
  // no answer to its push, or the log's refusal. A long wait alone states no cause.
  var failure: String? {
    guard let proposal, stance == .open, !retrying else { return nil }
    if pending { return gym.coachDecisionUnreached ? "No connection. " + CoachCopy.notApplied + "." : nil }
    return gym.coachApplyRefusal(proposal)
  }
  // Apply and Reject as the card draws them. Apply keeps its place through the wait: the act in flight until the log
  // answers, then Try again once the Apply failed, or once it has waited past the card's wait with the cause unknown.
  struct Decision: Equatable {
    let title: String
    let retries: Bool
    let applies: Bool
    let rejects: Bool
  }
  func decision(stalled: Bool) -> Decision {
    let retries = failure != nil || (pending && stalled && !retrying)
    let title = switch waiting {
    case _ where retries: "Try again"
    case nil, .reject: removal ? "Remove routine" : "Apply"
    case .apply: removal ? "Removing…" : "Applying…"
    case .unreadable: "Sending…"
    }
    return Decision(title: title, retries: retries, applies: retries || decidable, rejects: decidable)
  }

  var body: some View {
    Group {
      if let proposal {
        if stance == .rejected {
          RejectedLine(subject: routineName).accessibilityIdentifier("coach-proposal-header")
            .accessibilityValue(CoachCopy.settled("dismissed", removal: removal) ?? "")
        } else { card(proposal) }
      } else { Text("That proposal is gone.").font(.subheadline).foregroundStyle(GymPalette.inkDim).modifier(ChangeCard()) }
    }.sensoryFeedback(.success, trigger: landed)
      .onAppear { acknowledgeReceipt() }
      .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      .onChange(of: stance) { _, _ in acknowledgeReceipt() }
      .task(id: "\(pending):\(resent)") {
        stalled = false
        guard pending else { return }
        do { try await Task.sleep(for: stallAfter) } catch { return }
        guard let proposal else { return }
        stalled = gym.coachDecisionStalled(proposal.id)
      }
  }

  func card(_ proposal: Proposal) -> some View {
    let stance = stance
    let diff = gym.coachDiff(proposal)
    let blocks = removal ? [removalBlock(proposal)] : diff.blocks.map { ProposalChanges.Shown(kind: $0.kind, title: gym.coachTitle($0), fields: $0.fields) }
    let dimmed = outOfDate != nil
    return VStack(alignment: .leading, spacing: 0) {
      header(proposal, stance: stance)
      ProposalChanges(blocks: blocks, unchanged: removal ? 0 : diff.unchanged, count: gym.coachChangeCount(proposal), outOfDate: outOfDate,
                      identifier: "coach-proposal")
      if stance == .open {
        if let failure {
          Label(failure, systemImage: "exclamationmark.triangle").labelStyle(ChangeBadgeStyle()).font(.subheadline)
            .foregroundStyle(GymPalette.destructive).padding(.top, 14)
            .accessibilityElement(children: .combine).accessibilityIdentifier("coach-proposal-failure")
        }
        buttons(proposal)
      }
    }.modifier(ChangeCard(stroke: stance == .open ? GymPalette.accent : dimmed ? GymPalette.line : nil))
      .accessibilityElement(children: .contain).accessibilityIdentifier("coach-proposal")
  }

  // Waiting, *CHANGES TO PUSH A* with the store's count, or *REMOVE A ROUTINE*; applied, *✓ Applied · Push A*; out of
  // date, the eyebrow says so. While a workout is open a change waits for the routine's next workout, never this one (08.56).
  var eyebrow: String {
    if removal { return "Remove a routine" }
    if outOfDate != nil { return "Changes to " + routineName + " · " + CoachCopy.outOfDate }
    return "Changes to " + routineName + (gym.openSession != nil ? " · Next time" : "")
  }
  func header(_ proposal: Proposal, stance: ProposalStance) -> some View {
    let settled = outOfDate != nil ? CoachCopy.outOfDate : stance == .applied ? CoachCopy.settled("applied", removal: removal) : nil
    return HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
      if stance == .applied {
        // The check bounces in once, when the Apply this phone sent lands.
        HStack(spacing: RoomSpace.related) {
          Image(systemName: "checkmark.circle").symbolEffect(.bounce, value: landed).accessibilityHidden(true)
          Text("Applied · " + routineName + (removal ? " · routine removed" : ""))
        }.font(.headline).foregroundStyle(GymPalette.ink)
      } else {
        Text(eyebrow)
          .font(.footnote.weight(.semibold)).textCase(.uppercase).foregroundStyle(outOfDate != nil ? GymPalette.inkDim : GymPalette.accent)
      }
      Spacer(minLength: 0)
      if !removal { Text(GymCount.of(gym.coachChangeCount(proposal), "change")).font(.subheadline).foregroundStyle(GymPalette.inkDim) }
    }.padding(.bottom, 12).accessibilityElement(children: .combine)
      .accessibilityIdentifier("coach-proposal-header").accessibilityValue(settled ?? "")
  }

  // A removal's one block: the routine struck, how many movements go with it and when it was last done.
  func removalBlock(_ proposal: Proposal) -> ProposalChanges.Shown {
    let done = gym.routineHistory(proposal.routineId).first.map { gym.dates.day($0.startedAt) }
    return ProposalChanges.Shown(kind: .removed, title: routineName, fields: [ProposalDiff.Field("Movements", before: String(proposal.changes.count), after: nil)]
      + (done.map { [ProposalDiff.Field("Last done", before: $0, after: nil)] } ?? []))
  }

  func buttons(_ proposal: Proposal) -> some View {
    let decision = decision(stalled: stalled)
    return VStack(spacing: 10) {
      // Try again resends a decision still queued, never writing it twice, or decides again after the log refused it.
      Button(role: removal ? .destructive : nil) {
        guard pending else { _ = gym.coachDecideProposal(proposal, apply: true); return }
        resent += 1
        guard let resend = gym.coachResendDecision(proposal.id) else { return }
        retrying = true
        Task { await resend.value; retrying = false }
      } label: {
        HStack(spacing: RoomSpace.related) {
          if pending && !decision.retries { ProgressView().tint(removal ? GymPalette.destructive : GymPalette.onAccent) }
          Text(decision.title)
        }
      }.buttonStyle(ChangeCardButtonStyle(prominent: !removal)).disabled(!decision.applies)
        .accessibilityIdentifier("coach-apply-proposal")
      Button("Reject") { _ = gym.coachDecideProposal(proposal, apply: false) }
        .buttonStyle(ChangeCardButtonStyle()).disabled(!decision.rejects).accessibilityIdentifier("coach-reject-proposal")
    }.padding(.top, 16)
  }

  func acknowledgeReceipt() {
    guard phase == .active, !pending, let proposal else { return }
    gym.coachRemovalReceiptShown(proposal.id, owner: gym.account)
  }
}

// What a card changes, under its header: the first two blocks until *Show all*, the movements it leaves folded into one
// line, and once it is out of date, dimmed, the one sentence that says why nothing was applied.
struct ProposalChanges: View {
  struct Shown {
    let kind: ProposalDiff.Kind
    let title: String?
    let fields: [ProposalDiff.Field]
  }

  let blocks: [Shown]
  let unchanged: Int
  let count: Int
  let outOfDate: String?
  // The card's identifier, which its expand button and out-of-date sentence extend.
  let identifier: String
  @State var expanded = false

  var body: some View {
    let shown = expanded ? blocks : Array(blocks.prefix(2))
    ForEach(Array(shown.enumerated()), id: \.offset) { _, block in
      Divider().overlay(GymPalette.line)
      ChangeBlock(kind: block.kind, title: block.title, fields: block.fields, dimmed: outOfDate != nil).padding(.vertical, 14)
    }
    if unchanged > 0, shown.count == blocks.count {
      Divider().overlay(GymPalette.line)
      Text("No change: " + GymCount.of(unchanged, "movement")).foregroundStyle(GymPalette.inkDim).padding(.vertical, 14)
    }
    if blocks.count > 2 {
      Divider().overlay(GymPalette.line)
      Button { withAnimation { expanded.toggle() } } label: {
        HStack(spacing: 6) {
          Text(expanded ? "Show less" : "Show all " + GymCount.of(count, "change"))
          Image(systemName: expanded ? "chevron.up" : "chevron.down").imageScale(.small).accessibilityHidden(true)
        }.font(.body.weight(.semibold)).foregroundStyle(GymPalette.accent)
          .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityIdentifier(identifier + "-expand")
    }
    if let outOfDate {
      Divider().overlay(GymPalette.line)
      Text(outOfDate).foregroundStyle(GymPalette.inkDim).padding(.top, 14).accessibilityIdentifier(identifier + "-out-of-date")
    }
  }
}

// Coach's change to the open workout, decided where it stands (08.55–08.57): *CHANGES TO THIS WORKOUT* under the running
// dot, its changes in the routine card's language, then Apply, which rewrites the running plan and no routine, and Reject.
// Applied, it stays as the record of what changed; rejected, it folds to one line; out of date, it says why.
struct WorkoutProposalCard: View {
  let gym: GymModel
  let id: String
  @State var applied = 0

  var proposal: WorkoutProposal? { gym.workoutProposals.first { $0.id.record.string == id } }

  var body: some View {
    Group {
      if let proposal {
        let stance = gym.coachWorkoutProposalStance(proposal)
        if stance == .rejected {
          RejectedLine(subject: "this workout").accessibilityIdentifier("coach-workout-proposal-header").accessibilityValue("Rejected")
        } else { card(proposal, stance: stance) }
      } else { Text("That proposal is gone.").font(.subheadline).foregroundStyle(GymPalette.inkDim).modifier(ChangeCard()) }
    }.sensoryFeedback(.success, trigger: applied)
  }

  func card(_ proposal: WorkoutProposal, stance: ProposalStance) -> some View {
    let outOfDate: String? = switch stance {
    case .outOfDate(let reason): CoachCopy.outOfDateReason(reason, routine: "This workout", catalogue: gym.catalogue)
    default: nil
    }
    let diff = gym.coachWorkoutDiff(proposal)
    let decidable = stance == .open && gym.coachAccountAvailable && !gym.readFailed
    return VStack(alignment: .leading, spacing: 0) {
      header(proposal, stance: stance)
      ProposalChanges(blocks: diff.blocks.map { ProposalChanges.Shown(kind: $0.kind, title: gym.coachTitle($0), fields: $0.fields) },
                      unchanged: diff.unchanged, count: gym.coachWorkoutChangeCount(proposal), outOfDate: outOfDate, identifier: "coach-workout-proposal")
      if stance == .open {
        VStack(spacing: 10) {
          Button("Apply") { if gym.coachDecideWorkoutProposal(proposal, apply: true) { applied += 1 } }
            .buttonStyle(ChangeCardButtonStyle(prominent: true)).disabled(!decidable).accessibilityIdentifier("coach-apply-workout-proposal")
          Button("Reject") { _ = gym.coachDecideWorkoutProposal(proposal, apply: false) }
            .buttonStyle(ChangeCardButtonStyle()).disabled(!decidable).accessibilityIdentifier("coach-reject-workout-proposal")
        }.padding(.top, 16)
      }
    }.modifier(ChangeCard(stroke: stance == .open ? GymPalette.accent : outOfDate != nil ? GymPalette.line : nil))
      .accessibilityElement(children: .contain).accessibilityIdentifier("coach-workout-proposal")
  }

  // Waiting, the running dot and *CHANGES TO THIS WORKOUT*; applied, *✓ Applied · this workout*; out of date, the eyebrow
  // says so without the dot. The count stands at the end.
  func header(_ proposal: WorkoutProposal, stance: ProposalStance) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
      switch stance {
      case .applied:
        HStack(spacing: RoomSpace.related) {
          Image(systemName: "checkmark.circle").symbolEffect(.bounce, value: applied).accessibilityHidden(true)
          Text("Applied · this workout")
        }.font(.headline).foregroundStyle(GymPalette.ink)
      case .outOfDate:
        Text("This workout · " + CoachCopy.outOfDate).font(.footnote.weight(.semibold)).textCase(.uppercase).foregroundStyle(GymPalette.inkDim)
      default:
        HStack(spacing: 6) {
          Circle().fill(GymPalette.accent).frame(width: 7, height: 7).accessibilityHidden(true)
          Text("Changes to this workout")
        }.font(.footnote.weight(.semibold)).textCase(.uppercase).foregroundStyle(GymPalette.accent)
      }
      Spacer(minLength: 0)
      Text(GymCount.of(gym.coachWorkoutChangeCount(proposal), "change")).font(.subheadline).foregroundStyle(GymPalette.inkDim)
    }.padding(.bottom, 12).accessibilityElement(children: .combine)
      .accessibilityIdentifier("coach-workout-proposal-header").accessibilityValue(stance == .applied ? "Applied" : stance == .open ? "" : CoachCopy.outOfDate)
  }
}

// A Routines row's proposal that the conversation on screen does not hold, its card on a sheet of its own.
struct ProposalSheet: View {
  let gym: GymModel
  let id: String
  @Environment(\.dismiss) var dismiss
  var body: some View {
    let proposal = gym.proposals.first { $0.id.record.string == id }
    NavigationStack {
      ScrollView { ProposalCard(gym: gym, id: id).padding(RoomSpace.inset) }
        .navigationTitle(proposal.flatMap(gym.coachRoutine)?.name ?? proposal?.baseName ?? "Proposal").navigationBarTitleDisplayMode(.inline)
        .modifier(GymPage())
        .safeAreaInset(edge: .bottom) { GymTransient(gym: gym, errorIdentifier: "gym-coach-error") }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }.presentationDetents([.medium, .large])
      .accessibilityIdentifier("gym-proposal-sheet")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "review"]) }
  }
}
