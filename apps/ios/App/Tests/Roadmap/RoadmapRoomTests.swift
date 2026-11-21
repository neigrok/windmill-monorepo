import Testing
@testable import Windmill

@Suite @MainActor struct RoadmapRoomTests {
  // Roadmap · iOS 02.2, 03.9, 02.12 and 10.6a: the band's words over what the model tells of the act.
  @Test func theBandSaysWhatTheActDidInTheBoardsWords() {
    let said: [RoadmapModel.Band.Says] = [
      .completed(step: "Read the wind", upNext: ["Leave the dock"]), .completed(step: "Tie a bowline", upNext: []),
      .completed(step: "Name the boat parts", upNext: ["Rig the boat", "Read the wind", "Tie a bowline"]), .completed(step: "", upNext: [""]),
      .deleted(step: "Read the wind"), .refused(.keepsStartingStep), .refused(.full),
    ]
    #expect(said.map(RoadmapRoom.words) == [
      "Read the wind done · Leave the dock up next", "Tie a bowline done", "Name the boat parts done · 3 up next",
      "Untitled step done · Untitled step up next", "Read the wind deleted", "A roadmap keeps one starting step", "This roadmap is at its limit.",
    ])
  }
}
