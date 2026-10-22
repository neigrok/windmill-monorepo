import Testing
import GymDomain
import JournalDomain
@testable import Windmill

@Suite @MainActor struct AdoptionQuestionTests {
  func words(_ counts: [String: Int], _ rooms: Set<AppModel.Room>) -> [String] {
    let question = AdoptionQuestion(counts: counts, rooms: rooms)
    return [question.title, question.message, question.discardTitle, question.discardMessage]
  }

  @Test func workoutsAloneAsk23dAnd23f() {
    #expect(words([Session.type: 3, TrainingSet.type: 12, Exercise.type: 0], [.gym]) == [
      "Add to your account?",
      "This phone has 3 workouts from before you signed in. Your account already has training. Add them, or discard them from this phone.",
      "Discard 3 workouts?",
      "They are deleted from this phone. You can’t undo this.",
    ])
  }

  @Test func journalPagesAloneAsk23gAnd23h() {
    #expect(words([Page.type: 3, JournalState.type: 1], [.journal]) == [
      "Add to your account?",
      "This phone has 3 journal pages from before you signed in. Your account already has journal pages. Add them, or discard them from this phone.",
      "Discard 3 journal pages?",
      "They are deleted from this phone. You can’t undo this.",
    ])
  }

  @Test func bothRoomsAsk23iAnd23j() {
    #expect(words([Page.type: 3, Session.type: 2, TrainingSet.type: 7], [.journal, .gym]) == [
      "Add to your account?",
      "This phone has 2 workouts and 3 journal pages from before you signed in. Your account already has training and journal pages. Add them, or discard them from this phone.",
      "Discard 2 workouts and 3 journal pages?",
      "They are deleted from this phone. You can’t undo this.",
    ])
  }

  @Test func threeKindsOrMoreAreDiscardedAsAllOfIt() {
    #expect(words([WeighIn.type: 1, Routine.type: 1, Session.type: 2, GymPreferences.type: 1, ExerciseName.type: 2], [.gym]) == [
      "Add to your account?",
      "This phone has 2 workouts, 1 routine and 1 weigh-in from before you signed in. Your account already has training. Add them, or discard them from this phone.",
      "Discard all of it?",
      "2 workouts, 1 routine and 1 weigh-in are deleted from this phone. You can’t undo this.",
    ])
    #expect(AdoptionQuestion(counts: [Note.type: 2, Exercise.type: 1, Routine.type: 1, Page.type: 1], rooms: [.gym, .journal]).phrase
            == "1 routine, 1 movement, 2 notes and 1 journal page")
  }

  @Test func oneItemIsItAndAPhoneOfUnnamedKindsCountsChanges() {
    #expect(words([Routine.type: 1], [.gym]) == [
      "Add to your account?",
      "This phone has 1 routine from before you signed in. Your account already has training. Add it, or discard it from this phone.",
      "Discard 1 routine?",
      "It is deleted from this phone. You can’t undo this.",
    ])
    #expect(AdoptionQuestion(counts: [GymPreferences.type: 1], rooms: [.gym]).message
            == "This phone has 1 change from before you signed in. Your account already has training. Add it, or discard it from this phone.")
    #expect(AdoptionQuestion(counts: [GymPreferences.type: 1, ExerciseName.type: 2], rooms: [.gym]).discardTitle == "Discard 3 changes?")
  }
}
