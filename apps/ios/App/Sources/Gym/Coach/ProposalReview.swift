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
  // The proposals, their removal receipts and the decisions still queued, in one read, so a decision the queue let go is
  // judged by the proposal state that came with it.
  nonisolated static func readCoachProposals(_ read: Reader) throws
    -> (replica: String, receipts: [RoutineRemovalReceipt], proposals: [Proposal], queued: Set<ID<Proposal>>) {
    let receipts = try RoutineRemovalReceipt.read(read)
    let decisions = try read.commands().filter { [Gym.Commands.applyProposal, Gym.Commands.dismissProposal].contains($0.command.name) }
    let all = try read.repository(Proposal.self).all(in: .drawn)
    let queued = Set(all.map(\.id).filter { id in decisions.contains { $0.command.args["proposalId"] == id.json } })
    let proposals = try all.map { proposal in
      if let receipt = receipts.first(where: { $0.proposal.id == proposal.id }) { return receipt.proposal }
      guard queued.contains(proposal.id), let confirmed = try read.confirmed(Proposal.self, proposal.id) else { return proposal }
      return try Proposal(Fields(confirmed))
    }
    return (read.replica, receipts, proposals, queued)
  }
  func updateCoachProposals(replica: String, receipts: [RoutineRemovalReceipt], proposals: [Proposal], queued: Set<ID<Proposal>>) {
    let changedAccount = proposalReadReplica != replica || isAnonymous
    let previous = changedAccount ? [] : coachRemovalReceipts
    if changedAccount { shownCoachRemovals = [:]; awaitedCoachDecisions = [:] }
    proposalReadReplica = replica
    publish(\.coachRemovalReceipts, receipts)
    var visible = proposals
    for proposal in coachRemovalReceipts.map(\.proposal) + Array(shownCoachRemovals.values) where !visible.contains(where: { $0.id == proposal.id }) {
      visible.append(proposal)
    }
    publish(\.proposals, visible)
    for receipt in coachRemovalReceipts where receipt.outcome != .pending {
      if previous.first(where: { $0.proposal.id == receipt.proposal.id })?.outcome != receipt.outcome {
        telemetry.event("gym_proposal_outcome", properties: ["screen": "review", "action": "apply", "outcome": receipt.outcome == .applied ? "decided" : "failed"])
      }
    }
    // Any other decision is recorded once the log's answer reaches the phone: the queue lets it go, the proposal says how.
    for (id, decision) in awaitedCoachDecisions where !queued.contains(id) {
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
    guard openSession == nil else { error = "Finish your workout first."; return false }
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
  // *proposed by Coach · Sep 26 · 6:42 PM*: who proposed it, then when the log took it, its record's creation; none before.
  func coachProposalSource(_ proposal: Proposal) -> String {
    let source: String
    switch proposal.provenance {
    case .ask: source = "proposed by Coach"
    case .mcp(let connection, let agent): source = "proposed by " + (agent.isEmpty ? connection : agent)
    case .other: source = "proposed by a connected tool"
    }
    guard let created = proposalCreatedAt(proposal) else { return source }
    return source + " · " + dates.dayAndTime(created)
  }
  func coachRoutine(_ proposal: Proposal) -> Routine? { routines.first { $0.id == proposal.routineId } }
  // Out of date, it can no longer be applied: a newer proposal replaced it, or its routine moved while it waited.
  func coachProposalOutOfDate(_ proposal: Proposal) -> Bool {
    if proposal.state == "superseded" || proposal.supersededBy != nil { return true }
    guard proposal.state == "pending", let base = proposal.baseRevision, let revision = coachRoutine(proposal)?.revision else { return false }
    return revision > base
  }
  // Whether a proposal moves its movements: against its routine while it waits, by the store's count once it settled.
  func coachReorders(_ proposal: Proposal, besides lines: [CoachChange]) -> Bool {
    guard proposal.state == "pending" else { return proposal.changeCount == lines.filter { !$0.kept }.count + 1 }
    guard let routine = coachRoutine(proposal) else { return false }
    let proposed = proposal.document.map(\.exerciseId), current = routine.entries.map(\.exerciseId)
    return current.filter { proposed.contains($0) } != proposed.filter { current.contains($0) }
  }
  // The store's count wherever a proposal's changes are counted; the Review's rows until the store has counted it.
  func coachChangeCount(_ proposal: Proposal) -> Int { proposal.changeCount ?? coachChanges(proposal).filter { !$0.kept }.count }
  // A proposal's lines for its card and its Review: each movement in the proposal's order, then a new name and a new order.
  func coachChanges(_ proposal: Proposal) -> [CoachChange] {
    let routine = coachRoutine(proposal)
    guard proposal.intent != "remove" else { return [CoachChange(removing: routine?.name ?? proposal.baseName ?? "Routine")] }
    let name = { (id: ID<Exercise>) in self.catalogue.find(id)?.name ?? "Movement unavailable" }
    var lines = proposal.changes.map { change -> CoachChange in
      switch change.kind {
      case "retargeted": return CoachChange(symbol: "arrow.right", title: name(change.exerciseId), change: CoachChange.retarget(change.before, change.after))
      case "added":
        let at = proposal.document.firstIndex { $0.exerciseId == change.exerciseId } ?? 0
        let place = at == 0 ? "first in the routine" : "after " + name(proposal.document[at - 1].exerciseId)
        return CoachChange(symbol: "plus", title: name(change.exerciseId), change: ["Added", CoachChange.scheme(change.after?.sets), place].joined(separator: " · "))
      case "removed":
        return CoachChange(symbol: "minus", title: name(change.exerciseId), change: ["Removed", CoachChange.scheme(change.before?.sets)].joined(separator: " · "))
      default: return CoachChange(symbol: nil, title: name(change.exerciseId), change: CoachChange.scheme(change.after?.sets), kept: true)
      }
    }
    if let base = proposal.baseName ?? routine?.name, base != proposal.proposedName {
      lines.append(CoachChange(symbol: "pencil", title: "Name", change: base + " → " + proposal.proposedName))
    }
    if coachReorders(proposal, besides: lines) {
      lines.append(CoachChange(symbol: "arrow.up.arrow.down", title: "Order", change: proposal.document.map { name($0.exerciseId) }.joined(separator: " · ")))
    }
    return lines
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

// One line of a proposal, the same on its card and in its Review: the symbol is its one accent; a removal is alarm.
struct CoachChange: Equatable {
  let symbol: String?
  let title: String
  var change: String?
  var kept = false
  var removal = false

  init(symbol: String?, title: String, change: String?, kept: Bool = false) {
    self.symbol = symbol; self.title = title; self.change = change; self.kept = kept
  }
  init(removing routine: String) { symbol = "minus"; title = routine; removal = true }

  var row: GymRow {
    GymRow(title: title, meta: change, leading: symbol.map { .symbol($0, removal ? GymPalette.alarm : GymPalette.accent) },
           titleColor: removal ? GymPalette.alarm : GymPalette.ink)
  }

  // A scheme on one line: *3 × 5 · 80 kg* when its sets agree, set by set when they differ, *open* with none.
  static func scheme(_ sets: [SetTarget]?) -> String { line([sets]) }
  // *1 × 5 · 80 → 1 × 3 · 90 kg*, then a changed rest as the workout's clock reads it, *rest 1:30 → 2:00*, or *default*.
  static func retarget(_ before: EntryTargets?, _ after: EntryTargets?) -> String {
    let clock = { (seconds: Int?) in seconds.map { WorkoutClocks.reading(Int64($0) * 1_000) } ?? "default" }
    let rest = before?.restSeconds == after?.restSeconds ? nil : "rest \(clock(before?.restSeconds)) → \(clock(after?.restSeconds))"
    let sets = before?.sets == after?.sets ? nil : line([before?.sets, after?.sets])
    return [sets, rest].compactMap { $0 }.joined(separator: " · ")
  }
  // Schemes joined by arrows in one notation, set by set when any of them varies, with the unit once at the end.
  static func line(_ schemes: [[SetTarget]?]) -> String {
    let varied = schemes.contains { Set(($0 ?? []).map(Readout.setTarget)).count > 1 }
    let drawn = schemes.map { sets -> String in
      guard varied, let sets, !sets.isEmpty else { return Readout.target(sets) }
      return Readout.ladder(sets)
    }
    let weighed = schemes.contains { ($0 ?? []).contains { $0.weightKg != nil } }
    return drawn.joined(separator: " → ") + (weighed ? " kg" : "")
  }
}

extension RoomColors {
  // A removal's primary: the alarm fill with white on it (ios-redesign.md §6).
  static let gymRemoval = RoomColors(ink: GymPalette.ink, inkDim: GymPalette.inkDim, card: GymPalette.card, accent: GymPalette.alarmFill,
                                     onAccent: GymPalette.onAlarm)
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
  @State var unfolded: Set<Int> = []
  @State var landed = false
  @Environment(\.dismiss) var dismiss
  @Environment(\.scenePhase) var phase
  init(gym: GymModel, proposalId: String, stallAfter: Duration = .seconds(15), ask: ((String) -> Void)? = nil) {
    self.gym = gym; self.proposalId = proposalId; self.stallAfter = stallAfter; self.ask = ask; owner = gym.account
  }
  var proposal: Proposal? { gym.proposals.first { $0.id.record.string == proposalId } }
  var routine: Routine? { proposal.flatMap(gym.coachRoutine) }
  var routineName: String { routine?.name ?? proposal?.baseName ?? "Routine" }
  // Why an out-of-date proposal has no Apply, said once where Apply stood.
  var outOfDate: String? {
    guard let proposal, gym.coachProposalOutOfDate(proposal) else { return nil }
    if proposal.supersededBy != nil { return "A newer proposal replaced this one. Nothing was applied." }
    if proposal.state == "pending" { return "\(routineName) changed after this was written. Nothing was applied." }
    return "This proposal is out of date. Nothing was applied."
  }
  // The decision the log has not answered yet, while it waits.
  var waiting: CoachQueuedDecision? { proposal.flatMap { gym.coachQueuedDecision($0.id) } }
  var pending: Bool { waiting != nil }
  var decidable: Bool {
    guard let proposal, proposal.state == "pending", !gym.coachProposalOutOfDate(proposal) else { return false }
    return !pending && owner == gym.account && gym.coachAccountAvailable && !gym.readFailed
  }
  var changes: [CoachChange] { proposal.map(gym.coachChanges) ?? [] }
  var count: Int { proposal.map(gym.coachChangeCount) ?? 0 }
  // The diff's rows in order, each unchanged run gathered into one row that unfolds in place.
  var runs: [[CoachChange]] {
    var runs: [[CoachChange]] = []
    for change in changes {
      if change.kept, runs.last?.first?.kept == true { runs[runs.count - 1].append(change) } else { runs.append([change]) }
    }
    return runs
  }
  var removal: Bool { proposal?.intent == "remove" }
  // The one primary keeps its place through the wait: Apply, the act in flight until the log answers, then Retry.
  var primaryTitle: String {
    if stalled { return "Retry" }
    switch waiting {
    case nil: return removal ? "Remove " + routineName : "Apply"
    case .apply: return removal ? "Removing…" : "Applying…"
    case .dismiss: return "Turning down…"
    case .unreadable: return "Sending…"
    }
  }
  var seenEnd: Bool { seen != nil && seen == extent }
  var promise: String {
    if removal { return "Your logged sets stay. Nothing is removed until you tap." }
    return count > 1 ? "All or none. Nothing changes until you tap." : "Nothing changes until you tap."
  }
  // The band's one caption slot: it never empties and always holds the tallest line it can show, so Apply never moves.
  var captions: [String] { ["Scroll to the end to apply.", promise, "Finish your workout to apply.", "Not confirmed yet."] }
  var caption: String {
    if stalled { return captions[3] }
    if pending { return promise }
    if gym.openSession != nil { return captions[2] }
    return seenEnd ? promise : captions[0]
  }
  var body: some View {
    NavigationStack {
      List {
        if owner != gym.account || !gym.coachAccountAvailable {
          Text("The account changed. Open this proposal again.")
        } else if gym.readFailed {
          Text("That proposal could not be read."); Button("Try again") { gym.refresh() }
        } else if let proposal {
          if !proposal.summary.isEmpty {
            Text(proposal.summary).padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(GymPalette.accent).frame(width: 3) }
              .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: RoomSpace.inset, bottom: 0, trailing: RoomSpace.inset))
          }
          Section {
            ForEach(Array(runs.enumerated()), id: \.offset) { index, run in
              if run.first?.kept == true { unchanged(run, index: index) } else { run[0].row }
            }
          } header: { if !removal { Text(GymCount.of(count, "change")) } }
            .listRowBackground(GymPalette.card)
          if let ask {
            Button("Ask Coach") { dismiss(); ask(routineName) }.foregroundStyle(GymPalette.accent).listRowBackground(Color.clear)
          }
        } else { Text("That proposal is gone.") }
      }.listStyle(.insetGrouped)
        .onScrollGeometryChange(for: CoachReviewPosition.self) { geometry in
          let extent = CoachReviewExtent(content: geometry.contentSize.height, viewport: geometry.containerSize.height, width: geometry.containerSize.width)
          return CoachReviewPosition(extent: extent, atEnd: geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 1)
        } action: { _, position in
          extent = position.extent
          if position.atEnd, position.extent.viewport > 0, position.extent.content > 0 { seen = position.extent }
        }
        .roomTitle(routine?.name ?? proposal?.baseName ?? "Proposal", subtitle: proposal.map(gym.coachProposalSource)).modifier(GymPage())
        .reachBand { band }
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
  // A run of unchanged movements: one row, *4 unchanged*, that unfolds them in place under a turning chevron.
  @ViewBuilder func unchanged(_ run: [CoachChange], index: Int) -> some View {
    let open = unfolded.contains(index)
    Button {
      withAnimation { if open { unfolded.remove(index) } else { unfolded.insert(index) } }
    } label: {
      HStack(spacing: RoomSpace.related) {
        Text("\(run.count) unchanged").foregroundStyle(GymPalette.ink).frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "chevron.down").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkDim)
          .rotationEffect(.degrees(open ? 180 : 0)).accessibilityHidden(true)
      }.frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityValue(open ? "expanded" : "collapsed").accessibilityIdentifier("coach-review-unchanged")
    if open { ForEach(Array(run.enumerated()), id: \.offset) { _, change in change.row } }
  }
  // Apply, its caption and Turn this down until the log answers; then the receipt stands in their place, or why it is out of date.
  @ViewBuilder var band: some View {
    VStack(spacing: RoomSpace.related) {
      GymTransient(gym: gym, errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo")
      if owner != gym.account || !gym.coachAccountAvailable { EmptyView() }
      else if let proposal, !pending, ["applied", "dismissed"].contains(proposal.state) { receipt(proposal) }
      else if !pending, let outOfDate {
        Text(outOfDate).font(.subheadline).foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.center)
          .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget).padding(.horizontal, RoomSpace.inset)
          .accessibilityIdentifier("coach-review-out-of-date")
          .onAppear { acknowledgeReceipt() }
          .onChange(of: phase) { _, _ in acknowledgeReceipt() }
      }
      else if decidable || pending {
        if gym.coachRemovalReceipts.contains(where: { $0.proposal.id.description == proposalId && $0.outcome == .refused }) {
          Text("Nothing was applied.").font(.body.weight(.semibold))
            .onAppear { acknowledgeReceipt() }
            .onChange(of: phase) { _, _ in acknowledgeReceipt() }
        }
        primary
        ZStack {
          ForEach(captions, id: \.self) { Text($0).hidden() }
          Text(caption).foregroundStyle(GymPalette.inkDim)
        }.font(.footnote).multilineTextAlignment(.center).padding(.horizontal, RoomSpace.inset).accessibilityHidden(true)
        Button { turningDown = true } label: {
          Text("Turn this down").frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
        }.foregroundStyle(GymPalette.inkDim).disabled(pending || gym.openSession != nil)
      }
    }.padding(.bottom, RoomSpace.inset).frame(maxWidth: .infinity).animation(.default, value: proposal?.state)
  }
  var primary: some View {
    ActionBand(title: primaryTitle, room: removal ? .gymRemoval : .gym, disabled: !stalled && (pending || !seenEnd || gym.openSession != nil),
               busy: pending && !stalled, actionIdentifier: "coach-apply-proposal", role: removal && !stalled ? .destructive : nil) {
      guard let proposal else { return }
      if stalled { resent += 1; gym.coachResendDecision(proposal.id) } else { submitted = gym.coachDecideProposal(proposal, apply: true) }
    }.accessibilityHint(caption)
  }
  // Where Apply stood, the settled word alone: *Applied* or *Removed* with its check bouncing in, or *Turned down*, quiet.
  func receipt(_ proposal: Proposal) -> some View {
    let applied = proposal.state == "applied"
    return HStack(spacing: RoomSpace.related) {
      if applied { Image(systemName: "checkmark").foregroundStyle(GymPalette.done).symbolEffect(.bounce, value: landed).accessibilityHidden(true) }
      if let word = CoachCopy.settled(proposal.state, removal: removal) { Text(word).foregroundStyle(applied ? GymPalette.ink : GymPalette.inkDim) }
    }.font(.body.weight(.semibold)).multilineTextAlignment(.center).frame(minHeight: RoomSpace.minimumTarget).padding(RoomSpace.inset)
      .accessibilityElement(children: .combine).accessibilityIdentifier("coach-review-receipt")
      .onAppear { landed = true; acknowledgeReceipt() }
      .onChange(of: phase) { _, _ in acknowledgeReceipt() }
  }
  func acknowledgeReceipt() {
    guard phase == .active, !pending, let proposal else { return }
    gym.coachRemovalReceiptShown(proposal.id, owner: owner)
  }
}
