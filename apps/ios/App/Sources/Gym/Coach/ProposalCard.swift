import SwiftUI
import DomainKit
import GymDomain

// The Routines row's door to a proposal it lists.
nonisolated struct CoachProposalID: Identifiable { let id: String }

// A proposal in the conversation, decided where it stands: its changes as blocks, the first two until *Show all*, the
// movements it leaves folded into one line, then Apply and Reject.
struct ProposalCard: View {
  let gym: GymModel
  let id: String
  var stallAfter: Duration = .seconds(15)
  @State var expanded = false
  @State var stalled = false
  @State var resent = 0
  @Environment(\.scenePhase) var phase

  init(gym: GymModel, id: String, stallAfter: Duration = .seconds(15)) { self.gym = gym; self.id = id; self.stallAfter = stallAfter }

  var proposal: Proposal? { gym.proposals.first { $0.id.record.string == id } }
  var routineName: String { proposal.flatMap(gym.coachRoutine)?.name ?? proposal?.baseName ?? "Routine" }
  var removal: Bool { proposal?.intent == "remove" }
  // The decision the log has not answered yet, while it waits.
  var waiting: CoachQueuedDecision? { proposal.flatMap { gym.coachQueuedDecision($0.id) } }
  var pending: Bool { waiting != nil }
  var decidable: Bool {
    guard let proposal, proposal.state == "pending", !gym.coachProposalOutOfDate(proposal) else { return false }
    return !pending && gym.coachAccountAvailable && !gym.readFailed
  }
  // Why an out-of-date proposal has no buttons, said once where they stood.
  var outOfDate: String? {
    guard let proposal, gym.coachProposalOutOfDate(proposal) else { return nil }
    if proposal.supersededBy != nil { return "A newer proposal replaced this one. Nothing was applied." }
    if proposal.state == "pending" { return "The routine changed after this was written. Nothing was applied." }
    return "This proposal is out of date. Nothing was applied."
  }
  // Apply keeps its place through the wait: the act in flight until the log answers, then Retry.
  var primaryTitle: String {
    if stalled { return "Retry" }
    switch waiting {
    case nil: return removal ? "Remove routine" : "Apply"
    case .apply: return removal ? "Removing…" : "Applying…"
    case .reject: return "Rejecting…"
    case .unreadable: return "Sending…"
    }
  }

  var body: some View {
    Group {
      if let proposal { card(proposal) }
      else { Text("That proposal is gone.").font(.subheadline).foregroundStyle(GymPalette.inkDim).modifier(ChangeCard()) }
    }
      .onAppear { acknowledgeReceipt() }
      .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      .onChange(of: proposal?.state) { _, _ in acknowledgeReceipt() }
      .task(id: "\(pending):\(resent)") {
        stalled = false
        guard pending else { return }
        do { try await Task.sleep(for: stallAfter) } catch { return }
        guard let proposal else { return }
        stalled = gym.coachDecisionStalled(proposal.id)
      }
  }

  func card(_ proposal: Proposal) -> some View {
    let open = decidable || pending
    let blocks = removal ? [removalBlock(proposal)] : gym.coachDiff(proposal).blocks.map { ($0.kind, title($0), $0.fields) }
    let unchanged = removal ? 0 : gym.coachDiff(proposal).unchanged
    let shown = expanded ? blocks : Array(blocks.prefix(2))
    return VStack(alignment: .leading, spacing: 0) {
      header(proposal)
      ForEach(Array(shown.enumerated()), id: \.offset) { _, block in
        Divider().overlay(GymPalette.line)
        ChangeBlock(kind: block.0, title: block.1, fields: block.2).padding(.vertical, 14)
      }
      if unchanged > 0, shown.count == blocks.count {
        Divider().overlay(GymPalette.line)
        Text("No change: " + GymCount.of(unchanged, "movement")).foregroundStyle(GymPalette.inkDim).padding(.vertical, 14)
      }
      if blocks.count > 2 {
        Divider().overlay(GymPalette.line)
        Button { withAnimation { expanded.toggle() } } label: {
          Label(expanded ? "Show less" : "Show all " + GymCount.of(gym.coachChangeCount(proposal), "change"), systemImage: expanded ? "chevron.up" : "chevron.down")
            .labelStyle(TrailingSymbol()).font(.body.weight(.semibold)).foregroundStyle(GymPalette.accent)
            .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("coach-proposal-expand")
      }
      if let outOfDate, !pending {
        Divider().overlay(GymPalette.line)
        Text(outOfDate).foregroundStyle(GymPalette.inkDim).padding(.top, 14).accessibilityIdentifier("coach-proposal-out-of-date")
      }
      if open {
        if gym.coachRemovalReceipts.contains(where: { $0.proposal.id == proposal.id && $0.outcome == .refused }) {
          Text("Nothing was applied.").font(.subheadline).foregroundStyle(GymPalette.inkDim).padding(.top, 14)
        }
        buttons(proposal)
      }
    }.modifier(ChangeCard(stroked: open)).accessibilityElement(children: .contain).accessibilityIdentifier("coach-proposal")
  }

  // *CHANGES TO PUSH A* with the store's count, or *REMOVE A ROUTINE*; a settled card names how it settled.
  func header(_ proposal: Proposal) -> some View {
    let settled = gym.coachProposalOutOfDate(proposal) ? CoachCopy.outOfDate : CoachCopy.settled(proposal.state, removal: removal)
    return HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
      Text(removal ? "Remove a routine" : "Changes to " + routineName).font(.footnote.weight(.semibold)).textCase(.uppercase)
        .foregroundStyle(GymPalette.accent)
      Spacer(minLength: 0)
      if let settled { Text(settled).font(.subheadline).foregroundStyle(GymPalette.inkDim) }
      else if !removal { Text(GymCount.of(gym.coachChangeCount(proposal), "change")).font(.subheadline).foregroundStyle(GymPalette.inkDim) }
    }.padding(.bottom, 12).accessibilityElement(children: .combine)
      .accessibilityIdentifier("coach-proposal-header").accessibilityValue(settled ?? "")
  }

  func title(_ block: ProposalDiff.Block) -> String? {
    block.exerciseId.map { gym.catalogue.find($0)?.name ?? "Movement unavailable" }
  }

  func removalBlock(_ proposal: Proposal) -> (ProposalDiff.Kind, String?, [ProposalDiff.Field]) {
    (.removed, routineName, [ProposalDiff.Field("Movements", before: String(proposal.changes.count), after: nil)])
  }

  func buttons(_ proposal: Proposal) -> some View {
    VStack(spacing: 10) {
      Button(role: removal && !stalled ? .destructive : nil) {
        if stalled { resent += 1; gym.coachResendDecision(proposal.id) } else { _ = gym.coachDecideProposal(proposal, apply: true) }
      } label: {
        HStack(spacing: RoomSpace.related) {
          if pending && !stalled { ProgressView().tint(removal ? GymPalette.destructive : GymPalette.onAccent) }
          Text(primaryTitle)
        }
      }.buttonStyle(ChangeCardButtonStyle(prominent: !removal)).disabled(!stalled && !decidable)
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
