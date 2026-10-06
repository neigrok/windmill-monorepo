import Testing
import DomainKit
import GymDomain
import SyncEngine
import SyncTesting
import SyncSchema
@testable import Windmill

@Suite @MainActor struct WorkoutAdoptionTests {
  @Test func recoveryPrioritizesUnlandedWorkoutBeforeFinishedImportAwaitingConfirmation() throws {
    let fixture = WorkoutStateTests(), (harness, gym) = try fixture.fixture()
    let start = Instant(ms: 1_790_424_000_000)
    let finishedID = ID<Session>("a-finished")
    let set = ImportedSet(id: ID("a-set-0001"), exerciseId: fixture.first, weightKg: 60, reps: 8, completedAt: start)
    #expect(try harness.runner.run(ImportSession(id: finishedID, startedAt: start, finishedAt: start, sets: [set])).receipt != nil)
    gym.refresh()
    let finished = try #require(gym.sessions.first { $0.id == finishedID })
    let open = Session(id: ID("z-open-session"), startedAt: start)
    let backups = [SignedOutWorkout(session: finished, sets: []), SignedOutWorkout(session: open, sets: [])]
    gym.adoptionWorkouts = backups
    #expect(gym.adoptionWorkoutToReview?.session.id == open.id)
    #expect(try harness.runner.run(StartSession(id: open.id, startedAt: start)).receipt != nil)
    gym.refresh(); gym.adoptionWorkouts = backups
    #expect(gym.adoptionWorkoutToReview?.session.id == finished.id)
    gym.adoptionWorkouts = []
    #expect(gym.adoptionWorkoutToReview == nil)
  }

  @Test func liveActivityOffersCannotCrossConflictingAdoptionOrKeepImports() async throws {
    let server = JournalModelTransport(), remote = try LineageFlowTests().fixture(server)
    let identity = server.identity(email: "activity-conflict-adoption@example.com")
    try await remote.signIn(identity)
    let accountWorkout = try #require(remote.gym.startWorkout())
    await remote.runtime?.engine.start()
    try await AppModelTests().workoutSettled(remote, accountWorkout)

    let connectivity = SwitchedConnectivity()
    let local = try LineageFlowTests().fixture(server, seed: 22, connectivity: connectivity)
    let finished = try #require(local.gym.startWorkout())
    local.gym.workout.add(ID("bench-press"))
    let finishedOffer = try #require(local.gym.workout.activityOffer())
    #expect(local.gym.workout.logActivityOffer(finishedOffer))
    await local.gym.workout.finish()
    #expect(local.gym.sessions.first { $0.id == finished }?.isOpen == false)
    let open = try #require(local.gym.startWorkout())
    local.gym.workout.add(ID("bench-press"))
    let openOffer = try #require(local.gym.workout.activityOffer())
    #expect(local.gym.workout.logActivityOffer(openOffer))
    let expected = local.gym.sets
    #expect(Set(expected.map { $0.id.description }) == [finishedOffer.setID, openOffer.setID])
    try await local.signIn(server.identity(email: identity.email))
    #expect(local.currentAdoption?.product == "gym")
    #expect(try local.runner.read(Gym.scope) { try $0.commands().filter {
      $0.command.name == Gym.Commands.importSession && $0.command.args["id"] == finished.json
    }.count } == 1)
    #expect(local.gym.workout.activityOffer() == nil && !local.gym.workout.logActivityOffer(openOffer))
    await local.adopt(.add)
    await local.runtime?.engine.start()
    try await AppModelTests().workoutSettled(local, finished)
    #expect(await WorkoutStateTests.until {
      local.refresh()
      return (try? local.runner.read(Gym.scope) { read in
        for set in expected where set.sessionId == finished {
          guard let row = try read.confirmed(TrainingSet.self, set.id), row.isVisible else { return false }
          let imported = try TrainingSet(Fields(row))
          guard imported.id == set.id, imported.fields == set.fields else { return false }
        }
        return local.gym.adoptionWorkouts.map { $0.session.id } == [open]
      }) == true
    })
    #expect(local.account == identity.account && local.gym.openSession?.id == accountWorkout)
    #expect(local.gym.adoptionWorkouts.map { $0.session.id } == [open])
    #expect(!local.gym.workout.logActivityOffer(finishedOffer) && !local.gym.workout.logActivityOffer(openOffer))
    #expect(local.gym.workout.activityOffer() == nil)
    #expect(Set(local.gym.sets.filter { $0.sessionId == finished }.map { $0.id.description }) == [finishedOffer.setID])
    connectivity.set(online: false)
    for _ in 0..<100 where local.runtime!.engine.status.online { try await Task.sleep(for: .milliseconds(5)) }
    #expect(!local.runtime!.engine.status.online)
    local.gym.keepAdoptedWorkout(open)
    local.gym.keepAdoptedWorkout(open)
    #expect(try local.runner.read(Gym.scope) { try $0.commands().filter { $0.command.name == Gym.Commands.importSession && $0.command.args["id"] == open.json }.count } == 1)
    #expect(!local.gym.workout.logActivityOffer(openOffer) && local.gym.openSession?.id == accountWorkout)
    connectivity.set(online: true)
    local.runtime!.engine.foreground()
    try await AppModelTests().workoutSettled(local, open)
    #expect(await WorkoutStateTests.until { local.refresh(); return local.gym.adoptionWorkouts.isEmpty })
    #expect(local.gym.adoptionWorkouts.isEmpty && local.gym.openSession?.id == accountWorkout)
    #expect(Set(local.gym.sets.map { $0.id.description }) == [finishedOffer.setID, openOffer.setID])
    #expect(local.gym.sets.allSatisfy { $0.sessionId != accountWorkout })
    #expect(local.gym.sessions.first { $0.id == open }?.finishedAt == expected.first { $0.sessionId == open }?.completedAt)
    #expect(local.gym.restoreWorkout())
    local.gym.workout.add(ID("bench-press"))
    let resumed = try #require(local.gym.workout.activityOffer())
    #expect(resumed.sessionID == accountWorkout.description && resumed.ownerID != finishedOffer.ownerID && resumed.ownerID != openOffer.ownerID)
    #expect(resumed.setID != finishedOffer.setID && resumed.setID != openOffer.setID)
    #expect(!local.gym.workout.logActivityOffer(finishedOffer) && !local.gym.workout.logActivityOffer(openOffer))
    #expect(local.gym.workout.activityOffer() == resumed)
    #expect(Set(local.gym.sets.map { $0.id.description }) == [finishedOffer.setID, openOffer.setID])
    remote.gym.stop(); local.gym.stop()
  }
}
