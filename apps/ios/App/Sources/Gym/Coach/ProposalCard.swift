import SwiftUI
import DomainKit
import GymDomain

// The Routines row's door to a proposal it lists.
nonisolated struct CoachProposalID: Identifiable { let id: String }

// Where a proposal stands, as its card draws it: waiting on the lifter (or on the log for an Apply), applied, rejected, or
// out of date and why.
nonisolated enum ProposalStance: Equatable { case open, applied, rejected, outOfDate(CoachOutOfDate) }

// A proposal in the conversation, decided where it stands: its changes as blocks, the first two until *Show all*, the
// movements it leaves folded into one line, then Apply and Reject. Applied, it stays as the record of what changed;
// rejected, it folds to one line; out of date, it says why nothing was applied.
struct ProposalCard: View {
  let gym: GymModel
  let id: String
  var stallAfter: Duration = .seconds(15)
  @State var expanded = false
  @State var stalled = false
  @State var resent = 0
  @State var applying = false
  @State var retrying = false
  @State var landed = false
  @Environment(\.scenePhase) var phase

  init(gym: GymModel, id: String, stallAfter: Duration = .seconds(15)) { self.gym = gym; self.id = id; self.stallAfter = stallAfter }

  var proposal: Proposal? { gym.proposals.first { $0.id.record.string == id } }
  // The routine as the proposal found it, so an applied rename still reads *Applied · Push A*.
  var routineName: String { proposal?.baseName ?? proposal.flatMap(gym.coachRoutine)?.name ?? "Routine" }
  var removal: Bool { proposal?.intent == "remove" }
  // The decision the log has not answered yet, while it waits.
  var waiting: CoachQueuedDecision? { proposal.flatMap { gym.coachQueuedDecision($0.id) } }
  var pending: Bool { waiting != nil }
  var decidable: Bool {
    guard let proposal, proposal.state == "pending", !gym.coachProposalOutOfDate(proposal) else { return false }
    return !pending && gym.coachAccountAvailable && !gym.readFailed
  }
  // Reject settles the card at once; an Apply keeps it open until the log answers.
  var stance: ProposalStance {
    guard let proposal else { return .open }
    if waiting == .reject || (proposal.state == "dismissed" && !pending) { return .rejected }
    if pending { return .open }
    if proposal.state == "applied" { return .applied }
    if let reason = gym.outOfDateProposals[proposal.id] { return .outOfDate(reason) }
    return .open
  }
  // Why an out-of-date proposal has no buttons, said once where they stood.
  var outOfDate: String? {
    guard case .outOfDate(let reason) = stance else { return nil }
    switch reason {
    case .replaced: return "A newer suggestion replaced this one. Nothing was applied."
    case .routineChanged: return routineName + " changed after this suggestion. Nothing was applied."
    }
  }
  // Why the Apply did not land, said once over the buttons, only from what the engine or the log answered: no network or
  // no answer to its push, or the log refused it. A long wait alone states no cause.
  var failure: String? {
    guard let proposal, stance == .open, !retrying else { return nil }
    if pending { return gym.coachDecisionUnreached ? "No connection. Not applied." : nil }
    return gym.coachRemovalReceipts.contains(where: { $0.proposal.id == proposal.id && $0.outcome == .refused }) ? "Not applied." : nil
  }
  // Try again once the Apply failed, or once it has waited past the card's wait with the cause unknown.
  var retryable: Bool { failure != nil || (pending && stalled && !retrying) }
  // Apply keeps its place through the wait: the act in flight until the log answers, then Try again.
  var primaryTitle: String {
    if retryable { return "Try again" }
    switch waiting {
    case nil, .reject: return removal ? "Remove routine" : "Apply"
    case .apply: return removal ? "Removing…" : "Applying…"
    case .unreadable: return "Sending…"
    }
  }

  var body: some View {
    Group {
      if let proposal {
        if stance == .rejected { rejected } else { card(proposal) }
      } else { Text("That proposal is gone.").font(.subheadline).foregroundStyle(GymPalette.inkDim).modifier(ChangeCard()) }
    }.sensoryFeedback(.success, trigger: landed)
      .onAppear { acknowledgeReceipt() }
      .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      .onChange(of: stance) { _, stance in
        acknowledgeReceipt()
        if stance == .applied, applying { landed = true }
        if stance != .open { applying = false }
      }
      .task(id: "\(pending):\(resent)") {
        stalled = false
        guard pending else { return }
        do { try await Task.sleep(for: stallAfter) } catch { return }
        guard let proposal else { return }
        stalled = gym.coachDecisionStalled(proposal.id)
      }
  }

  // *× Rejected · Push A*, one quiet line where the card stood.
  var rejected: some View {
    Label("Rejected · " + routineName, systemImage: "xmark").labelStyle(ChangeBadgeStyle())
      .font(.subheadline).foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading)
      .accessibilityElement(children: .combine).accessibilityIdentifier("coach-proposal-header").accessibilityValue(CoachCopy.settled("dismissed", removal: removal) ?? "")
  }

  func card(_ proposal: Proposal) -> some View {
    let stance = stance
    let diff = gym.coachDiff(proposal)
    let blocks = removal ? [removalBlock(proposal)] : diff.blocks.map { ($0.kind, title($0), $0.fields) }
    let shown = expanded ? blocks : Array(blocks.prefix(2))
    let dimmed = outOfDate != nil
    return VStack(alignment: .leading, spacing: 0) {
      header(proposal, stance: stance)
      ForEach(Array(shown.enumerated()), id: \.offset) { _, block in
        Divider().overlay(GymPalette.line)
        ChangeBlock(kind: block.0, title: block.1, fields: block.2, dimmed: dimmed).padding(.vertical, 14)
      }
      if !removal, diff.unchanged > 0, shown.count == blocks.count {
        Divider().overlay(GymPalette.line)
        Text("No change: " + GymCount.of(diff.unchanged, "movement")).foregroundStyle(GymPalette.inkDim).padding(.vertical, 14)
      }
      if blocks.count > 2 {
        Divider().overlay(GymPalette.line)
        Button { withAnimation { expanded.toggle() } } label: {
          Label(expanded ? "Show less" : "Show all " + GymCount.of(gym.coachChangeCount(proposal), "change"), systemImage: expanded ? "chevron.up" : "chevron.down")
            .labelStyle(TrailingSymbol()).font(.body.weight(.semibold)).foregroundStyle(GymPalette.accent)
            .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("coach-proposal-expand")
      }
      if let outOfDate {
        Divider().overlay(GymPalette.line)
        Text(outOfDate).foregroundStyle(GymPalette.inkDim).padding(.top, 14).accessibilityIdentifier("coach-proposal-out-of-date")
      }
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
  // date, the eyebrow says so.
  func header(_ proposal: Proposal, stance: ProposalStance) -> some View {
    let settled = outOfDate != nil ? CoachCopy.outOfDate : stance == .applied ? CoachCopy.settled("applied", removal: removal) : nil
    return HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
      if stance == .applied {
        Label("Applied · " + routineName + (removal ? " · routine removed" : ""), systemImage: "checkmark.circle").labelStyle(ReceiptStyle(landed: landed))
          .font(.headline).foregroundStyle(GymPalette.ink)
      } else {
        Text(removal ? "Remove a routine" : "Changes to " + routineName + (outOfDate != nil ? " · Out of date" : ""))
          .font(.footnote.weight(.semibold)).textCase(.uppercase).foregroundStyle(outOfDate != nil ? GymPalette.inkDim : GymPalette.accent)
      }
      Spacer(minLength: 0)
      if !removal { Text(GymCount.of(gym.coachChangeCount(proposal), "change")).font(.subheadline).foregroundStyle(GymPalette.inkDim) }
    }.padding(.bottom, 12).accessibilityElement(children: .combine)
      .accessibilityIdentifier("coach-proposal-header").accessibilityValue(settled ?? "")
  }

  func title(_ block: ProposalDiff.Block) -> String? {
    block.exerciseId.map { gym.catalogue.find($0)?.name ?? "Movement unavailable" }
  }

  // A removal's one block: the routine struck, how many movements go with it and when it was last done.
  func removalBlock(_ proposal: Proposal) -> (ProposalDiff.Kind, String?, [ProposalDiff.Field]) {
    let done = gym.routineHistory(proposal.routineId).first.map { gym.dates.day($0.startedAt) }
    return (.removed, routineName, [ProposalDiff.Field("Movements", before: String(proposal.changes.count), after: nil)]
      + (done.map { [ProposalDiff.Field("Last done", before: $0, after: nil)] } ?? []))
  }

  func buttons(_ proposal: Proposal) -> some View {
    VStack(spacing: 10) {
      // Try again resends a decision still queued, never writing it twice, or decides again after the log refused it.
      Button(role: removal ? .destructive : nil) {
        applying = true
        guard pending else { _ = gym.coachDecideProposal(proposal, apply: true); return }
        resent += 1
        guard let resend = gym.coachResendDecision(proposal.id) else { return }
        retrying = true
        Task { await resend.value; retrying = false }
      } label: {
        HStack(spacing: RoomSpace.related) {
          if pending && !retryable { ProgressView().tint(removal ? GymPalette.destructive : GymPalette.onAccent) }
          Text(primaryTitle)
        }
      }.buttonStyle(ChangeCardButtonStyle(prominent: !removal)).disabled(!retryable && !decidable)
        .accessibilityIdentifier("coach-apply-proposal")
      Button("Reject") { _ = gym.coachDecideProposal(proposal, apply: false) }
        .buttonStyle(ChangeCardButtonStyle()).disabled(!decidable).accessibilityIdentifier("coach-reject-proposal")
    }.padding(.top, 16)
  }

  func acknowledgeReceipt() {
    guard phase == .active, !pending, let proposal else { return }
    gym.coachRemovalReceiptShown(proposal.id, owner: gym.account)
  }
}

// The applied card's check bounces in once, when the Apply this card sent lands.
struct ReceiptStyle: LabelStyle {
  let landed: Bool
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: RoomSpace.related) {
      configuration.icon.symbolEffect(.bounce, value: landed)
      configuration.title
    }
  }
}

struct TrailingSymbol: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) { configuration.title; configuration.icon.imageScale(.small) }
  }
}

// The Routines row's proposal, its card on a sheet of its own.
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
