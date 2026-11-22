import Testing
@testable import Windmill

@Suite @MainActor struct RoadmapChromeTests {
  // Roadmap · iOS 02.2, 03.4, 03.6b, 03.9, 02.12 and 10.6a: the band's words over what the model tells of the act. A
  // step completed on its own page says what opened, and its own name only where nothing did.
  @Test func theBandSaysWhatTheActDidInTheBoardsWords() {
    let said: [RoadmapModel.Band.Says] = [
      .completed(step: "Read the wind", upNext: ["Leave the dock"], inPlace: false), .completed(step: "Tie a bowline", upNext: [], inPlace: false),
      .completed(step: "Name the boat parts", upNext: ["Rig the boat", "Read the wind", "Tie a bowline"], inPlace: false),
      .completed(step: "", upNext: [""], inPlace: false),
      .completed(step: "Read the wind", upNext: ["Leave the dock"], inPlace: true), .completed(step: "Tie a bowline", upNext: [], inPlace: true),
      .completed(step: "Name the boat parts", upNext: ["Rig the boat", "Read the wind"], inPlace: true), .completed(step: "", upNext: [""], inPlace: true),
      .reset(step: "Name the boat parts", locked: 2), .reset(step: "Read the wind", locked: 1), .reset(step: "Rig the boat", locked: 0),
      .reset(step: "", locked: 0),
      .deleted(step: "Read the wind"), .refused(.keepsStartingStep), .refused(.full),
    ]
    #expect(said.map(\.words) == [
      "Read the wind done · Leave the dock up next", "Tie a bowline done", "Name the boat parts done · 3 up next",
      "Untitled step done · Untitled step up next",
      "Leave the dock is up next", "Tie a bowline done", "2 steps up next", "Untitled step is up next",
      "2 steps locked again", "1 step locked again", "Rig the boat reset", "Untitled step reset",
      "Read the wind deleted", "A roadmap keeps one starting step", "This roadmap is at its limit.",
    ])
  }

  // Roadmap · iOS 03.8: the delete question's cost line, by how many steps follow the step.
  @Test func theDeleteQuestionSaysWhatTheDeleteCosts() {
    #expect([0, 1, 2].map(DeleteQuestion.cost) == ["Removes this step", "Removes this step · 1 branch resplices", "Removes this step · 2 branches resplice"])
  }
}
