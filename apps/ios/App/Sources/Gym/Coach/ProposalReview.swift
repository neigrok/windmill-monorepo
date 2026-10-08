import SwiftUI
import GymDomain
import DomainKit
import SyncSchema

nonisolated struct ProposalReviewID: Identifiable { let id: String }
nonisolated struct CoachReviewExtent: Equatable {
  let content: CGFloat
  let viewport: CGFloat
  let width: CGFloat
}
nonisolated struct CoachReviewPosition: Equatable { let extent: CoachReviewExtent; let atEnd: Bool }

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
    if changedAccount { shownCoachRemovals = [:] }
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
  }
  func coachProposalAwaitingReceipt(_ id: ID<Proposal>) -> Bool {
    if coachRemovalReceipts.contains(where: { $0.proposal.id == id && $0.outcome == .pending }) { return true }
    return (try? runner.read(Gym.scope) { read in
      try read.commands().contains { queued in
        [Gym.Commands.applyProposal, Gym.Commands.dismissProposal].contains(queued.command.name) && queued.command.args["proposalId"] == id.json
      }
    }) ?? true
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
    let outcome = apply ? run(ApplyProposalKeepingReceipt(proposal.id)) : run(DismissProposal(proposal.id))
    let ok = outcome != nil && outcome?.refusal == nil
    let removal = apply && proposal.intent == "remove"
    let awaiting = coachProposalAwaitingReceipt(proposal.id)
    if !ok || (!awaiting && !removal) {
      telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": apply ? "apply" : "dismiss", "outcome": ok ? "decided" : "failed"])
    }
    if ok, let runtime {
      Task {
        await runtime.engine.flushOnLeave(); runtime.engine.foreground(); refresh()
        if awaiting && !removal {
          let state = proposals.first { $0.id == proposal.id }?.state
          let confirmed = !coachProposalAwaitingReceipt(proposal.id) && ["applied", "dismissed"].contains(state ?? "")
          telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": apply ? "apply" : "dismiss", "outcome": confirmed ? "decided" : "failed"])
        }
      }
    }
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
      if let date { return source + " · " + Date(timeIntervalSince1970: Double(date.ms) / 1000).formatted(.dateTime.day().month(.abbreviated).hour().minute()) }
    } catch { report("gym_read", error) }
    return source
  }
}

struct ProposalReviewSheet: View {
  let gym: GymModel
  let proposalId: String
  var ask: ((String) -> Void)? = nil
  let owner: String?
  @State var turningDown = false
  @State var seen: CoachReviewExtent?
  @State var extent: CoachReviewExtent?
  @State var submitted = false
  @Environment(\.dismiss) var dismiss
  @Environment(\.scenePhase) var phase
  init(gym: GymModel, proposalId: String, ask: ((String) -> Void)? = nil) {
    self.gym = gym; self.proposalId = proposalId; self.ask = ask; owner = gym.account
  }
  var proposal: Proposal? { gym.proposals.first { $0.id.record.string == proposalId } }
  var routine: Routine? { proposal.flatMap { p in gym.routines.first { $0.id == p.routineId } } }
  var superseded: Bool {
    guard let proposal else { return false }
    if proposal.state == "superseded" || proposal.supersededBy != nil { return true }
    guard proposal.state == "pending", let base = proposal.baseRevision, let revision = routine?.revision else { return false }
    return revision > base
  }
  var pending: Bool { proposal.map { gym.coachProposalAwaitingReceipt($0.id) } ?? false }
  var decidable: Bool { proposal?.state == "pending" && !superseded && !pending && owner == gym.account && gym.coachAccountAvailable && gym.openSession == nil && !gym.readFailed }
  var changeRuns: [[RoutineChange]] {
    var runs: [[RoutineChange]] = []
    for change in proposal?.changes ?? [] {
      if change.kind == "kept", runs.last?.first?.kind == "kept" { runs[runs.count - 1].append(change) }
      else { runs.append([change]) }
    }
    return runs
  }
  var count: Int { proposal.map { p in routine.map { p.countChanges(comparedTo: $0) } ?? p.changeCount ?? p.changes.filter { $0.kind != "kept" }.count } ?? 0 }
  var applyLabel: String {
    if proposal?.intent == "remove" { return "Remove " + (routine?.name ?? proposal?.baseName ?? "routine") }
    return count > 1 ? "Apply all \(count)" : "Apply"
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
            Text(gym.coachProposalSource(proposal)).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
            if gym.openSession != nil { Text("Finish this session").font(.title3.weight(.semibold)) }
            else {
              if !proposal.summary.isEmpty {
                Text(proposal.door == "ask" ? "Coach wrote:" : proposal.agent.isEmpty && proposal.connection.isEmpty ? "Your agent wrote:" : "\(proposal.agent.isEmpty ? proposal.connection : proposal.agent) wrote:").font(.caption.weight(.semibold)).foregroundStyle(GymPalette.accent)
                Text(proposal.summary).padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(GymPalette.accent).frame(width: 3) }
              }
              if proposal.intent == "remove" {
                diffCard("Remove \(routine?.name ?? proposal.baseName ?? "routine")", symbol: "minus", color: .red) {
                  Text("The whole routine is removed from your program. Every set you logged against it stays in the log.").font(.callout).foregroundStyle(GymPalette.inkDim)
                }
              } else {
                ForEach(Array(changeRuns.enumerated()), id: \.offset) { _, run in
                  if run.first?.kind == "kept" {
                    DisclosureGroup("and \(run.count) \(run.count == 1 ? "line" : "lines") unchanged") {
                      ForEach(Array(run.enumerated()), id: \.offset) { _, change in changeRow(change) }
                    }.padding(12).background(GymPalette.card, in: RoundedRectangle(cornerRadius: 12))
                  } else if let change = run.first { changeRow(change) }
                }
                if let routine, routine.name != proposal.proposedName {
                  diffCard("Routine name", symbol: "pencil", color: GymPalette.accent) { Text("\(routine.name) → \(proposal.proposedName)").font(.callout) }
                }
                if let routine, routine.entries.map(\.exerciseId).filter({ proposal.document.map(\.exerciseId).contains($0) }) != proposal.document.map(\.exerciseId).filter({ routine.entries.map(\.exerciseId).contains($0) }) {
                  diffCard("Movement order", symbol: "arrow.up.arrow.down", color: GymPalette.accent) {
                    Text(routine.entries.map { name($0.exerciseId) }.joined(separator: " · ")).font(.callout).foregroundStyle(GymPalette.inkDim)
                    Text("→ " + proposal.document.map { name($0.exerciseId) }.joined(separator: " · ")).font(.callout)
                  }
                }
              }
              if superseded { Text("This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands.").font(.callout).foregroundStyle(GymPalette.inkDim) }
              if let ask { Button("Ask Coach") { dismiss(); ask(routine?.name ?? proposal.baseName ?? "this routine") } }
            }
          } else { Text("That proposal is gone.") }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
      }.onScrollGeometryChange(for: CoachReviewPosition.self) { geometry in
        let extent = CoachReviewExtent(content: geometry.contentSize.height, viewport: geometry.containerSize.height, width: geometry.containerSize.width)
        return CoachReviewPosition(extent: extent, atEnd: geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height + geometry.contentInsets.bottom - 1)
      } action: { _, position in
        extent = position.extent
        if position.atEnd, position.extent.viewport > 0, position.extent.content > 0 { seen = position.extent }
      }
      .navigationTitle(routine?.name ?? proposal?.baseName ?? "Proposal").modifier(GymPage())
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
      .safeAreaInset(edge: .bottom) { band }
      .alert("Turn this down?", isPresented: $turningDown) {
        Button("Turn down", role: .destructive) { if let proposal { submitted = gym.coachDecideProposal(proposal, apply: false) } }
        Button("Keep it", role: .cancel) {}
      } message: { Text("Nothing changes, and it stays in the routine’s history as a record.") }
      .sensoryFeedback(.success, trigger: !pending && submitted && ["applied", "dismissed"].contains(proposal?.state ?? ""))
      .onChange(of: proposal?.fields, initial: false) { _, _ in seen = nil }
    }.presentationDetents([.large]).presentationDragIndicator(.visible)
      .accessibilityIdentifier("gym-proposal-review")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "review"]) }
  }
  @ViewBuilder var band: some View {
    VStack(spacing: 10) {
      if gym.coachRemovalReceipts.contains(where: { $0.proposal.id.description == proposalId && $0.outcome == .refused }) {
        Text("Nothing was applied.").font(.body.weight(.semibold))
          .onAppear { acknowledgeReceipt() }
          .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      }
      if decidable {
        Button { if let proposal { submitted = gym.coachDecideProposal(proposal, apply: true) } } label: { Text(applyLabel).foregroundStyle(GymPalette.onAccent).frame(maxWidth: .infinity) }
          .modifier(RoomPrimaryStyle(accent: GymPalette.accent, onAccent: GymPalette.onAccent)).controlSize(.large).frame(maxWidth: .infinity)
          .disabled(seen == nil || seen != extent).accessibilityIdentifier("coach-apply-proposal")
          .accessibilityHint(seen == nil || seen != extent ? "Scroll to the end to apply." : "Apply every change together")
        Text(seen == nil || seen != extent ? "Scroll to the end to apply." : proposal?.intent == "remove" ? "The routine goes and your logged sets stay. Nothing is removed until you tap." : count <= 1 ? "Nothing is applied until you tap." : "All \(count) or none. Nothing is applied until you tap.")
          .font(.caption).foregroundStyle(GymPalette.inkDim).accessibilityHidden(true)
        Button("Turn this down", role: .destructive) { turningDown = true }.frame(minHeight: 44)
      } else if owner != gym.account || !gym.coachAccountAvailable { EmptyView() }
      else if pending { ProgressView("Waiting for the log to confirm…") }
      else if let proposal {
        Text(proposal.state == "applied" ? "Applied" : proposal.state == "dismissed" ? "Turned down" : "Still waiting").font(.body.weight(.semibold))
          .onAppear { acknowledgeReceipt() }
          .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      }
      if let error = gym.error { Text(error).font(.callout).foregroundStyle(.red) }
    }.padding(16).frame(maxWidth: .infinity).background(GymPalette.card).tint(GymPalette.accent)
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
               symbol: change.kind == "added" ? "plus" : change.kind == "removed" ? "minus" : "arrow.right", color: change.kind == "removed" ? .red : GymPalette.accent) {
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
