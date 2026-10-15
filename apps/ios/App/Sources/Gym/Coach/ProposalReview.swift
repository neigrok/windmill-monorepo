import SwiftUI
import GymDomain
import DomainKit
import SyncAPI
import SyncSchema

nonisolated struct ProposalReviewID: Identifiable { let id: String }
nonisolated struct CoachReviewExtent: Equatable {
  let content: CGFloat
  let viewport: CGFloat
  let width: CGFloat
}
nonisolated struct CoachReviewPosition: Equatable { let extent: CoachReviewExtent; let atEnd: Bool }
// The decision a proposal waits on the log for; an unreadable queue may hold one, and cannot say which.
nonisolated enum CoachQueuedDecision: String { case apply, dismiss, unreadable }

extension GymModel {
  nonisolated static func readCoachProposals(_ read: Reader) throws -> (replica: String, receipts: [RoutineRemovalReceipt], proposals: [Proposal]) {
    let receipts = try RoutineRemovalReceipt.read(read)
    let decisions = try read.commands().filter { [Gym.Commands.applyProposal, Gym.Commands.dismissProposal].contains($0.command.name) }
    let proposals = try read.repository(Proposal.self).all(in: .drawn).map { proposal in
      if let receipt = receipts.first(where: { $0.proposal.id == proposal.id }) { return receipt.proposal }
      guard decisions.contains(where: { $0.command.args["proposalId"] == proposal.id.json }),
            let confirmed = try read.confirmed(Proposal.self, proposal.id) else { return proposal }
      return try Proposal(Fields(confirmed))
    }
    return (read.replica, receipts, proposals)
  }
  func updateCoachProposals(replica: String, receipts: [RoutineRemovalReceipt], proposals: [Proposal]) {
    let changedAccount = proposalReadReplica != replica || isAnonymous
    let previous = changedAccount ? [] : coachRemovalReceipts
    if changedAccount { shownCoachRemovals = [:]; awaitedCoachDecisions = [:] }
    proposalReadReplica = replica
    coachRemovalReceipts = receipts
    var visible = proposals
    for proposal in coachRemovalReceipts.map(\.proposal) + Array(shownCoachRemovals.values) where !visible.contains(where: { $0.id == proposal.id }) {
      visible.append(proposal)
    }
    self.proposals = visible
    for receipt in coachRemovalReceipts where receipt.outcome != .pending {
      if previous.first(where: { $0.proposal.id == receipt.proposal.id })?.outcome != receipt.outcome {
        telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": "apply", "outcome": receipt.outcome == .applied ? "decided" : "failed"])
      }
    }
    // Any other decision is recorded once the log's answer reaches the phone: the queue lets it go, the proposal says how.
    for (id, decision) in awaitedCoachDecisions where coachQueuedDecision(id) == nil {
      awaitedCoachDecisions[id] = nil
      let taken = visible.first { $0.id == id }?.state == (decision == .apply ? "applied" : "dismissed")
      telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": decision.rawValue, "outcome": taken ? "decided" : "failed"])
    }
  }
  nonisolated static func queuedDecision(_ id: ID<Proposal>, in read: Reader) throws -> QueuedCommand? {
    try read.commands().first { queued in
      [Gym.Commands.applyProposal, Gym.Commands.dismissProposal].contains(queued.command.name) && queued.command.args["proposalId"] == id.json
    }
  }
  // The decision on a proposal the log has not answered yet; an unreadable queue reports and counts as waiting.
  func coachQueuedDecision(_ id: ID<Proposal>) -> CoachQueuedDecision? {
    if coachRemovalReceipts.contains(where: { $0.proposal.id == id && $0.outcome == .pending }) { return .apply }
    do {
      let queued = try runner.read(Gym.scope) { try Self.queuedDecision(id, in: $0) }
      return queued.map { $0.command.name == Gym.Commands.dismissProposal ? .dismiss : .apply }
    } catch { report("gym_read", error); return .unreadable }
  }
  func coachProposalAwaitingReceipt(_ id: ID<Proposal>) -> Bool { coachQueuedDecision(id) != nil }
  // After the review's wait, a decision still queued has stalled; the event names it unless the queue cannot be read.
  func coachDecisionStalled(_ id: ID<Proposal>) -> Bool {
    guard let decision = coachQueuedDecision(id) else { return false }
    var properties = ["screen": "review", "outcome": "stalled"]
    if decision != .unreadable { properties["action"] = decision.rawValue }
    telemetry.event("gym_proposal_outcome", properties: properties)
    return true
  }
  func coachRemovalReceiptShown(_ id: ID<Proposal>, owner: String?) {
    guard owner == account, coachAccountAvailable, !readFailed, let replica = proposalReadReplica,
          let receipt = coachRemovalReceipts.first(where: { $0.proposal.id == id && $0.outcome != .pending }) else { return }
    do {
      _ = try runner.run(AcknowledgeRoutineRemoval(id, replica: replica))
      if receipt.outcome == .applied { shownCoachRemovals[id.description] = receipt.proposal }
      refresh()
    } catch { report("gym_action", error) }
  }
  func coachDecideProposal(_ proposal: Proposal, apply: Bool) -> Bool {
    guard coachAccountAvailable, !authPaused else { error = "Sign in to review this proposal."; return false }
    guard openSession == nil else { error = "Finish this session"; return false }
    start()
    let decision: CoachQueuedDecision = apply ? .apply : .dismiss
    let outcome = apply ? run(ApplyProposalKeepingReceipt(proposal.id)) : run(DismissProposal(proposal.id))
    let ok = outcome != nil && outcome?.refusal == nil
    let removal = apply && proposal.intent == "remove"
    // A removal's answer is its receipt; any other queued decision waits for updateCoachProposals to see the log's answer.
    if ok && !removal && coachProposalAwaitingReceipt(proposal.id) { awaitedCoachDecisions[proposal.id] = decision }
    else if !ok || !removal {
      telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": decision.rawValue, "outcome": ok ? "decided" : "failed"])
    }
    if ok, let runtime { Task { await runtime.engine.flushOnLeave(); runtime.engine.foreground(); refresh() } }
    return ok
  }
  func coachProposalSource(_ proposal: Proposal) -> String {
    let source: String
    switch proposal.provenance {
    case .ask: source = "proposed by Coach"
    case .mcp(let connection, let agent): source = "proposed by " + (agent.isEmpty ? connection : agent)
    case .other: source = "proposed by a connected tool"
    }
    do {
      let date = try runner.read(Gym.scope) { read in
        try read.repository(Proposal.self).record(proposal.id, in: .stored).flatMap { try Fields($0).optionalInstant("createdAt") }
      }
      if let date { return source + " · " + date.date.formatted(.dateTime.day().month(.abbreviated).hour().minute()) }
    } catch { report("gym_read", error) }
    return source
  }
  func coachRoutine(_ proposal: Proposal) -> Routine? { routines.first { $0.id == proposal.routineId } }
  func coachReorders(_ proposal: Proposal, _ routine: Routine) -> Bool {
    let proposed = proposal.document.map(\.exerciseId), current = routine.entries.map(\.exerciseId)
    return current.filter { proposed.contains($0) } != proposed.filter { current.contains($0) }
  }
  func coachChangeCount(_ proposal: Proposal) -> Int {
    coachRoutine(proposal).map { proposal.countChanges(comparedTo: $0) } ?? proposal.changeCount ?? proposal.changes.filter { $0.kind != "kept" }.count
  }
  // The proposal card's fact rows: each changed movement, then a new name, then a new order while it still waits.
  func coachProposalFacts(_ proposal: Proposal) -> [(title: String, fact: String)] {
    guard proposal.intent != "remove" else { return [] }
    var facts = proposal.changes.compactMap { change -> (title: String, fact: String)? in
      let name = catalogue.find(change.exerciseId)?.name ?? "Movement unavailable"
      switch change.kind {
      case "retargeted": return (name, Readout.target(change.before?.sets) + " → " + Readout.target(change.after?.sets))
      case "added": return (name, "added · " + Readout.target(change.after?.sets))
      case "removed": return (name, "removed")
      default: return nil
      }
    }
    if let base = proposal.baseName ?? coachRoutine(proposal)?.name, base != proposal.proposedName {
      facts.append(("Name", base + " → " + proposal.proposedName))
    }
    if proposal.state == "pending", let routine = coachRoutine(proposal), coachReorders(proposal, routine) { facts.append(("Order", "changed")) }
    return facts
  }
  // Retry pushes the queued decision once more, never writing it twice, and records whether the log took it.
  func coachResendDecision(_ id: ID<Proposal>) {
    guard coachAccountAvailable, !authPaused, let runtime else {
      telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": "retry", "outcome": "failed"]); return
    }
    start()
    Task {
      await runtime.engine.flushOnLeave()
      let taken: Bool
      do { taken = try runner.read(Gym.scope) { try Self.queuedDecision(id, in: $0)?.isAdmitted ?? true } }
      catch { report("gym_read", error); taken = false }
      let outcome = taken ? "ok" : runtime.engine.status.online ? "failed" : "offline"
      telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": "retry", "outcome": outcome])
      runtime.engine.foreground(); refresh()
    }
  }
}

struct ProposalReviewSheet: View {
  let gym: GymModel
  let proposalId: String
  var ask: ((String) -> Void)? = nil
  var stallAfter: Duration = .seconds(15)
  let owner: String?
  @State var turningDown = false
  @State var seen: CoachReviewExtent?
  @State var extent: CoachReviewExtent?
  @State var submitted = false
  @State var stalled = false
  @State var resent = 0
  @Environment(\.dismiss) var dismiss
  @Environment(\.scenePhase) var phase
  init(gym: GymModel, proposalId: String, stallAfter: Duration = .seconds(15), ask: ((String) -> Void)? = nil) {
    self.gym = gym; self.proposalId = proposalId; self.stallAfter = stallAfter; self.ask = ask; owner = gym.account
  }
  var proposal: Proposal? { gym.proposals.first { $0.id.record.string == proposalId } }
  var routine: Routine? { proposal.flatMap(gym.coachRoutine) }
  var superseded: Bool {
    guard let proposal else { return false }
    if proposal.state == "superseded" || proposal.supersededBy != nil { return true }
    guard proposal.state == "pending", let base = proposal.baseRevision, let revision = routine?.revision else { return false }
    return revision > base
  }
  var pending: Bool { proposal.map { gym.coachProposalAwaitingReceipt($0.id) } ?? false }
  var decidable: Bool { proposal?.state == "pending" && !superseded && !pending && owner == gym.account && gym.coachAccountAvailable && !gym.readFailed }
  var changeRuns: [[RoutineChange]] {
    var runs: [[RoutineChange]] = []
    for change in proposal?.changes ?? [] {
      if change.kind == "kept", runs.last?.first?.kind == "kept" { runs[runs.count - 1].append(change) }
      else { runs.append([change]) }
    }
    return runs
  }
  var count: Int { proposal.map(gym.coachChangeCount) ?? 0 }
  var removal: Bool { proposal?.intent == "remove" }
  var applyLabel: String {
    if removal { return "Remove " + (routine?.name ?? proposal?.baseName ?? "routine") }
    return count > 1 ? "Apply all \(count)" : "Apply"
  }
  var seenEnd: Bool { seen != nil && seen == extent }
  var promise: String {
    if removal { return "The routine goes and your logged sets stay. Nothing is removed until you tap." }
    return count <= 1 ? "Nothing is applied until you tap." : "All \(count) or none. Nothing is applied until you tap."
  }
  // The band's one caption slot: it never empties and always holds the tallest line it can show, so Apply never moves.
  var captions: [String] { ["Scroll to the end to apply.", promise, "Finish this session to apply."] }
  var caption: String {
    if gym.openSession != nil { return captions[2] }
    return seenEnd ? promise : captions[0]
  }
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if owner != gym.account || !gym.coachAccountAvailable {
            Text("The account changed. Open this proposal again.")
          } else if gym.readFailed {
            Text("That proposal could not be read."); Button("Try again") { gym.refresh() }
          } else if let proposal {
            if !proposal.summary.isEmpty {
              Text(proposal.summary).padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(GymPalette.accent).frame(width: 3) }
            }
            if removal {
              diffCard("Remove \(routine?.name ?? proposal.baseName ?? "routine")", symbol: "minus", color: GymPalette.alarm) {
                Text("The whole routine is removed from your program. Every set you logged against it stays in the log.").font(.callout).foregroundStyle(GymPalette.inkDim)
              }
            } else {
              ForEach(Array(changeRuns.enumerated()), id: \.offset) { _, run in
                if run.first?.kind == "kept" {
                  DisclosureGroup("and \(GymCount.of(run.count, "line")) unchanged") {
                    ForEach(Array(run.enumerated()), id: \.offset) { _, change in changeRow(change) }
                  }.padding(12).background(GymPalette.card, in: RoundedRectangle(cornerRadius: 12))
                } else if let change = run.first { changeRow(change) }
              }
              if let routine, routine.name != proposal.proposedName {
                diffCard("Routine name", symbol: "pencil", color: GymPalette.accent) { Text("\(routine.name) → \(proposal.proposedName)").font(.callout) }
              }
              if let routine, gym.coachReorders(proposal, routine) {
                diffCard("Movement order", symbol: "arrow.up.arrow.down", color: GymPalette.accent) {
                  Text(routine.entries.map { name($0.exerciseId) }.joined(separator: " · ")).font(.callout).foregroundStyle(GymPalette.inkDim)
                  Text("→ " + proposal.document.map { name($0.exerciseId) }.joined(separator: " · ")).font(.callout)
                }
              }
            }
            if superseded { Text("This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands.").font(.callout).foregroundStyle(GymPalette.inkDim) }
            if let ask {
              Button { dismiss(); ask(routine?.name ?? proposal.baseName ?? "this routine") } label: {
                Text("Ask Coach").frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
              }
            }
          } else { Text("That proposal is gone.") }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
      }.onScrollGeometryChange(for: CoachReviewPosition.self) { geometry in
        let extent = CoachReviewExtent(content: geometry.contentSize.height, viewport: geometry.containerSize.height, width: geometry.containerSize.width)
        return CoachReviewPosition(extent: extent, atEnd: geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 1)
      } action: { _, position in
        extent = position.extent
        if position.atEnd, position.extent.viewport > 0, position.extent.content > 0 { seen = position.extent }
      }
      .roomTitle(routine?.name ?? proposal?.baseName ?? "Proposal", subtitle: proposal.map(gym.coachProposalSource)).modifier(GymPage())
      .modifier(ReviewBand(band: band))
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
      .alert("Turn this down?", isPresented: $turningDown) {
        Button("Turn down", role: .destructive) { if let proposal { submitted = gym.coachDecideProposal(proposal, apply: false) } }
        Button("Keep it", role: .cancel) {}
      } message: { Text("Nothing changes, and it stays in the routine’s history as a record.") }
      .sensoryFeedback(.success, trigger: !pending && submitted && ["applied", "dismissed"].contains(proposal?.state ?? ""))
      .onChange(of: proposal?.fields, initial: false) { _, _ in seen = nil }
      .task(id: "\(pending):\(resent)") {
        stalled = false
        guard pending else { return }
        do { try await Task.sleep(for: stallAfter) } catch { return }
        guard let proposal else { return }
        stalled = gym.coachDecisionStalled(proposal.id)
      }
    }.presentationDetents([.large])
      .accessibilityIdentifier("gym-proposal-review")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "review"]) }
  }
  @ViewBuilder var band: some View {
    VStack(spacing: RoomSpace.related) {
      GymTransient(gym: gym, errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo")
      if gym.coachRemovalReceipts.contains(where: { $0.proposal.id.description == proposalId && $0.outcome == .refused }) {
        Text("Nothing was applied.").font(.body.weight(.semibold))
          .onAppear { acknowledgeReceipt() }
          .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      }
      if decidable {
        ActionBand(title: applyLabel, room: .gym, disabled: !seenEnd || gym.openSession != nil, actionIdentifier: "coach-apply-proposal") {
          if let proposal { submitted = gym.coachDecideProposal(proposal, apply: true) }
        }.accessibilityHint(caption)
        ZStack {
          ForEach(captions, id: \.self) { Text($0).hidden() }
          Text(caption).foregroundStyle(GymPalette.inkDim)
        }.font(.footnote).multilineTextAlignment(.center).padding(.horizontal, RoomSpace.inset).accessibilityHidden(true)
        Button(role: .destructive) { turningDown = true } label: {
          Text("Turn this down").frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
        }.foregroundStyle(GymPalette.alarm).disabled(gym.openSession != nil)
      } else if owner != gym.account || !gym.coachAccountAvailable { EmptyView() }
      else if pending {
        HStack(spacing: RoomSpace.related) {
          if stalled {
            Text("Still waiting for the log.").foregroundStyle(GymPalette.inkDim)
            Button("Retry") { resent += 1; if let proposal { gym.coachResendDecision(proposal.id) } }.foregroundStyle(GymPalette.accent).accessibilityIdentifier("coach-review-retry")
          } else {
            ProgressView()
            Text("Waiting for the log…").foregroundStyle(GymPalette.inkDim)
          }
        }.font(.subheadline).frame(minHeight: RoomSpace.minimumTarget).padding(.horizontal, RoomSpace.inset)
      } else if let proposal {
        Text(proposal.state == "applied" ? "Applied" : proposal.state == "dismissed" ? "Turned down" : "Still waiting").font(.body.weight(.semibold))
          .onAppear { acknowledgeReceipt() }
          .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      }
    }.padding(.bottom, RoomSpace.inset).frame(maxWidth: .infinity)
  }
  func acknowledgeReceipt() {
    guard phase == .active, !pending, let proposal else { return }
    gym.coachRemovalReceiptShown(proposal.id, owner: owner)
  }
  func name(_ id: ID<Exercise>) -> String { gym.catalogue.find(id)?.name ?? "Movement unavailable" }
  func targets(_ value: EntryTargets?) -> String { CoachCopy.targets(value?.sets) }
  @ViewBuilder func changeRow(_ change: RoutineChange) -> some View {
    if change.kind == "kept" {
      DisclosureGroup("\(name(change.exerciseId)) · unchanged") {
        Text(targets(change.after)).font(.callout.monospacedDigit())
        ForEach(Array((change.after?.sets ?? []).enumerated()), id: \.offset) { i, target in Text("set \(i + 1) · \(Readout.setTarget(target)) kg").font(.callout.monospacedDigit()) }
      }.padding(12).background(GymPalette.card, in: RoundedRectangle(cornerRadius: 12))
    } else {
      diffCard((change.kind == "added" ? "Add " : change.kind == "removed" ? "Remove " : "") + name(change.exerciseId),
               symbol: change.kind == "added" ? "plus" : change.kind == "removed" ? "minus" : "arrow.right", color: change.kind == "removed" ? GymPalette.alarm : GymPalette.accent) {
        if change.kind == "removed" { Text("removed from the routine · logged sets kept").font(.callout).foregroundStyle(GymPalette.inkDim) }
        else if change.kind == "added" {
          Text(targets(change.after)).font(.callout.monospacedDigit())
          if let proposal, let index = proposal.document.firstIndex(where: { $0.exerciseId == change.exerciseId }) {
            Text(index == 0 ? "first in the routine" : "after " + name(proposal.document[index - 1].exerciseId)).font(.callout).foregroundStyle(GymPalette.inkDim)
          }
        } else {
          DisclosureGroup("\(targets(change.before)) → \(targets(change.after))") {
            let before = change.before?.sets ?? [], after = change.after?.sets ?? []
            ForEach(0..<max(before.count, after.count), id: \.self) { i in
              Text("set \(i + 1) · \(i < before.count ? Readout.setTarget(before[i]) : "—") → \(i < after.count ? Readout.setTarget(after[i]) : "—") kg").font(.callout.monospacedDigit())
            }
          }
          if change.before?.restSeconds != change.after?.restSeconds { Text("rest · \(change.before?.restSeconds.map(String.init) ?? "—") → \(change.after?.restSeconds.map(String.init) ?? "—") seconds").font(.callout) }
        }
      }
    }
  }
  func diffCard<Content: View>(_ title: String, symbol: String, color: Color, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) { Label(title, systemImage: symbol).font(.body.weight(.semibold)).foregroundStyle(color); content() }
      .frame(maxWidth: .infinity, alignment: .leading).padding(12).background(GymPalette.card, in: RoundedRectangle(cornerRadius: 12))
  }
}

// iOS 26 softens the diff where it scrolls under the band; earlier systems inset it.
struct ReviewBand<Band: View>: ViewModifier {
  let band: Band
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 26, *) { content.safeAreaBar(edge: .bottom) { band } }
    else { content.safeAreaInset(edge: .bottom) { band } }
  }
}
