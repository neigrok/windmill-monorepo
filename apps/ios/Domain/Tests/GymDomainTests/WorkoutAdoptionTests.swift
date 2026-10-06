import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

struct WorkoutAdoptionTests {
  @Test func finishedAnonymousWorkoutSupersedesTheWholeChainExactlyOnce() throws {
    let h = Harness(registry: SyncSchema.registry, start: Instant(ms: TrainingTests.now), account: nil)
    let session = h.runner.mint(Session.self), start = Instant(ms: TrainingTests.now - 10_000)
    _ = try h.runner.run(StartSession(id: session, startedAt: start))
    let exercise = SeedExercises.all.first!
    let set = TrainingSet(id: h.runner.mint(TrainingSet.self), sessionId: session, exerciseId: exercise.id,
      weightKg: 60, reps: 8, kind: "drop", rpe: 7.5, note: "Durable full set", completedAt: Instant(ms: start.ms + 1_000))
    _ = try h.runner.run(AppendSet(set))
    var corrected = set; corrected.weightKg = 62.5
    #expect(try h.runner.run(CorrectSet(corrected)).receipt != nil)
    _ = try h.runner.run(FinishSession(id: session, finishedAt: Instant(ms: start.ms + 2_000)))
    h.failNextCommit()
    #expect(throws: (any Error).self) { try h.runner.run(AdoptWorkout(session, mode: .prepare)) }
    #expect(try h.drawn(TrainingSet.self).first?.fields == corrected.fields)
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0).isEmpty })
    #expect(try h.runner.read(Gym.scope) { try $0.commands().filter { $0.command.name == Gym.Commands.start }.count } == 1)
    let result = try h.runner.run(AdoptWorkout(session, mode: .prepare))
    #expect(result.receipt != nil)
    let commands = try h.runner.read(Gym.scope) { try $0.commands() }
    #expect(commands.count == 1 && commands.first?.command.name == Gym.Commands.importSession)
    let importedSets = try #require(commands.first?.command.args["sets"]).asArray()
    #expect(importedSets.first?["weightKg"] == .of(62.5))
    #expect(try h.runner.run(AdoptWorkout(session, mode: .prepare)).receipt == nil)
    let snapshot = try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0) }
    #expect(snapshot.count == 1 && snapshot[0].sets[0].weightKg == 62.5)
    #expect(try SignedOutWorkout(snapshot[0].json) == snapshot[0])
    #expect(try h.drawn(TrainingSet.self).map(\.id) == [set.id])
  }

  @Test func openAnonymousWorkoutKeepsItsStartAndDurableRecoverySnapshot() throws {
    let h = Harness(registry: SyncSchema.registry, start: Instant(ms: TrainingTests.now), account: nil)
    let id = h.runner.mint(Session.self)
    _ = try h.runner.run(StartSession(id: id))
    let set = TrainingSet(id: h.runner.mint(TrainingSet.self), sessionId: id, exerciseId: SeedExercises.all.first!.id,
      weightKg: 20, reps: 5, completedAt: Instant(ms: TrainingTests.now))
    _ = try h.runner.run(AppendSet(set))
    _ = try h.runner.run(AdoptWorkout(id, mode: .prepare))
    let snapshot = try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0) }
    #expect(snapshot.count == 1 && snapshot[0].session.isOpen)
    #expect(snapshot[0].importAction.finishedAt == set.completedAt)
    #expect(snapshot[0].sets == [set])
    #expect(try h.drawn(TrainingSet.self).isEmpty)
    h.failNextCommit()
    #expect(throws: (any Error).self) { try h.runner.run(AppendSet(set)) }
    #expect(try h.runner.run(AdoptWorkout(id, mode: .prepare)).refusal == nil)
    #expect(try h.runner.read(Gym.scope) { try SignedOutWorkout.read($0) } == snapshot)
    _ = try h.runner.run(AppendSet(set))
    #expect(try h.drawn(TrainingSet.self) == [set])
    let start = try h.runner.read(Gym.scope) { try $0.commands().first }
    #expect(start?.command.args["joinOpenSession"] == false)
    #expect(try h.runner.run(AdoptWorkout(id, mode: .keep)).refusal != nil)
    #expect(try h.runner.read(Gym.scope) { try $0.commands().count } == 1)
  }

  @Test func aStaleAnonymousWorkoutImportsAtItsLastSet() throws {
    let h = Harness(registry: SyncSchema.registry, start: Instant(ms: TrainingTests.now), account: nil)
    let id = h.runner.mint(Session.self), start = Instant(ms: TrainingTests.now - SessionRules.staleAfterMs - 20_000)
    _ = try h.runner.run(StartSession(id: id, startedAt: start))
    let set = TrainingSet(id: h.runner.mint(TrainingSet.self), sessionId: id, exerciseId: SeedExercises.all.first!.id,
      weightKg: 20, reps: 5, completedAt: Instant(ms: start.ms + 1_000))
    _ = try h.runner.run(AppendSet(set))
    #expect(try h.runner.run(AdoptWorkout(id, mode: .prepare)).refusal == nil)
    let command = try h.runner.read(Gym.scope) { try $0.commands().first }
    #expect(command?.command.name == Gym.Commands.importSession)
    #expect(command?.command.args["finishedAt"] == .of(set.completedAt))
  }
}
