import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import SyncTesting
import Testing

struct TrainingTests {
  static let now: Int64 = 1_800_000_000_000
  static let sessionID = ID<Session>(RecordID("session1"))
  static let exerciseID = ID<Exercise>(RecordID("custom01"))

  static func phone() -> Harness {
    Harness(registry: SyncSchema.registry, start: Instant(ms: now), rules: GymServerRules())
  }

  static func exercise(_ h: Harness) throws {
    _ = try h.runner.run(CreateExercise(Exercise(id: exerciseID, name: "Squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))
    h.sync()
  }

  static func start(_ h: Harness, id: ID<Session> = sessionID) throws -> ID<Session> {
    try #require(committed(h.runner.run(StartSession(id: id))))
  }

  static func set(_ h: Harness, session: ID<Session> = sessionID, weight: Double = 80, reps: Int = 5,
                  kind: String = "working", rpe: Double? = nil, note: String = "") -> TrainingSet {
    TrainingSet(id: h.runner.mint(TrainingSet.self), sessionId: session, exerciseId: exerciseID,
                weightKg: weight, reps: reps, kind: kind, rpe: rpe, note: note, completedAt: Instant(ms: h.clock.nowMs()))
  }

  @Test func twoConcurrentStartsResolveToOneAuthoritativeSession() throws {
    let a = Self.phone(), b = a.device()
    let one = ID<Session>(RecordID("session1")), two = ID<Session>(RecordID("session2"))
    #expect(try Self.start(a, id: one) == one)
    #expect(try Self.start(b, id: two) == two)
    #expect(try a.drawn(Session.self).map(\.id) == [one])
    #expect(try b.drawn(Session.self).map(\.id) == [two])
    #expect(try a.stored(Session.self).map(\.id) == [one])
    #expect(try b.stored(Session.self).map(\.id) == [two])
    a.sync()
    #expect(try a.drawn(Session.self).map(\.id) == [one])
    #expect(try b.drawn(Session.self).map(\.id) == [one])
    #expect(try a.stored(Session.self).map(\.id) == [one])
    #expect(try b.stored(Session.self).map(\.id) == [one])
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
    #expect(try committed(b.runner.run(StartSession(id: ID(RecordID("session3"))))) == one)
  }

  @Test func joiningRewritesTheQueuedSetParentToTheAuthoritativeSessionID() throws {
    let a = Self.phone(), b = a.device(); try Self.exercise(a)
    let one = ID<Session>(RecordID("session1")), two = ID<Session>(RecordID("session2"))
    _ = try Self.start(a, id: one); _ = try Self.start(b, id: two)
    let pending = Self.set(b, session: two)
    _ = try b.runner.run(AppendSet(pending))
    #expect(try b.drawn(TrainingSet.self).first?.sessionId == two)
    a.sync()
    let admitted = try #require(try b.drawn(TrainingSet.self).first)
    #expect(admitted.id == pending.id && admitted.sessionId == one && admitted.setNumber == 1)
    #expect(try a.drawn(TrainingSet.self) == [admitted])
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
  }

  @Test func joinedStartReceiptReplaysAfterFinishAndClockRollback() throws {
    let a = Self.phone(), b = a.device()
    _ = try Self.start(a); a.sync()
    let joinedId = ID<Session>("session2")
    let action = StartSession(id: joinedId, startedAt: Instant(ms: Self.now))
    #expect(try committed(b.runner.run(action)) == Self.sessionID)
    a.sync()
    _ = try a.runner.run(FinishSession(id: Self.sessionID)); a.sync()
    let before = try a.drawn(Session.self)
    b.clock.jump(ms: -SessionRules.maxClockAheadMs - 1)
    #expect(try b.runner.run(action).receipt != nil)
    a.sync()
    #expect(try a.drawn(Session.self) == before && b.drawn(Session.self) == before)
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
  }

  @Test func aJoinedStartReceiptReplayedAfterDiscardDoesNotCreateANewSession() throws {
    let a = Self.phone(), b = a.device()
    let one = ID<Session>(RecordID("session1")), two = ID<Session>(RecordID("session2"))
    _ = try Self.start(a, id: one); _ = try Self.start(b, id: two); a.sync()
    _ = try a.runner.run(FinishSession(id: one)); a.sync()
    _ = try a.runner.run(DiscardSession(one)); a.advance(ms: Constants.holdMs); a.sync()
    #expect(try b.drawn(Session.self).isEmpty)
    #expect(try committed(b.runner.run(StartSession(id: two))) == two)
    #expect(try b.drawn(Session.self).map(\.id) == [two])
    a.sync()
    #expect(try a.drawn(Session.self).isEmpty && b.drawn(Session.self).isEmpty)
    #expect(try b.notices(GymRefusal.self).isEmpty)
  }

  @Test func aPendingStartAcceptsSetsAndSerialsAppearOnlyAfterAdmission() throws {
    let a = Self.phone(); try Self.exercise(a)
    _ = try Self.start(a)
    let first = Self.set(a), second = Self.set(a)
    #expect(try committed(a.runner.run(AppendSet(first))) == first.id)
    #expect(try committed(a.runner.run(AppendSet(second))) == second.id)
    #expect(try a.drawn(TrainingSet.self).allSatisfy { $0.setNumber == nil })
    a.sync()
    let admitted = try a.drawn(TrainingSet.self)
    #expect(Set(admitted.map(\.id)) == [first.id, second.id])
    #expect(Set(admitted.compactMap(\.setNumber)) == [1, 2])
    #expect(try a.notices(GymRefusal.self).isEmpty)
  }

  @Test func serialsAdvanceFromStandingMaximumAcrossPhonesAndMovementGroups() throws {
    let a = Self.phone(), b = a.device(); try Self.exercise(a)
    _ = try Self.start(a); a.sync()
    let one = Self.set(a), two = Self.set(b)
    _ = try a.runner.run(AppendSet(one)); _ = try b.runner.run(AppendSet(two)); a.sync()
    #expect(Set(try a.drawn(TrainingSet.self).compactMap(\.setNumber)) == [1, 2])
    let third = Self.set(a)
    _ = try a.runner.run(AppendSet(third)); a.sync()
    #expect(try a.drawn(TrainingSet.self).first { $0.id == third.id }?.setNumber == 3)
    #expect(try a.drawn(TrainingSet.self) == b.drawn(TrainingSet.self))
  }

  @Test func sessionPlanRemainsFrozenAfterRoutineEditAndDeletion() throws {
    let a = Self.phone(); try Self.exercise(a)
    let routineID = a.runner.mint(Routine.self)
    var draft = Draft(new: Routine(id: routineID, name: "Original", entries: [RoutineEntry(exerciseId: Self.exerciseID, sets: [SetTarget(reps: 5, weightKg: 100)], restSeconds: 120)]))
    #expect(saved(a.runner.save(&draft, SaveRoutine.self))); a.sync()
    _ = try a.runner.run(StartSession(id: Self.sessionID, routineId: routineID)); a.sync()
    let original = try #require(try a.drawn(Session.self).first)
    #expect(original.name == "Original" && original.historyRoutineId == routineID)
    draft.current.name = "Edited"; draft.current.entries = [RoutineEntry(exerciseId: Self.exerciseID)]
    #expect(saved(a.runner.save(&draft, SaveRoutine.self))); a.sync()
    #expect(try a.drawn(Session.self).first?.plan == original.plan)
    _ = try a.runner.run(DeleteRoutine(routineID)); a.advance(ms: Constants.holdMs); a.sync()
    let after = try #require(try a.drawn(Session.self).first)
    #expect(after.plan == original.plan && after.name == "Original" && after.routineId == nil && after.historyRoutineId == routineID)
  }

  @Test func staleDrawingDoesNotWriteAndStartCreatesAnotherSession() throws {
    let a = Self.phone(); _ = try Self.start(a); a.sync()
    a.advance(ms: SessionRules.staleAfterMs - 1)
    #expect(try a.runner.read(Session.scope) { try TrainingLog($0).liveHint })
    a.advance(ms: 1)
    let log = try a.runner.read(Session.scope) { try TrainingLog($0) }
    #expect(log.open == nil && !log.liveHint)
    #expect(log.drawnSessions.first?.finishedAt == Instant(ms: Self.now))
    #expect(log.drawnSessions.first?.closedBy == "stale")
    #expect(try a.stored(Session.self).first?.finishedAt == nil)
    let next = ID<Session>(RecordID("session2"))
    #expect(try Self.start(a, id: next) == next); a.sync()
    #expect(try a.drawn(Session.self).count == 2)
    #expect(try a.runner.read(Session.scope) { try TrainingLog($0).open?.id } == next)
  }

  @Test func lateSetAtTheStaleBoundaryLandsAndOneMillisecondLaterRefuses() throws {
    let a = Self.phone(); try Self.exercise(a); _ = try Self.start(a)
    let initial = Self.set(a); _ = try a.runner.run(AppendSet(initial)); a.sync()
    a.advance(ms: SessionRules.staleAfterMs)
    _ = try Self.start(a, id: ID(RecordID("session2"))); a.sync()
    let stale = try #require(try a.drawn(Session.self).first { $0.id == Self.sessionID })
    #expect(stale.closedBy == "stale" && stale.finishedAt == initial.completedAt)
    let atBoundary = Self.set(a)
    #expect(try committed(a.runner.run(AppendSet(atBoundary))) == atBoundary.id)
    a.sync()
    #expect(try a.drawn(Session.self).first { $0.id == Self.sessionID }?.finishedAt == atBoundary.completedAt)
    a.advance(ms: SessionRules.staleAfterMs + 1)
    #expect(try a.runner.run(AppendSet(Self.set(a))).refusal != nil)
  }

  @Test func explicitlyFinishedSessionRejectsAppendAndStillAllowsCorrectionAndDeletion() throws {
    let a = Self.phone(); try Self.exercise(a); _ = try Self.start(a)
    let value = Self.set(a, kind: "drop", rpe: 8, note: "old")
    _ = try a.runner.run(AppendSet(value)); a.sync()
    _ = try a.runner.run(FinishSession(id: Self.sessionID)); a.sync()
    let append = try a.runner.run(AppendSet(Self.set(a)))
    #expect(append.refusal != nil)
    var old = try #require(try a.drawn(TrainingSet.self).first)
    old.weightKg = 82.125; old.reps = 6; old.kind = "failure"; old.rpe = 9.25; old.note = "new"
    _ = try a.runner.run(CorrectSet(old)); a.sync()
    let corrected = try #require(try a.drawn(TrainingSet.self).first)
    #expect(corrected.weightKg == 82.13 && corrected.reps == 6 && corrected.kind == "failure" && corrected.rpe == 9.3 && corrected.note == "new")
    #expect(corrected.setNumber == 1 && corrected.completedAt == value.completedAt)
    let delete = try #require(try a.runner.run(DeleteSet(corrected.id)).receipt)
    #expect(delete.releaseAt == a.clock.nowMs() + Constants.holdMs)
    #expect(try a.drawn(TrainingSet.self).isEmpty)
    #expect(try a.runner.undo(delete.gestureId))
    #expect(try a.drawn(TrainingSet.self) == [corrected])
    _ = try a.runner.run(DeleteSet(corrected.id)); a.advance(ms: Constants.holdMs); a.sync()
    #expect(try a.stored(TrainingSet.self).isEmpty)
  }

  @Test func correctionOfferAcceptsAdmissionSerialAndRejectsConcurrentEditableChanges() throws {
    let a = Self.phone(); try Self.exercise(a); _ = try Self.start(a)
    let appended = Self.set(a)
    _ = try a.runner.run(AppendSet(appended))
    let original = try #require(try a.drawn(TrainingSet.self).first)
    #expect(original.setNumber == nil)
    a.sync()
    var offered = original; offered.weightKg = 62.5
    #expect(try a.runner.run(CorrectSet(offered, original: original)).receipt != nil)
    let corrected = try #require(try a.drawn(TrainingSet.self).first)
    #expect(corrected.weightKg == 62.5 && corrected.setNumber == 1 && corrected.completedAt == original.completedAt)
    var concurrent = corrected; concurrent.note = "Another correction"
    _ = try a.runner.run(CorrectSet(concurrent))
    var stale = corrected; stale.reps = 8
    #expect(try a.runner.run(CorrectSet(stale, original: corrected)).refusal == .stale(original.id.ref, .predicted))
    #expect(try a.drawn(TrainingSet.self).first == concurrent)
    let changedIdentity = TrainingSet(id: corrected.id, sessionId: ID("different-session"), exerciseId: corrected.exerciseId,
                                     weightKg: 62.5, reps: 5, completedAt: corrected.completedAt, setNumber: corrected.setNumber)
    #expect(try a.runner.run(CorrectSet(changedIdentity, original: corrected)).refusal != nil)
    #expect(try a.drawn(TrainingSet.self).first == concurrent)
  }

  @Test func discardIsHeldUndoRestoresItsSetsAndReleaseCascadesTheirDeath() throws {
    let a = Self.phone(), b = a.device(); try Self.exercise(a); _ = try Self.start(a)
    let value = Self.set(a); _ = try a.runner.run(AppendSet(value)); a.sync()
    #expect(try a.runner.run(DiscardSession(Self.sessionID)).refusal != nil)
    _ = try a.runner.run(FinishSession(id: Self.sessionID)); a.sync()
    let before = try a.drawn(Session.self), beforeSets = try a.drawn(TrainingSet.self)
    let removal = try #require(try a.runner.run(DiscardSession(Self.sessionID)).receipt)
    #expect(removal.releaseAt == a.clock.nowMs() + Constants.holdMs)
    #expect(try a.drawn(Session.self).isEmpty)
    #expect(try a.runner.undo(removal.gestureId))
    #expect(try a.drawn(Session.self) == before && a.drawn(TrainingSet.self) == beforeSets)
    let again = try #require(try a.runner.run(DiscardSession(Self.sessionID)).receipt)
    a.sync(); #expect(try b.drawn(Session.self) == before)
    a.advance(ms: Constants.holdMs); a.sync()
    #expect(try a.drawn(Session.self).isEmpty && b.drawn(Session.self).isEmpty)
    #expect(try a.drawn(TrainingSet.self).isEmpty && b.drawn(TrainingSet.self).isEmpty)
    #expect(try a.runner.undo(again.gestureId) == false)
  }

  @Test func importReceiptDistinguishesOmittedAndExplicitNullDespiteIdenticalPrediction() throws {
    let a = Self.phone(); try Self.exercise(a)
    let id = a.runner.mint(TrainingSet.self)
    let omitted = ImportedSet(id: id, exerciseId: Self.exerciseID, weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now - 500))
    let action = ImportSession(id: Self.sessionID, startedAt: Instant(ms: Self.now - 1000), finishedAt: Instant(ms: Self.now), sets: [omitted])
    _ = try a.runner.run(action); a.sync()
    #expect(try a.drawn(TrainingSet.self).first?.setNumber == 1)
    _ = try a.runner.run(action); a.sync()
    #expect(try a.notices(GymRefusal.self).isEmpty)
    let explicit = ImportedSet(id: id, exerciseId: Self.exerciseID, weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now - 500), rpeNamed: true)
    _ = try a.runner.run(ImportSession(id: Self.sessionID, startedAt: Instant(ms: Self.now - 1000), finishedAt: Instant(ms: Self.now), sets: [explicit])); a.sync()
    let notices = try a.notices(GymRefusal.self)
    #expect(notices.count == 1)
    #expect(notices.first?.refusal == GymRefusal(Refused(Gym.Codes.payloadConflict, subject: Self.sessionID.ref, path: .notice)))
    #expect(try a.drawn(Session.self).count == 1 && a.drawn(TrainingSet.self).count == 1)
  }

  @Test func importReceiptReplaysAfterSetDeletionAndClockRollback() throws {
    let a = Self.phone(); try Self.exercise(a)
    let set = ImportedSet(id: ID("set00001"), exerciseId: Self.exerciseID, weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now - 500))
    let action = ImportSession(id: Self.sessionID, startedAt: Instant(ms: Self.now - 1000), finishedAt: Instant(ms: Self.now), sets: [set])
    #expect(try a.runner.run(action).receipt != nil); a.sync()
    let before = try a.drawn(Session.self)
    _ = try a.runner.run(DeleteSet(set.id)); a.advance(ms: Constants.holdMs); a.sync()
    #expect(try a.drawn(TrainingSet.self).isEmpty)
    a.clock.jump(ms: -Constants.holdMs - 1000)
    #expect(try a.runner.run(action).receipt != nil); a.sync()
    #expect(try a.drawn(Session.self) == before && a.drawn(TrainingSet.self).isEmpty)
    #expect(try a.notices(GymRefusal.self).isEmpty)
  }

  @Test func correctionReceiptReplaysAfterSetDeletionAndClockRollback() throws {
    let a = Self.phone(); try Self.exercise(a)
    let set = ImportedSet(id: ID("set00001"), exerciseId: Self.exerciseID, weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now - 500))
    let start = Instant(ms: Self.now - 1000), finish = Instant(ms: Self.now)
    _ = try a.runner.run(ImportSession(id: Self.sessionID, startedAt: start, finishedAt: finish, sets: [set])); a.sync()
    let corrected = CorrectedSet(id: set.id, exerciseId: set.exerciseId, setNumber: 1, weightKg: 90, reps: 6, completedAt: set.completedAt)
    let action = CorrectSession(id: Self.sessionID, requestId: "request1", startedAt: start, finishedAt: finish, routineName: "Corrected", sets: [corrected])
    #expect(try a.runner.run(action).receipt != nil); a.sync()
    let before = try a.drawn(Session.self)
    _ = try a.runner.run(DeleteSet(set.id)); a.advance(ms: Constants.holdMs); a.sync()
    #expect(try a.drawn(TrainingSet.self).isEmpty)
    a.clock.jump(ms: -Constants.holdMs - 1000)
    #expect(try a.runner.run(action).receipt != nil); a.sync()
    #expect(try a.drawn(Session.self) == before && a.drawn(TrainingSet.self).isEmpty)
    #expect(try a.notices(GymRefusal.self).isEmpty)
  }

  @Test func completedSessionCorrectionPreservesOmittedDetailsReplacesSerialAndDropsMissingSets() throws {
    let a = Self.phone(); try Self.exercise(a); _ = try Self.start(a)
    let one = Self.set(a, kind: "drop", rpe: 8, note: "kept"), two = Self.set(a)
    _ = try a.runner.run(AppendSet(one)); _ = try a.runner.run(AppendSet(two)); a.sync()
    _ = try a.runner.run(FinishSession(id: Self.sessionID)); a.sync()
    let kept = CorrectedSet(id: one.id, exerciseId: Self.exerciseID, setNumber: 7, weightKg: 82, reps: 6, completedAt: one.completedAt)
    _ = try a.runner.run(CorrectSession(id: Self.sessionID, requestId: "request1", startedAt: Instant(ms: Self.now), finishedAt: Instant(ms: Self.now), routineName: "Corrected", sets: [kept])); a.sync()
    let set = try #require(try a.drawn(TrainingSet.self).first)
    #expect(try a.drawn(TrainingSet.self).count == 1)
    #expect(set.id == one.id && set.setNumber == 7 && set.kind == "drop" && set.rpe == 8 && set.note == "kept")
    #expect(set.weightKg == 82 && set.reps == 6)
    #expect(try a.drawn(Session.self).first?.name == "Corrected")
    let cleared = CorrectedSet(id: one.id, exerciseId: Self.exerciseID, setNumber: 7, weightKg: 82, reps: 6, completedAt: one.completedAt, rpe: nil, note: "", rpeNamed: true)
    _ = try a.runner.run(CorrectSession(id: Self.sessionID, requestId: "request2", startedAt: Instant(ms: Self.now), finishedAt: Instant(ms: Self.now), routineName: nil, sets: [cleared])); a.sync()
    #expect(try a.drawn(TrainingSet.self).first?.rpe == nil && a.drawn(TrainingSet.self).first?.note == "")
  }

  @Test(arguments: [false, true])
  func correctionRemovalPredictionPreservesBornAndAcceptsOrRollsBack(refused: Bool) throws {
    let a = Self.phone(); try Self.exercise(a)
    let start = Instant(ms: Self.now - 60_000), finish = Instant(ms: Self.now)
    let one = ImportedSet(id: ID("set00001"), exerciseId: Self.exerciseID, weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now - 1000))
    let two = ImportedSet(id: ID("set00002"), exerciseId: Self.exerciseID, weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now - 500))
    #expect(try a.runner.run(ImportSession(id: Self.sessionID, startedAt: start, finishedAt: finish, sets: [one, two])).receipt != nil)
    a.sync()
    let before = try #require(try a.runner.read(Session.scope) { try $0.repository(TrainingSet.self).record(two.id, in: .drawn) })
    let kept = CorrectedSet(id: one.id, exerciseId: Self.exerciseID, setNumber: 1, weightKg: 80, reps: 5, completedAt: one.completedAt)
    #expect(try a.runner.run(CorrectSession(id: Self.sessionID, requestId: "request1", startedAt: start, finishedAt: finish, routineName: nil, sets: [kept])).receipt != nil)
    let pending = try #require(try a.runner.read(Session.scope) { try $0.repository(TrainingSet.self).record(two.id, in: .drawn) })
    #expect(!pending.isVisible && pending.life?.isAlive == false)
    #expect(try #require(pending.life).stamp > #require(before.life).stamp)
    #expect(pending.born == before.born)
    #expect(try a.drawn(TrainingSet.self).map(\.id) == [one.id])
    if refused { a.server.refuse(code: .invalid) }
    a.sync()
    if refused {
      #expect(try a.runner.read(Session.scope) { try $0.repository(TrainingSet.self).record(two.id, in: .drawn) } == before)
      #expect(Set(try a.drawn(TrainingSet.self).map(\.id)) == [one.id, two.id])
      #expect(try a.notices(GymRefusal.self).map(\.refusal) == [GymRefusal(Refused(.invalid, subject: Self.sessionID.ref, path: .notice))])
    } else {
      #expect(try a.runner.read(Session.scope) { try $0.repository(TrainingSet.self).record(two.id, in: .drawn) } == nil)
      #expect(try a.drawn(TrainingSet.self).map(\.id) == [one.id])
      #expect(try a.notices(GymRefusal.self).isEmpty)
    }
  }

  @Test func correctingAHeldDeletedSetRefusesAndUndoKeepsTheUnchangedSet() throws {
    let a = Self.phone(); try Self.exercise(a); _ = try Self.start(a)
    let value = Self.set(a); _ = try a.runner.run(AppendSet(value)); a.sync()
    var editing = try #require(try a.drawn(TrainingSet.self).first)
    let removal = try #require(try a.runner.run(DeleteSet(editing.id)).receipt)
    editing.weightKg = 90
    #expect(try a.runner.run(CorrectSet(editing)).refusal == .gone(editing.id.ref, .predicted))
    #expect(try a.runner.undo(removal.gestureId))
    #expect(try a.drawn(TrainingSet.self).first?.weightKg == 80)
  }

  @Test func finishingAHeldDiscardedStaleSessionRefusesAndUndoKeepsTheSession() throws {
    let a = Self.phone(); _ = try Self.start(a); a.sync()
    a.advance(ms: SessionRules.staleAfterMs)
    let removal = try #require(try a.runner.run(DiscardSession(Self.sessionID)).receipt)
    #expect(try a.runner.run(FinishSession(id: Self.sessionID)).refusal == .gone(Self.sessionID.ref, .predicted))
    #expect(try a.runner.undo(removal.gestureId))
    #expect(try a.stored(Session.self).first?.finishedAt == nil)
  }

  @Test func correctingSessionWithAHeldDeletedSetRetainsUndoAndDefersToServer() throws {
    let a = Self.phone(); try Self.exercise(a); _ = try Self.start(a)
    let value = Self.set(a); _ = try a.runner.run(AppendSet(value)); a.sync()
    _ = try a.runner.run(FinishSession(id: Self.sessionID)); a.sync()
    let prior = try #require(try a.drawn(TrainingSet.self).first)
    let removal = try #require(try a.runner.run(DeleteSet(prior.id)).receipt)
    let kept = CorrectedSet(id: prior.id, exerciseId: prior.exerciseId, setNumber: try #require(prior.setNumber), weightKg: 90, reps: 5, completedAt: prior.completedAt)
    let result = try a.runner.run(CorrectSession(id: Self.sessionID, requestId: "request1", startedAt: Instant(ms: Self.now), finishedAt: Instant(ms: Self.now), routineName: nil, sets: [kept]))
    #expect(result.receipt != nil)
    #expect(try a.drawn(TrainingSet.self).isEmpty)
    #expect(try a.runner.undo(removal.gestureId))
    a.sync()
    var corrected = prior; corrected.weightKg = 90
    #expect(try a.drawn(TrainingSet.self) == [corrected])
    #expect(try a.notices(GymRefusal.self).isEmpty)
  }

  @Test func failedImportCommitLeavesNoSessionOrSetsAndTheRetryStoresAll() throws {
    let a = Self.phone(); try Self.exercise(a)
    let one = a.runner.mint(TrainingSet.self), two = a.runner.mint(TrainingSet.self)
    let sets = [one, two].map { ImportedSet(id: $0, exerciseId: Self.exerciseID, weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now)) }
    let action = ImportSession(id: Self.sessionID, startedAt: Instant(ms: Self.now), finishedAt: Instant(ms: Self.now), sets: sets)
    a.failNextCommit()
    #expect(throws: (any Error).self) { try a.runner.run(action) }
    #expect(try a.drawn(Session.self).isEmpty && a.drawn(TrainingSet.self).isEmpty)
    #expect(try committed(a.runner.run(action)) == Self.sessionID); a.sync()
    #expect(try a.drawn(Session.self).map(\.id) == [Self.sessionID])
    #expect(Set(try a.drawn(TrainingSet.self).map(\.id)) == [one, two])
    #expect(Set(try a.drawn(TrainingSet.self).compactMap(\.setNumber)) == [1, 2])
  }

  @Test func failedCommandCommitLeavesNoPredictionAndCanRetryTheSameIdentity() throws {
    let a = Self.phone(); a.failNextCommit()
    #expect(throws: (any Error).self) { try a.runner.run(StartSession(id: Self.sessionID)) }
    #expect(try a.drawn(Session.self).isEmpty && a.stored(Session.self).isEmpty)
    #expect(try Self.start(a) == Self.sessionID); a.sync()
    #expect(try a.drawn(Session.self).map(\.id) == [Self.sessionID])
  }

  @Test func failedSetCommitKeepsPriorSessionAndNoHalfWrittenSet() throws {
    let a = Self.phone(); try Self.exercise(a); _ = try Self.start(a); a.sync()
    let value = Self.set(a); a.failNextCommit()
    #expect(throws: (any Error).self) { try a.runner.run(AppendSet(value)) }
    #expect(try a.drawn(TrainingSet.self).isEmpty)
    #expect(try a.drawn(Session.self).map(\.id) == [Self.sessionID])
    _ = try a.runner.run(AppendSet(value)); a.sync()
    #expect(try a.drawn(TrainingSet.self).map(\.id) == [value.id])
  }

  @Test func aRefusedStartRetractsItsPendingPredictionAndRetainsItsNotice() throws {
    let a = Self.phone(); a.server.refuse(code: .invalid)
    _ = try Self.start(a)
    #expect(try a.drawn(Session.self).count == 1)
    a.sync()
    #expect(try a.drawn(Session.self).isEmpty && a.stored(Session.self).isEmpty)
    #expect(try a.notices(GymRefusal.self).count == 1)
  }

  @Test func entitiesAgreeWithRegistryAndSerialNeverEntersClientWrites() throws {
    let sample = TrainingSet(id: ID(RecordID("set00001")), sessionId: Self.sessionID, exerciseId: Self.exerciseID,
                             weightKg: 80, reps: 5, completedAt: Instant(ms: Self.now), setNumber: 9)
    try RegistryCheck.entity(TrainingSet.self, sample: sample, book: GymRules.book, registry: SyncSchema.registry)
    #expect(sample.fields["setNumber"] == nil)
    try RegistryCheck.entity(Session.self, registry: SyncSchema.registry)
    try RegistryCheck.command(StartSessionCommand.self, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.command(FinishSessionCommand.self, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.command(ImportSessionCommand.self, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.command(CorrectSessionCommand.self, book: GymRules.book, registry: SyncSchema.registry)
  }

  @Test(arguments: try Contract.vectors("gym/domain/training-actions.json"))
  func action(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book), input = try vector.input.member("input")
    if let read = vector.input["read"] {
      let result = try corpus.read(vector, in: Session.scope) { reader in
        switch try read.asString() {
        case "TrainingLog":
          let log = try TrainingLog(reader), id = ID<Session>(try RecordID(json: input.member("sessionId")))
          return ["sessions": .array(log.drawnSessions.map { ["id": $0.id.json, "fields": .object(fields: $0.fields)] }),
                  "sets": .array(log.sets(session: id).map { value in
                    var fields = value.fields
                    if let number = value.setNumber { fields["setNumber"] = JSON(number) }
                    return ["id": value.id.json, "fields": .object(fields: fields)]
                  }), "open": log.open?.id.json ?? .null, "liveHint": .bool(log.liveHint),
                  "volumeKg": .of(log.volumeKg(session: id)), "topE1rm": .of(log.topE1rm(session: id))]
        case "SessionRules":
          switch try input.member("operation").asString() {
          case "drawn":
            let session = try Session(form: input.member("session"))
            let drawn = SessionRules.drawn(session, sets: try reader.repository(TrainingSet.self).all(in: .drawn), now: reader.moment.now)
            return ["id": drawn.id.json, "fields": .object(fields: drawn.fields)]
          case "crosses": return .bool(SessionRules.crosses(Instant(ms: try input.member("startedAt").asInteger()), Instant(ms: try input.member("finishedAt").asInteger()), other: try Session(form: input.member("session"))))
          case "canStartAt": return .bool(SessionRules.canStartAt(Instant(ms: try input.member("startedAt").asInteger()), now: reader.moment.now))
          case "canFinishAt": return .bool(SessionRules.canFinishAt(try Session(form: input.member("session")), at: Instant(ms: try input.member("finishedAt").asInteger())))
          case let operation: throw ContractError("unclaimed session rule \(operation)")
          }
        case "SetRules": return .of(SetRules.nextNumber(try reader.repository(TrainingSet.self).all(in: .stored), sessionId: ID(try RecordID(json: input.member("sessionId"))), exerciseId: ID(try RecordID(json: input.member("exerciseId")))))
        case let name: throw ContractError("unclaimed training read \(name)")
        }
      }
      #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
      return
    }
    let result: JSON
    switch try vector.input.member("action").asString() {
    case "StartSession":
      result = try corpus.decision(of: StartSession(id: ID(try RecordID(json: input.member("id"))), routineId: try input["routineId"].map { ID(try RecordID(json: $0)) }, startedAt: try input["startedAt"].map { Instant(ms: try $0.asInteger()) }), vector, result: \.json, refusal: \.form)
    case "FinishSession":
      result = try corpus.decision(of: FinishSession(id: ID(try RecordID(json: input.member("id"))), finishedAt: try input["finishedAt"].map { Instant(ms: try $0.asInteger()) }), vector, result: { _ in .null }, refusal: \.form)
    case "AppendSet": result = try corpus.decision(of: AppendSet(Self.trainingSet(try input.member("set"))), vector, result: \.json, refusal: \.form)
    case "CorrectSet": result = try corpus.decision(of: CorrectSet(Self.trainingSet(try input.member("set"))), vector, result: { _ in .null }, refusal: \.form)
    case "DiscardSession": result = try corpus.decision(of: DiscardSession(ID(try RecordID(json: input.member("id")))), vector, result: { _ in .null }, refusal: \.form)
    case "DeleteSet": result = try corpus.decision(of: DeleteSet(ID(try RecordID(json: input.member("id")))), vector, result: { _ in .null }, refusal: \.form)
    case "ImportSession":
      let sets = try input.member("sets").asArray().map { json in
        ImportedSet(id: ID(try RecordID(json: json.member("id"))), exerciseId: ID(try RecordID(json: json.member("exerciseId"))), weightKg: try json.member("weightKg").asDouble(), reps: Int(try json.member("reps").asInteger()), completedAt: Instant(ms: try json.member("completedAt").asInteger()), kind: try json["kind"]?.asString(), rpe: try json["rpe"].flatMap { $0.isNull ? nil : try $0.asDouble() }, note: try json["note"]?.asString(), rpeNamed: json["rpe"] != nil)
      }
      result = try corpus.decision(of: ImportSession(id: ID(try RecordID(json: input.member("id"))), startedAt: Instant(ms: try input.member("startedAt").asInteger()), finishedAt: Instant(ms: try input.member("finishedAt").asInteger()), sets: sets, routineId: try input["routineId"].map { ID(try RecordID(json: $0)) }), vector, result: \.json, refusal: \.form)
    case "CorrectSession":
      let sets = try input.member("sets").asArray().map { json in
        CorrectedSet(id: ID(try RecordID(json: json.member("id"))), exerciseId: ID(try RecordID(json: json.member("exerciseId"))), setNumber: Int(try json.member("setNumber").asInteger()), weightKg: try json.member("weightKg").asDouble(), reps: Int(try json.member("reps").asInteger()), completedAt: Instant(ms: try json.member("completedAt").asInteger()), rpe: try json["rpe"].flatMap { $0.isNull ? nil : try $0.asDouble() }, note: try json["note"]?.asString(), rpeNamed: json["rpe"] != nil)
      }
      result = try corpus.decision(of: CorrectSession(id: ID(try RecordID(json: input.member("sessionId"))), requestId: input.member("requestId").asString(), startedAt: Instant(ms: try input.member("startedAt").asInteger()), finishedAt: Instant(ms: try input.member("finishedAt").asInteger()), routineName: input.member("routineName").isNull ? nil : input.member("routineName").asString(), sets: sets), vector, result: { _ in .null }, refusal: \.form)
    case let action: throw ContractError("unclaimed training action \(action)")
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  static func trainingSet(_ input: JSON) throws -> TrainingSet {
    let f = try input.member("fields")
    return TrainingSet(id: ID(try RecordID(json: input.member("id"))), sessionId: ID(try RecordID(json: f.member("sessionId"))), exerciseId: ID(try RecordID(json: f.member("exerciseId"))), weightKg: try f.member("weightKg").asDouble(), reps: Int(try f.member("reps").asInteger()), kind: try f["kind"]?.asString() ?? "working", rpe: try f["rpe"].flatMap { $0.isNull ? nil : try $0.asDouble() }, note: try f["note"]?.asString() ?? "", completedAt: Instant(ms: try f.member("completedAt").asInteger()), setNumber: try f["setNumber"].map { Int(try $0.asInteger()) })
  }
}
