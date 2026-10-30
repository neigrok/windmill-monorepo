import SwiftUI
import GymDomain
import DomainKit
import SyncAPI
import SyncSchema

// The decision a proposal waits on the log for; an unreadable queue may hold one, and cannot say which.
nonisolated enum CoachQueuedDecision: String { case apply, reject, unreadable }
// Why a proposal can no longer be applied: a newer proposal took its place, its routine changed under it, or, for a change
// to the open workout, the workout's plan changed, the workout finished or a movement it changes was logged.
nonisolated enum CoachOutOfDate: Equatable {
  case replaced, routineChanged, workoutChanged, workoutFinished
  case workoutMoved(ID<Exercise>)

  init(_ outOfDate: WorkoutProposalState.OutOfDate) {
    switch outOfDate.reason {
    case .replaced: self = .replaced
    case .workoutFinished: self = .workoutFinished
    case .workoutChanged: self = .workoutChanged
    case .workoutMoved: self = outOfDate.exerciseId.map(CoachOutOfDate.workoutMoved) ?? .workoutChanged
    }
  }
}
// Where a proposal stands, as its card draws it: waiting on the lifter (or on the log for an Apply), applied, rejected, or
// out of date and why.
nonisolated enum ProposalStance: Equatable { case open, applied, rejected, outOfDate(CoachOutOfDate) }
// The proposals, their removal receipts, the decisions still queued and the proposals out of date, as one read saw them;
// beside them, the workout proposals the same way.
nonisolated struct CoachProposalsRead {
  let replica: String
  let receipts: [RoutineRemovalReceipt]
  let proposals: [Proposal]
  let queued: Set<ID<Proposal>>
  let outOfDate: [ID<Proposal>: CoachOutOfDate]
  let workoutProposals: [WorkoutProposal]
  let workoutQueued: Set<ID<WorkoutProposal>>
  let workoutOutOfDate: [ID<WorkoutProposal>: CoachOutOfDate]
}

extension Proposal {
  // Who proposed it, said on the Routines row: Coach, the name the tool gave — its agent, else its connection — or *a
  // connected tool* when it gave none.
  nonisolated var sourceName: String {
    switch provenance {
    case .ask: "Coach"
    case .mcp(let connection, let agent): !agent.isEmpty ? agent : !connection.isEmpty ? connection : "a connected tool"
    case .other: "a connected tool"
    }
  }
}

extension GymModel {
  // One read, so a decision the queue let go is judged by the proposal state that came with it, and a proposal is out of
  // date by the domain's own Apply rule over the routine as this phone stores it and as the log confirmed it.
  nonisolated static func readCoachProposals(_ read: Reader) throws -> CoachProposalsRead {
    let receipts = try RoutineRemovalReceipt.read(read)
    let decisions = try read.commands().filter { [Gym.Commands.applyProposal, Gym.Commands.dismissProposal].contains($0.command.name) }
    let all = try read.repository(Proposal.self).all(in: .drawn)
    let queued = Set(all.map(\.id).filter { id in decisions.contains { $0.command.args["proposalId"] == id.json } })
    let proposals = try all.map { proposal in
      if let receipt = receipts.first(where: { $0.proposal.id == proposal.id }) { return receipt.proposal }
      guard queued.contains(proposal.id), let confirmed = try read.confirmed(Proposal.self, proposal.id) else { return proposal }
      return try Proposal(Fields(confirmed))
    }
    var outOfDate: [ID<Proposal>: CoachOutOfDate] = [:]
    for proposal in proposals {
      let state = try ProposalState(read, id: proposal.id)
      guard state.outOfDate else { continue }
      // The domain's refusal names the reason, *routine-changed* or a replacement; a routine gone counts as changed.
      switch state.refusal(for: proposal.id, applying: true) {
      case .proposalSuperseded(let refused): outOfDate[proposal.id] = (try? refused.detail?.member("reason").asString()) == "routine-changed" ? .routineChanged : .replaced
      case .gone: outOfDate[proposal.id] = .routineChanged
      default: outOfDate[proposal.id] = .replaced
      }
    }
    let workoutDecisions = try read.commands().filter { [Gym.Commands.applyWorkoutProposal, Gym.Commands.dismissWorkoutProposal].contains($0.command.name) }
    let workouts = try read.repository(WorkoutProposal.self).all(in: .drawn)
    let workoutQueued = Set(workouts.map(\.id).filter { id in workoutDecisions.contains { $0.command.args["proposalId"] == id.json } })
    var workoutOutOfDate: [ID<WorkoutProposal>: CoachOutOfDate] = [:]
    for proposal in workouts {
      guard let reason = try WorkoutProposalState(read, id: proposal.id).outOfDate else { continue }
      workoutOutOfDate[proposal.id] = CoachOutOfDate(reason)
    }
    return CoachProposalsRead(replica: read.replica, receipts: receipts, proposals: proposals, queued: queued, outOfDate: outOfDate,
                              workoutProposals: workouts, workoutQueued: workoutQueued, workoutOutOfDate: workoutOutOfDate)
  }
  // The log's refusal of a proposal out of date, said as its card says it (08.57): the refusal's reason, the movement a
  // change to this workout touches that took a set since, and the routine a routine proposal changes.
  func supersededReason(_ refused: Refused) -> String {
    let workout = workoutProposals.first { $0.id.ref == refused.subject }
    let routine = proposals.first { $0.id.ref == refused.subject }
    let moved = workout.flatMap { proposal in
      proposal.changes.first { change in change.kind != "kept" && sets.contains { $0.sessionId == proposal.sessionId && $0.exerciseId == change.exerciseId } }
    }
    let reason: CoachOutOfDate? = switch try? refused.detail?.member("reason").asString() {
    case "replaced": .replaced
    case "routine-changed": .routineChanged
    case "workout-changed": .workoutChanged
    case "workout-finished": .workoutFinished
    case "workout-moved": moved.map { .workoutMoved($0.exerciseId) } ?? .workoutChanged
    default: nil
    }
    guard let reason else { return "This suggestion is out of date. Nothing was applied." }
    return CoachCopy.outOfDateReason(reason, routine: routine.flatMap { $0.baseName ?? coachRoutine($0)?.name } ?? "The routine", catalogue: catalogue)
  }
  func updateCoachProposals(_ read: CoachProposalsRead) {
    if proposalReadReplica != read.replica || isAnonymous {
      shownCoachRemovals = [:]; awaitedCoachDecisions = [:]; stalledCoachDecisions = []; waitingCoachDiffs = [:]
      sentCoachApplies = []; landedCoachApplies = []; refusedCoachApplies = []; awaitedWorkoutDecisions = [:]
    }
    proposalReadReplica = read.replica
    publish(\.workoutProposals, read.workoutProposals)
    publish(\.outOfDateWorkoutProposals, read.workoutOutOfDate)
    // A decision on a workout proposal is recorded once the log's answer reaches the phone, as a routine proposal's is.
    for (id, decision) in awaitedWorkoutDecisions where !read.workoutQueued.contains(id) {
      awaitedWorkoutDecisions[id] = nil
      let taken = read.workoutProposals.first { $0.id == id }?.state == (decision == .apply ? "applied" : "dismissed")
      telemetry.event("gym_proposal_outcome", properties: ["screen": "coach", "target": "workout", "action": decision.rawValue, "outcome": taken ? "decided" : "failed"])
    }
    publish(\.coachRemovalReceipts, read.receipts)
    var visible = read.proposals
    for proposal in coachRemovalReceipts.map(\.proposal) + Array(shownCoachRemovals.values) where !visible.contains(where: { $0.id == proposal.id }) {
      visible.append(proposal)
    }
    publish(\.proposals, visible)
    publish(\.outOfDateProposals, read.outOfDate)
    // A removal's answer is its receipt, recorded once: the receipt keeps that it was, across launches, until it is seen.
    if coachRemovalReceipts.contains(where: { $0.outcome != .pending && !$0.recorded }) {
      do {
        if case .committed(let settled, _) = try runner.run(RecordRoutineRemovalOutcomes(replica: read.replica)) {
          for receipt in settled {
            telemetry.event("gym_proposal_outcome", properties: ["screen": "coach", "target": "routine", "action": "apply", "outcome": receipt.outcome == .applied ? "decided" : "failed"])
          }
        }
      } catch { report("gym_action", error) }
    }
    // An Apply this phone sent is judged once the log's answer reaches it: taken, it has landed; refused, its card says so.
    for id in sentCoachApplies where !read.queued.contains(id) {
      sentCoachApplies.remove(id)
      if visible.first(where: { $0.id == id })?.state == "applied" { landedCoachApplies.insert(id) } else { refusedCoachApplies.insert(id) }
    }
    // Any other decision is recorded once the log's answer reaches the phone: the queue lets it go, the proposal says how.
    for (id, decision) in awaitedCoachDecisions where !read.queued.contains(id) {
      awaitedCoachDecisions[id] = nil
      let taken = visible.first { $0.id == id }?.state == (decision == .apply ? "applied" : "dismissed")
      telemetry.event("gym_proposal_outcome", properties: ["screen": "coach", "target": "routine", "action": decision.rawValue, "outcome": taken ? "decided" : "failed"])
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
      return queued.map { $0.command.name == Gym.Commands.dismissProposal ? .reject : .apply }
    } catch { report("gym_read", error); return .unreadable }
  }
  func coachProposalAwaitingReceipt(_ id: ID<Proposal>) -> Bool { coachQueuedDecision(id) != nil }
  // After the card's wait, a decision still queued has stalled. Its event names it unless the queue cannot be read, and is
  // recorded once for the decision, however many waits run out on it after: a Retry's, or its card drawn again.
  func coachDecisionStalled(_ id: ID<Proposal>) -> Bool {
    guard let decision = coachQueuedDecision(id) else { return false }
    guard stalledCoachDecisions.insert(id).inserted else { return true }
    var properties = ["screen": "coach", "target": "routine", "outcome": "stalled"]
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
    start()
    stalledCoachDecisions.remove(proposal.id); refusedCoachApplies.remove(proposal.id)
    let decision: CoachQueuedDecision = apply ? .apply : .reject
    let outcome = apply ? run(ApplyProposalKeepingReceipt(proposal.id)) : run(DismissProposal(proposal.id))
    let ok = outcome != nil && outcome?.refusal == nil
    let removal = apply && proposal.intent == "remove"
    let queued = ok && coachProposalAwaitingReceipt(proposal.id)
    if queued && apply { sentCoachApplies.insert(proposal.id) }
    // A removal's answer is its receipt; any other queued decision waits for updateCoachProposals to see the log's answer.
    if queued && !removal { awaitedCoachDecisions[proposal.id] = decision }
    else if !ok || !removal {
      telemetry.event("gym_proposal_outcome", properties: ["screen": "coach", "target": "routine", "action": decision.rawValue, "outcome": ok ? "decided" : "failed"])
    }
    if ok, let runtime { Task { await runtime.engine.flushOnLeave(); runtime.engine.foreground(); refresh() } }
    return ok
  }
  func coachRoutine(_ proposal: Proposal) -> Routine? { routines.first { $0.id == proposal.routineId } }
  // A change block's title on either card: its movement's name, none for a rename.
  func coachTitle(_ block: ProposalDiff.Block) -> String? {
    block.exerciseId.map { catalogue.find($0)?.name ?? "Movement unavailable" }
  }
  // Out of date, it can no longer be applied: the domain's own Apply rule says so (readCoachProposals).
  func coachProposalOutOfDate(_ proposal: Proposal) -> Bool { outOfDateProposals[proposal.id] != nil }
  // A proposal as its card reads it: against its routine while it waits, a dumbbell pair's load said per hand. Once a
  // decision is on its way the routine no longer holds the order it replaced, so the card keeps the blocks this phone last
  // read while the proposal waited on the lifter, its moves among them.
  func coachDiff(_ proposal: Proposal) -> ProposalDiff {
    if let kept = waitingCoachDiffs[proposal.id], proposal.state != "pending" || coachQueuedDecision(proposal.id) != nil { return kept }
    let each = proposal.changes.map(\.exerciseId).filter { MovementEquipment(catalogue.find($0)).each }
    let diff = ProposalDiff(proposal, routine: coachRoutine(proposal), each: Set(each))
    if proposal.state == "pending", !coachProposalOutOfDate(proposal) { waitingCoachDiffs[proposal.id] = diff }
    return diff
  }
  // The store's count wherever a proposal's changes are counted; the domain's count over its routine until the store has
  // counted it.
  func coachChangeCount(_ proposal: Proposal) -> Int {
    proposal.changeCount ?? coachRoutine(proposal).map(proposal.countChanges) ?? coachDiff(proposal).blocks.count
  }
  // Reject settles a proposal at once; an Apply keeps it open until the log answers.
  func coachProposalStance(_ proposal: Proposal) -> ProposalStance {
    let waiting = coachQueuedDecision(proposal.id)
    if waiting == .reject || (proposal.state == "dismissed" && waiting == nil) { return .rejected }
    if waiting != nil { return .open }
    if proposal.state == "applied" { return .applied }
    if let reason = outOfDateProposals[proposal.id] { return .outOfDate(reason) }
    return .open
  }
  // The one word a proposal's card stands on, said again on its Routines row: Applied or Removed, Rejected, Out of date, or
  // Not applied while the log's refusal of its Apply stands; none while it waits.
  func coachProposalWord(_ proposal: Proposal) -> String? {
    switch coachProposalStance(proposal) {
    case .applied: CoachCopy.settled("applied", removal: proposal.intent == "remove")
    case .rejected: CoachCopy.settled("dismissed", removal: proposal.intent == "remove")
    case .outOfDate: CoachCopy.outOfDate
    case .open: coachQueuedDecision(proposal.id) == nil && coachApplyRefusal(proposal) != nil ? CoachCopy.notApplied : nil
    }
  }
  // Why the log refused the Apply this phone sent, while the proposal still waits: the cause its notice names, where the card
  // can say it, else only that nothing was applied. A refusal this phone saw arrive counts when the notice is gone.
  func coachApplyRefusal(_ proposal: Proposal) -> String? {
    guard proposal.state == "pending" else { return nil }
    let notice = notices.last { notice in
      notice.notice.content.command.map { $0.name == Gym.Commands.applyProposal && $0.args["proposalId"] == proposal.id.json } ?? false
    }
    let receipt = coachRemovalReceipts.contains { $0.proposal.id == proposal.id && $0.outcome == .refused }
    guard notice != nil || receipt || refusedCoachApplies.contains(proposal.id) else { return nil }
    return CoachCopy.notApplied(notice?.refusal, routine: proposal.baseName ?? coachRoutine(proposal)?.name ?? "The routine")
  }
  // Whether the engine says a decision could not reach the log: no network, or a push that got no answer. A wait alone
  // never says so.
  var coachDecisionUnreached: Bool {
    guard let status = runtime?.engine.status else { return false }
    return !status.online || status.unansweredPushes.contains(Gym.scope)
  }
  // Try again pushes the queued decision once more, never writing it twice, and records whether the log took it.
  @discardableResult func coachResendDecision(_ id: ID<Proposal>) -> Task<Void, Never>? {
    guard coachAccountAvailable, !authPaused, let runtime else {
      telemetry.event("gym_proposal_outcome", properties: ["screen": "coach", "target": "routine", "action": "retry", "outcome": "failed"]); return nil
    }
    start()
    if coachQueuedDecision(id) == .apply { sentCoachApplies.insert(id) }
    return Task {
      await runtime.engine.flushOnLeave()
      let taken: Bool
      do { taken = try runner.read(Gym.scope) { try Self.queuedDecision(id, in: $0)?.isAdmitted ?? true } }
      catch { report("gym_read", error); taken = false }
      // Offline when nothing reached the log, no network or no answer; failed when the log answered with a failure.
      let outcome = taken ? "ok" : coachDecisionUnreached ? "offline" : "failed"
      telemetry.event("gym_proposal_outcome", properties: ["screen": "coach", "target": "routine", "action": "retry", "outcome": outcome])
      runtime.engine.foreground(); refresh()
    }
  }

  // MARK: - Changes to the open workout

  // Apply rewrites the running plan at once and the log confirms it; Reject sets the change aside. Neither touches a
  // routine. Its event waits for the log's answer while the decision is queued.
  func coachDecideWorkoutProposal(_ proposal: WorkoutProposal, apply: Bool) -> Bool {
    guard coachAccountAvailable, !authPaused else { error = "Sign in to review this proposal."; return false }
    start()
    let decision: CoachQueuedDecision = apply ? .apply : .reject
    let outcome = apply ? run(ApplyWorkoutProposal(proposal.id)) : run(DismissWorkoutProposal(proposal.id))
    let ok = outcome != nil && outcome?.refusal == nil
    let queued: Bool
    do {
      queued = try runner.read(Gym.scope) { read in
        try read.commands().contains { [Gym.Commands.applyWorkoutProposal, Gym.Commands.dismissWorkoutProposal].contains($0.command.name)
          && $0.command.args["proposalId"] == proposal.id.json }
      }
    } catch { report("gym_read", error); queued = false }
    if ok && queued { awaitedWorkoutDecisions[proposal.id] = decision }
    else { telemetry.event("gym_proposal_outcome", properties: ["screen": "coach", "target": "workout", "action": decision.rawValue, "outcome": ok ? "decided" : "failed"]) }
    if ok, let runtime { Task { await runtime.engine.flushOnLeave(); runtime.engine.foreground(); refresh() } }
    return ok
  }
  func coachWorkout(_ proposal: WorkoutProposal) -> Session? { sessions.first { $0.id == proposal.sessionId } }
  // A workout proposal as its card reads it: against the workout's plan while it waits, a dumbbell pair's load said per hand.
  func coachWorkoutDiff(_ proposal: WorkoutProposal) -> ProposalDiff {
    let each = proposal.changes.map(\.exerciseId).filter { MovementEquipment(catalogue.find($0)).each }
    return ProposalDiff(proposal, plan: coachWorkout(proposal)?.plan, each: Set(each))
  }
  func coachWorkoutChangeCount(_ proposal: WorkoutProposal) -> Int {
    proposal.changeCount ?? coachWorkout(proposal)?.plan.map { RoutineChange.count(proposal.changes, against: $0.entries) }
      ?? coachWorkoutDiff(proposal).blocks.count
  }
  // The decision stands on the card as soon as it is made, the plan already rewritten; out of date, it can no longer be
  // applied, by the domain's own rule (readCoachProposals).
  func coachWorkoutProposalStance(_ proposal: WorkoutProposal) -> ProposalStance {
    switch proposal.state {
    case "applied": return .applied
    case "dismissed": return .rejected
    default: return outOfDateWorkoutProposals[proposal.id].map(ProposalStance.outOfDate) ?? .open
    }
  }
}
