import Foundation
import Testing
import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct SetEditorTests {
  @Test func keypadReplacesSeedAndSupportsBackspaceCommaAndSign() {
    var pad = SetKeypad(.weight, value: 82.5)
    #expect(pad.text == "82.5" && pad.keeping == 82.5 && pad.seeded)
    pad.press("1"); pad.press("2"); pad.press(","); pad.press("5")
    #expect(pad.text == "12,5" && pad.reading.value == 12.5 && !pad.seeded)
    pad.press("±")
    #expect(pad.text == "-12,5" && pad.reading.value == -12.5)
    pad.press("⌫")
    #expect(pad.text == "-12," && pad.reading.value == -12)
    pad.press("±")
    #expect(pad.text == "12," && pad.reading.value == 12)
    var seeded = SetKeypad(.weight, value: -50)
    seeded.press("±"); seeded.press("2")
    #expect(seeded.text == "502" && seeded.reading.value == nil)
  }

  @Test(arguments: ["", "-", "1.2.3", "1,2.3", "no", "nan", "inf", "501", "-500.01"])
  func keypadRejectsInvalidWeights(text: String) {
    var pad = SetKeypad(.weight, value: 20); pad.text = text
    #expect(pad.reading.value == nil)
    #expect(!pad.reading.message.isEmpty)
  }

  @Test(arguments: [-500.0, 0, 500, -82.125, 82.125])
  func keypadAcceptsWeightBoundsAndRounds(value: Double) {
    var pad = SetKeypad(.weight, value: 20); pad.text = String(value)
    #expect(pad.reading.value == WeightLadder.round(value))
    #expect(pad.reading.message == "kg")
  }

  @Test func keypadBoundsTextAndRepsKeys() {
    var weight = SetKeypad(.weight, value: 20)
    for _ in 0..<10 { weight.press("1") }
    #expect(weight.text == "11111111")
    weight.press("±"); #expect(weight.text == "11111111")
    weight.press("⌫"); weight.press("±"); weight.press("2")
    #expect(weight.text == "-1111111" && weight.text.count == 8)
    var reps = SetKeypad(.reps, value: 5)
    for key in ["±", ".", ","] { reps.press(key) }
    #expect(reps.text == "5" && reps.seeded)
    reps.press("9"); reps.press("9")
    #expect(reps.text == "99" && reps.reading.value == 99)
    reps.press("⌫"); reps.press("⌫")
    #expect(reps.reading.value == nil)
  }

  @Test(arguments: ["0", "100", "-1", "1.5", "no", ""])
  func keypadRejectsInvalidReps(text: String) {
    var pad = SetKeypad(.reps, value: 5); pad.text = text
    #expect(pad.reading.value == nil)
  }

  @Test(arguments: [1, 99]) func keypadAcceptsRepBounds(reps: Int) {
    var pad = SetKeypad(.reps, value: 5); pad.text = String(reps)
    #expect(pad.reading.value == Double(reps) && pad.reading.message == "whole reps")
  }

  @Test func draftAcceptsSignedLoadsClearEffortAndNotesAndRefusesEachBoundInOrder() throws {
    let workouts = WorkoutStateTests(), (_, gym) = try workouts.fixture()
    let draft = SetFixDraft(workouts.value(gym, session: workouts.finished(gym)), account: nil)
    draft.weightKg = -20.5; draft.reps = 99; draft.rpe = nil; draft.note = ""
    #expect(draft.problem == nil)
    #expect([draft.value.weightKg, Double(draft.value.reps)] == [-20.5, 99] && draft.value.rpe == nil && draft.value.note == "")
    draft.weightKg = .nan; #expect(draft.problem == "That is not a number yet.")
    draft.weightKg = 500.01; #expect(draft.problem == "Between −500 and 500 kg — check the number.")
    draft.weightKg = -500; draft.reps = 100; #expect(draft.problem == "Whole reps, 1–99.")
    draft.reps = 0; #expect(draft.problem == "Whole reps, 1–99.")
    draft.reps = 1; draft.note = String(repeating: "é", count: 2_001)
    #expect(draft.problem == "A set note runs to 4000 bytes.")
    draft.note = String(repeating: "é", count: 2_000); #expect(draft.problem == nil)
  }

  @Test func noteCounterAppearsFromThirtyTwoHundredUTF8Bytes() throws {
    let workouts = WorkoutStateTests(), (_, gym) = try workouts.fixture()
    let draft = SetFixDraft(workouts.value(gym, session: workouts.finished(gym)), account: nil)
    draft.note = String(repeating: "é", count: 1_599)
    #expect(draft.noteBytes == 3_198 && draft.noteCounter == nil && draft.problem == nil)
    draft.note += "a"
    #expect(draft.noteBytes == 3_199 && draft.noteCounter == nil)
    draft.note += "a"
    #expect(draft.noteBytes == 3_200 && draft.noteCounter == "3200 of 4000 bytes" && draft.problem == nil)
    draft.note = String(repeating: "😀", count: 1_000)
    #expect(draft.noteBytes == 4_000 && draft.noteCounter == "4000 of 4000 bytes" && draft.problem == nil)
    draft.note += "a"
    #expect(draft.noteBytes == 4_001 && draft.noteCounter == "4001 of 4000 bytes" && !draft.save(gym))
  }

  @Test(arguments: [Optional<Double>.none] + (0...8).map { Optional(6 + Double($0) / 2) })
  func fixCanSetAndClearEveryEffortChoice(rpe: Double?) throws {
    let workouts = WorkoutStateTests(), (_, gym) = try workouts.fixture(), workout = try workouts.begin(gym)
    workout.logSet()
    let old = try #require(workout.sets.first), draft = SetFixDraft(old, account: gym.account)
    draft.rpe = rpe; draft.note = "Private effort note"
    #expect(draft.save(gym))
    let changed = try #require(workout.sets.first)
    #expect(changed.rpe == rpe && changed.note == "Private effort note")
    #expect(changed.id == old.id && changed.completedAt == old.completedAt && changed.setNumber == old.setNumber)
    draft.rpe = nil; draft.note = ""; #expect(draft.save(gym))
    #expect(workout.sets.first?.rpe == nil && workout.sets.first?.note == "")
  }

  @Test func kindCorrectionKeepsTheSetIdentity() throws {
    let workouts = WorkoutStateTests(), (_, gym) = try workouts.fixture(), workout = try workouts.begin(gym)
    workout.logSet()
    let old = try #require(workout.sets.first), draft = SetFixDraft(old, account: gym.account)
    #expect(old.kind == "working")
    draft.kind = SetKind.warmup.rawValue
    #expect(draft.save(gym))
    var expected = old; expected.kind = "warmup"
    #expect(workout.sets == [expected] && draft.original == expected)
  }

  @Test func failedFixRetainsDraftAndOriginalWhileRetryLeavesTargetsAlone() throws {
    let workouts = WorkoutStateTests(), (harness, gym) = try workouts.fixture()
    let plan = try workouts.routine(gym, scheme: [SetTarget(reps: 5, weightKg: 40)]), workout = try workouts.begin(gym, routine: plan)
    workout.logSet()
    let original = try #require(workout.sets.first), draft = SetFixDraft(original, account: gym.account)
    draft.weightKg = 42.5; draft.reps = 6; draft.rpe = 8.5; draft.note = "Private correction"
    harness.failNextCommit()
    #expect(!draft.save(gym) && !draft.busy && draft.failure == "The log didn’t answer — that set wasn’t changed.")
    #expect(workout.sets == [original] && draft.value.weightKg == 42.5 && draft.value.note == "Private correction")
    #expect(draft.save(gym) && draft.failure == nil && workout.sets == [draft.value])
    #expect(gym.routines.first?.entries == plan.entries && workout.session?.plan == SessionPlan(plan))
  }

  @Test func fixAcceptsAdmissionSerialButRetainsDraftWhenAnotherCorrectionArrives() throws {
    let workouts = WorkoutStateTests(), (harness, gym) = try workouts.fixture(anonymous: false), workout = try workouts.begin(gym)
    workout.logSet()
    let original = try #require(workout.sets.first), draft = SetFixDraft(original, account: gym.account)
    #expect(original.setNumber == nil)
    draft.weightKg = 62.5
    harness.sync(); gym.refresh(); workout.reconcile()
    #expect(workout.sets.first?.setNumber == 1 && draft.save(gym))
    #expect(draft.original.weightKg == 62.5 && draft.original.setNumber == 1)
    var other = try #require(workout.sets.first); other.note = "Another correction"
    #expect(gym.run(CorrectSet(other))?.receipt != nil)
    draft.reps = 8
    #expect(!draft.save(gym) && draft.reps == 8 && draft.weightKg == 62.5)
    #expect(gym.refusal == .stale(original.id.ref, .predicted) && draft.failure == "This changed elsewhere. Review the latest version.")
    #expect(workout.sets == [other])
  }

  @Test func finishedCorrectionKeepsSessionAndRetriesStorageFailureThenRefusesAStaleDraft() throws {
    let logs = TrainingLogUITests(), (harness, gym) = logs.fixture()
    let value = try logs.session(gym, daysAgo: 1)
    let original = try #require(gym.sets.first { $0.sessionId == value.id }), draft = SetFixDraft(original, account: nil)
    draft.weightKg = 80; draft.reps = 8; draft.rpe = 8.5; draft.note = "Private note"
    harness.failNextCommit()
    #expect(!draft.save(gym) && draft.failure == "The log didn’t answer — that set wasn’t changed.")
    #expect(gym.sets.first { $0.id == original.id } == original)
    #expect(draft.save(gym) && draft.failure == nil)
    #expect(gym.sets.first { $0.id == original.id } == draft.value && draft.original == draft.value)
    #expect(gym.sessions.first { $0.id == value.id } == value)
    let stale = SetFixDraft(original, account: nil); stale.weightKg = 80
    #expect(!stale.save(gym) && gym.refusal == .stale(original.id.ref, .predicted))
    #expect(stale.failure == "This changed elsewhere. Review the latest version.")
  }

  @Test func fixAndDeleteRefuseAnotherAccountsLogAndWriteNothing() throws {
    let logs = TrainingLogUITests(), (_, gym) = logs.fixture()
    let value = try logs.session(gym, daysAgo: 1)
    let original = try #require(gym.sets.first { $0.sessionId == value.id }), draft = SetFixDraft(original, account: "another-account")
    draft.weightKg = 62.5
    #expect(!draft.save(gym) && draft.failure == "The workout changed. Check the current set")
    draft.failure = nil
    #expect(!draft.delete(gym) && draft.failure == "The workout changed. Check the current set")
    #expect(gym.sets.filter { $0.sessionId == value.id } == [original])
  }

  @Test func deleteRemovesTheSetBehindAnUndo() throws {
    let logs = TrainingLogUITests(), (_, gym) = logs.fixture()
    let value = try logs.session(gym, daysAgo: 1)
    let original = try #require(gym.sets.first { $0.sessionId == value.id }), draft = SetFixDraft(original, account: nil)
    #expect(draft.delete(gym) && draft.failure == nil)
    #expect(gym.sets.filter { $0.sessionId == value.id }.isEmpty && gym.undoOffers.count == 1)
  }

  @Test func goneFixClosesWithoutRecreatingSet() throws {
    let workouts = WorkoutStateTests(), (_, gym) = try workouts.fixture(), workout = try workouts.begin(gym)
    workout.logSet()
    let old = try #require(workout.sets.first), draft = SetFixDraft(old, account: gym.account)
    #expect(gym.run(DeleteSet(old.id))?.receipt != nil)
    draft.note = "Gone draft"
    #expect(draft.save(gym) && workout.sets.isEmpty && !draft.busy)
    #expect(gym.error == "That set is no longer here." && draft.failure == nil)
  }
}
