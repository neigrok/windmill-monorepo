import Foundation
import Testing
@testable import Windmill

extension CoachTests {
  @Test func theGreetingOffersOnlyWhatCoachDoes() {
    let lines = { (signedIn: Bool) in CoachSetupView(signedIn: signedIn, choose: { _ in }).capabilities.map { "\($0.0) — \($0.1)" } }
    #expect(lines(true) == [
      "Build — a program from a screenshot or your own words.",
      "Goals — tell me your goals, and I will plan for them.",
      "Notes — I save important facts, like an old injury.",
      "Changes — ask me, and I suggest changes to your routines.",
    ])
    #expect(lines(false) == [
      "Build — a program from a screenshot or your own words.",
      "Goals — tell me your goals, and I will plan for them.",
      "Account — sign in, and I can also save notes and suggest changes to your routines.",
    ])
    #expect(CoachSetupView.choices.map { "coach-setup-\($0.choice.rawValue) \($0.title)" }
            == ["coach-setup-screenshot Add screenshot", "coach-setup-build_manually Build my own"])
  }

  @Test func setupNeedsResolvedHydratedEmptyAccountAndAnUnoccupiedRoom() {
    for mask in 0..<64 {
      let flags = (0..<6).map { mask & (1 << $0) != 0 }
      #expect(CoachSetupEligibility.shouldOffer(signedIn: flags[0], hydrated: flags[1], empty: flags[2], resolved: flags[3],
        occupied: flags[4], hasConversation: flags[5], choice: nil) == (mask == 15))
    }
    for choice in CoachSetupChoice.allCases {
      #expect(!CoachSetupEligibility.shouldOffer(signedIn: true, hydrated: true, empty: true, resolved: true,
        occupied: false, hasConversation: false, choice: choice))
    }
  }

  @Test func oldAndNewRoutineReceiptsDecodeWithoutInventingMovementCounts() throws {
    let results = try JSONDecoder().decode([CoachResult].self, from: Data(#"[{"kind":"routine-created","operationId":"a","routineId":"r1","routineName":"First"},{"kind":"routine-created","operationId":"b","routineId":"r2","routineName":"Second","movementCount":3}]"#.utf8))
    #expect(results.map(\.id) == ["a", "b"] && results.map(\.movementCount) == [nil, 3])
  }
}
