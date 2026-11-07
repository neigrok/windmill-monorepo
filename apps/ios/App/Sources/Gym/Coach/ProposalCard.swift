import SwiftUI
import DomainKit
import GymDomain

// The Routines row's door to a proposal it lists, when the conversation on screen does not hold its card.
nonisolated struct CoachProposalID: Identifiable { let id: String }

// A proposal, decided where it stands: on Coach's canvas as its card (08.2P), or on its Routines row's sheet as a Form
// (02L.9P, ProposalSheet.swift). Both read one decision. Applied, it stays as the record of what changed; rejected, the
// card folds to one line; out of date, it says why nothing was applied.
struct ProposalCard: View {
  enum Presentation { case conversation, sheet }
  let gym: GymModel
  let id: String
  var presentation = Presentation.conversation
  var stallAfter: Duration = .seconds(15)
  @State var stalled = false
  @State var resent = 0
  @State var retrying = false
  // The sheet's field rows stand under their change's title, past its symbol's column.
  @ScaledMetric(relativeTo: .body) var column = 32.0
  @Environment(\.scenePhase) var phase
  @Environment(\.dismiss) var dismiss

  init(gym: GymModel, id: String, in presentation: Presentation = .conversation, stallAfter: Duration = .seconds(15)) {
    self.gym = gym; self.id = id; self.presentation = presentation; self.stallAfter = stallAfter
  }
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
  // Why an out-of-date proposal has no buttons, said once under its title.
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

  // The head's words (08.2P): the routine over its count — while a workout is open, a count that waits for the routine's
  // next workout (08.56P); applied, *Applied · Push A* over what it changed; out of date, the routine says so and the
  // reason stands under it.
  var title: String {
    if stance == .applied { return "Applied · " + routineName + (removal ? " · routine removed" : "") }
    return outOfDate == nil ? routineName : routineName + " · " + CoachCopy.outOfDate
  }
  var subtitle: String? {
    guard let proposal, outOfDate == nil else { return nil }
    if removal { return stance == .applied ? nil : "Remove a routine" }
    let count = gym.coachChangeCount(proposal)
    if stance == .applied { return GymCount.of(count, "change") }
    return GymCount.of(count, "suggested change") + (nextTime ? " · next time" : "")
  }
  // The word the card stands on, its head's value: Applied or Removed, Out of date, none while it waits.
  var settled: String {
    if outOfDate != nil { return CoachCopy.outOfDate }
    return stance == .applied ? CoachCopy.settled("applied", removal: removal) ?? "" : ""
  }
  // While a workout is open the routine waits for next time, so its symbol and its Apply step back for this workout's
  // (08.56P).
  var nextTime: Bool { gym.openSession != nil }
  // The routine's symbol while it waits, the check once applied, the clock once out of date.
  var symbol: (name: String, tint: Color) {
    if stance == .applied { return ("checkmark.circle.fill", GymPalette.done) }
    if outOfDate != nil { return ("clock.arrow.circlepath", GymPalette.inkDim) }
    return ("list.bullet.rectangle", nextTime ? GymPalette.inkDim : GymPalette.accent)
  }
  // What it changes, as both presentations list them: a removal's one block, the routine struck, how many movements go
  // with it and when it was last done; otherwise the diff's.
  func changes(_ proposal: Proposal) -> (blocks: [ProposalChanges.Shown], unchanged: Int) {
    guard !removal else {
      let done = gym.routineHistory(proposal.routineId).first.map { gym.dates.day($0.startedAt) }
      let fields = [ProposalDiff.Field("Movements", before: String(proposal.changes.count), after: nil)]
        + (done.map { [ProposalDiff.Field("Last done", before: $0, after: nil)] } ?? [])
      return ([ProposalChanges.Shown(kind: .removed, title: routineName, fields: fields)], 0)
    }
    let diff = gym.coachDiff(proposal)
    return (diff.blocks.map { ProposalChanges.Shown(kind: $0.kind, title: gym.coachTitle($0), fields: $0.fields) }, diff.unchanged)
  }

  var body: some View {
    Group {
      switch presentation {
      case .conversation: conversation
      case .sheet: sheet
      }
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

  @ViewBuilder var conversation: some View {
    if let proposal {
      if stance == .rejected {
        RejectedLine(subject: routineName, symbol: "xmark.circle").accessibilityIdentifier("coach-proposal-header")
          .accessibilityValue(CoachCopy.settled("dismissed", removal: removal) ?? "")
      } else { card(proposal) }
    } else { Text("That proposal is gone.").font(.subheadline).foregroundStyle(GymPalette.inkDim).modifier(ChangeCard()) }
  }

  func card(_ proposal: Proposal) -> some View {
    let listed = changes(proposal)
    return GroupBox {
      ProposalHeading(symbol: symbol.name, tint: symbol.tint, title: title, dimmed: outOfDate != nil, subtitle: subtitle, reason: outOfDate,
                      bounce: landed, identifier: "coach-proposal", value: settled)
      ProposalChanges(blocks: listed.blocks, unchanged: listed.unchanged, dimmed: outOfDate != nil, identifier: "coach-proposal")
      if stance == .open {
        if let failure { failureLine(failure).padding(.vertical, RoomSpace.related) }
        decisions(proposal)
      }
    }.groupBoxStyle(ProposalBoxStyle())
      .accessibilityElement(children: .contain).accessibilityIdentifier("coach-proposal")
  }

  func failureLine(_ failure: String) -> some View {
    Label(failure, systemImage: "exclamationmark.triangle").labelStyle(ChangeBadgeStyle()).font(.subheadline)
      .foregroundStyle(GymPalette.destructive)
      .accessibilityElement(children: .combine).accessibilityIdentifier("coach-proposal-failure")
  }

  // Reject | Apply. A removal's Apply is the destructive *Remove routine* in glass; while a workout is open the routine's
  // Apply is glass in the accent, and this workout's card holds the one prominent Apply.
  func decisions(_ proposal: Proposal) -> some View {
    let decision = decision(stalled: stalled)
    let apply = Button(role: removal ? .destructive : nil) { decide(proposal) } label: {
      HStack(spacing: RoomSpace.related) {
        if pending && !decision.retries { ProgressView().controlSize(.regular).tint(GymPalette.inkDim) }
        Text(decision.title)
      }.frame(maxWidth: .infinity)
    }
    return DecisionRow {
      Button { _ = gym.coachDecideProposal(proposal, apply: false) } label: { Text("Reject").frame(maxWidth: .infinity) }
        .buttonStyle(RoomSecondaryStyle(room: .gym)).disabled(!decision.rejects).accessibilityIdentifier("coach-reject-proposal")
    } apply: {
      Group {
        if removal { apply.buttonStyle(RoomSecondaryStyle(room: .gym)) }
        else if nextTime { apply.buttonStyle(RoomSecondaryStyle()).tint(GymPalette.accent) }
        else { apply.buttonStyle(RoomPrimaryStyle(room: .gym)) }
      }.disabled(!decision.applies).accessibilityIdentifier("coach-apply-proposal")
    }
  }

  // Apply, or Try again: a decision still queued is resent, never written twice; one the log refused is decided again.
  func decide(_ proposal: Proposal) {
    guard pending else { _ = gym.coachDecideProposal(proposal, apply: true); return }
    resent += 1
    guard let resend = gym.coachResendDecision(proposal.id) else { return }
    retrying = true
    Task { await resend.value; retrying = false }
  }

  func acknowledgeReceipt() {
    guard phase == .active, !pending, let proposal else { return }
    gym.coachRemovalReceiptShown(proposal.id, owner: gym.account)
  }
}

// What a card changes, under its head: the first two changes until the reader opens the rest (*3 more changes*), then
// the movements it leaves as one line once every change shows. Out of date, every change is dimmed.
struct ProposalChanges: View {
  struct Shown {
    let kind: ProposalDiff.Kind
    let title: String?
    let fields: [ProposalDiff.Field]
  }

  let blocks: [Shown]
  let unchanged: Int
  var dimmed = false
  // The card's identifier, which its disclosure extends.
  let identifier: String
  @State var expanded = false
  @ScaledMetric(relativeTo: .body) var column = 32.0

  var body: some View {
    let rest = blocks.dropFirst(2)
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(blocks.prefix(2).enumerated()), id: \.offset) { _, block in change(block) }
      if rest.isEmpty { unchangedLine } else {
        Divider().overlay(GymPalette.line)
        DisclosureGroup(isExpanded: $expanded.animation()) {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rest.enumerated()), id: \.offset) { _, block in change(block) }
            unchangedLine
          }
        } label: {
          Text(expanded ? "Show less" : GymCount.of(rest.count, "more change")).frame(minHeight: RoomSpace.minimumTarget)
        }.tint(GymPalette.accent).accessibilityIdentifier(identifier + "-expand")
      }
    }.labeledContentStyle(.card).padding(.top, 12)
  }

  func change(_ block: Shown) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Divider().overlay(GymPalette.line)
      VStack(alignment: .leading, spacing: 6) {
        ChangeTitle(kind: block.kind, title: block.title, dimmed: dimmed).font(.body.weight(.semibold))
        ForEach(Array(block.fields.enumerated()), id: \.offset) { _, field in ProposalField(field: field, dimmed: dimmed) }
          .padding(.leading, column)
      }.padding(.vertical, 12)
    }
  }

  @ViewBuilder var unchangedLine: some View {
    if unchanged > 0 {
      Divider().overlay(GymPalette.line).padding(.leading, column)
      LabeledContent("No change", value: GymCount.of(unchanged, "movement")).padding(.leading, column).padding(.vertical, 12)
        .accessibilityElement(children: .ignore).accessibilityLabel("No change: " + GymCount.of(unchanged, "movement"))
    }
  }
}

// Coach's change to the open workout, decided where it stands (08.56P): *This workout* under its clipboard, its changes in
// the routine card's language, then Reject | Apply — the sheet's one prominent Apply, which rewrites the running plan and
// no routine. Applied, it stays as the record of what changed; rejected, it folds to one line; out of date, it says why.
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
          RejectedLine(subject: "this workout", symbol: "xmark.circle").accessibilityIdentifier("coach-workout-proposal-header").accessibilityValue("Rejected")
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
    let count = gym.coachWorkoutChangeCount(proposal)
    let decidable = stance == .open && gym.coachAccountAvailable && !gym.readFailed
    return GroupBox {
      switch stance {
      case .applied:
        ProposalHeading(symbol: "checkmark.circle.fill", tint: GymPalette.done, title: "Applied · this workout", subtitle: GymCount.of(count, "change"),
                        bounce: applied > 0, identifier: "coach-workout-proposal", value: "Applied")
      case .outOfDate:
        ProposalHeading(symbol: "clock.arrow.circlepath", tint: GymPalette.inkDim, title: "This workout · " + CoachCopy.outOfDate, dimmed: true,
                        reason: outOfDate, identifier: "coach-workout-proposal", value: CoachCopy.outOfDate)
      default:
        ProposalHeading(symbol: "list.bullet.clipboard", tint: GymPalette.accent, title: "This workout",
                        subtitle: GymCount.of(count, "suggested change") + " · now", identifier: "coach-workout-proposal", value: "")
      }
      ProposalChanges(blocks: diff.blocks.map { ProposalChanges.Shown(kind: $0.kind, title: gym.coachTitle($0), fields: $0.fields) },
                      unchanged: diff.unchanged, dimmed: outOfDate != nil, identifier: "coach-workout-proposal")
      if stance == .open {
        DecisionRow {
          Button { _ = gym.coachDecideWorkoutProposal(proposal, apply: false) } label: { Text("Reject").frame(maxWidth: .infinity) }
            .buttonStyle(RoomSecondaryStyle(room: .gym)).disabled(!decidable).accessibilityIdentifier("coach-reject-workout-proposal")
        } apply: {
          Button { if gym.coachDecideWorkoutProposal(proposal, apply: true) { applied += 1 } } label: { Text("Apply").frame(maxWidth: .infinity) }
            .buttonStyle(RoomPrimaryStyle(room: .gym)).disabled(!decidable).accessibilityIdentifier("coach-apply-workout-proposal")
        }
      }
    }.groupBoxStyle(ProposalBoxStyle())
      .accessibilityElement(children: .contain).accessibilityIdentifier("coach-workout-proposal")
  }
}
