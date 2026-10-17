import Testing
@testable import Windmill

@Suite @MainActor struct GymRoomTests {
  // The hidden workout's accessory goes where the tab bar goes (ios-redesign §7.18), by the one rule both iOS 26 branches
  // draw from: never on a tab whose front screen hides the bar, never without a hidden workout.
  @Test func theAccessoryStandsOnlyWhereTheTabBarDoes() {
    let tabs: [GymRoom.Tab] = [.routines, .log, .coach]
    #expect(tabs.map { GymRoom.accessoryStands(workoutHidden: true, tab: $0, hiddenTabBars: [.log]) } == [true, false, true])
    #expect(tabs.map { GymRoom.accessoryStands(workoutHidden: true, tab: $0, hiddenTabBars: []) } == [true, true, true])
    #expect(tabs.map { GymRoom.accessoryStands(workoutHidden: false, tab: $0, hiddenTabBars: []) } == [false, false, false])
  }
}
