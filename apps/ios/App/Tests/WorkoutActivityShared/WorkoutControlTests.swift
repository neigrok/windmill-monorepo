import Foundation
import Testing
@testable import Windmill

struct WorkoutControlTests {
  static let staleAt = Date(timeIntervalSince1970: 1_790_438_400)
  static let offer = WorkoutControlOffer(offer: WorkoutActivityOffer(ownerID: "replica:anon:session", sessionID: "session",
    movementID: "back-squat", weightKg: 100, reps: 5, setID: "set"), value: "100 × 5")

  func drawn(_ state: WorkoutControlState) -> String {
    [state.symbol, state.title, state.offer?.value ?? "none", state.actionHint].joined(separator: " | ")
  }

  @Test func eachStateDrawsItsSymbolTitleValueAndHint() {
    #expect(drawn(.logSet(Self.offer, staleAt: Self.staleAt)) == "plus | Log set | 100 × 5 | Log 100 × 5")
    #expect(drawn(.openWorkout(staleAt: Self.staleAt)) == "dumbbell.fill | Open workout | none | Open workout")
    #expect(drawn(.startWorkout) == "dumbbell.fill | Start workout | none | Start workout")
  }

  @Test func anOpenWorkoutPastItsFourHoursDrawsAsStartWorkout() {
    let before = Self.staleAt.addingTimeInterval(-1)
    #expect(WorkoutControlState.logSet(Self.offer, staleAt: Self.staleAt).drawn(at: before) == .logSet(Self.offer, staleAt: Self.staleAt))
    #expect(WorkoutControlState.openWorkout(staleAt: Self.staleAt).drawn(at: before) == .openWorkout(staleAt: Self.staleAt))
    #expect(WorkoutControlState.logSet(Self.offer, staleAt: Self.staleAt).drawn(at: Self.staleAt) == .startWorkout)
    #expect(WorkoutControlState.openWorkout(staleAt: Self.staleAt).drawn(at: Self.staleAt) == .startWorkout)
  }

  @Test func theBoardReadsWhatTheAppWroteAndStartWorkoutWhenItHoldsNothing() throws {
    let board = WorkoutControlBoard(url: FileManager.default.temporaryDirectory.appending(path: "workout-control-\(UUID().uuidString).json"))
    defer { try? FileManager.default.removeItem(at: board.url) }
    #expect(board.read() == .startWorkout)
    try board.write(.logSet(Self.offer, staleAt: Self.staleAt))
    #expect(board.read() == .logSet(Self.offer, staleAt: Self.staleAt))
    try Data("garbled".utf8).write(to: board.url)
    #expect(board.read() == .startWorkout)
  }

  @Test func theControlsTapCarriesTheOfferItDrewOrNone() {
    let logSet = WorkoutControlIntent(.logSet(Self.offer, staleAt: Self.staleAt)), offer = Self.offer.offer
    #expect([logSet.ownerID, logSet.sessionID, logSet.movementID, logSet.setID] == [offer.ownerID, offer.sessionID, offer.movementID, offer.setID])
    #expect(logSet.weightKg == 100 && logSet.reps == 5)
    let open = WorkoutControlIntent(.openWorkout(staleAt: Self.staleAt))
    #expect([open.ownerID, open.sessionID, open.movementID, open.setID] == [nil, nil, nil, nil] && open.weightKg == nil && open.reps == nil)
  }
}
