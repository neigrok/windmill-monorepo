import Testing
import DomainKit
import RoadmapDomain
import SyncCore
@testable import Windmill

@Suite @MainActor struct RoadmapChromeTests {
  // Roadmap · iOS 02.2, 03.4, 03.6b, 03.9, 05.7, 02.12 and 10.6a: the band's words over what the model tells of the act.
  // A step completed on its own page says what opened, and its own name only where nothing did.
  @Test func theBandSaysWhatTheActDidInTheBoardsWords() {
    let said: [RoadmapModel.Band.Says] = [
      .completed(step: "Read the wind", upNext: ["Leave the dock"], inPlace: false), .completed(step: "Tie a bowline", upNext: [], inPlace: false),
      .completed(step: "Name the boat parts", upNext: ["Rig the boat", "Read the wind", "Tie a bowline"], inPlace: false),
      .completed(step: "", upNext: [""], inPlace: false),
      .completed(step: "Read the wind", upNext: ["Leave the dock"], inPlace: true), .completed(step: "Tie a bowline", upNext: [], inPlace: true),
      .completed(step: "Name the boat parts", upNext: ["Rig the boat", "Read the wind"], inPlace: true), .completed(step: "", upNext: [""], inPlace: true),
      .reset(step: "Name the boat parts", locked: 2), .reset(step: "Read the wind", locked: 1), .reset(step: "Rig the boat", locked: 0),
      .reset(step: "", locked: 0),
      .deleted(step: "Read the wind"), .deletedRoadmap("Learn to sail"), .deletedRoadmap(""), .deletedRoadmap(nil),
      .created(step: "Reefing basics", in: .locked), .created(step: "", in: .upNext), .saved(step: "Read the wind"), .saved(step: ""),
      .refused(.keepsStartingStep), .refused(.full),
    ]
    #expect(said.map(\.words) == [
      "Read the wind done · Leave the dock up next", "Tie a bowline done", "Name the boat parts done · 3 up next",
      "Untitled step done · Untitled step up next",
      "Leave the dock is up next", "Tie a bowline done", "2 steps up next", "Untitled step is up next",
      "2 steps locked again", "1 step locked again", "Rig the boat reset", "Untitled step reset",
      "Read the wind deleted", "Learn to sail deleted", "Untitled roadmap deleted", "Untitled roadmap deleted",
      "Reefing basics added · Locked", "Untitled step added · Up next", "Read the wind saved", "Untitled step saved",
      "A roadmap keeps one starting step", "This roadmap is at its limit.",
    ])
  }

  // Roadmap · iOS 02.10d and 06.5c: an Undo that brought nothing back names what could not come back, one thing by its
  // name and several steps by their count, and says it could not undo an act that is not a delete.
  @Test func theBandSaysWhatAnUndoCouldNotBringBack() {
    let receipts: [RoadmapModel.Band.Says] = [
      .deleted(step: "Read the wind"), .deleted(step: ""), .deletedSteps(count: 2), .removedKind("Practice"), .deletedRoadmap("Learn to sail"),
      .deletedRoadmap(nil), .deletedFromWorkspace("Check the harbour flag"), .completed(step: "Read the wind", upNext: [], inPlace: true),
      .reset(step: "Rig the boat", locked: 0), .recolored(count: 2), .checked(DomainKit.ID(RecordID("subtask")), label: "Check the harbour flag"),
    ]
    #expect(receipts.map { RoadmapModel.Band(unrestored: $0).says.words } == [
      "Couldn’t bring back Read the wind", "Couldn’t bring back Untitled step", "Couldn’t bring back 2 steps", "Couldn’t bring back Practice",
      "Couldn’t bring back Learn to sail", "Couldn’t bring back Untitled roadmap", "Couldn’t bring back Check the harbour flag",
      "Couldn’t undo", "Couldn’t undo", "Couldn’t undo", "Couldn’t undo",
    ])
  }

  // Roadmap · iOS 01.10: what else a roadmap's delete takes, by how many steps open it and the roadmaps that hold them,
  // the first two by name and one without a title by the room's words for it.
  @Test func aRoadmapsDeleteQuestionSaysWhatElseGoes() {
    let openers = [
      RoadmapModel.Openers(steps: 1, roadmaps: ["Become a day skipper"]), RoadmapModel.Openers(steps: 3, roadmaps: [""]),
      RoadmapModel.Openers(steps: 2, roadmaps: ["Become a day skipper", nil]),
      RoadmapModel.Openers(steps: 3, roadmaps: ["Become a day skipper", "Ship v1", "Run a 10k"]),
      RoadmapModel.Openers(steps: 5, roadmaps: ["Become a day skipper", "Ship v1", "Run a 10k", "Room makeover"]),
    ]
    #expect(openers.map(DeleteRoadmapQuestion.cost) == [
      "Also removes the step that opens it in Become a day skipper", "Also removes 3 steps that open it in Untitled roadmap",
      "Also removes 2 steps that open it, in Become a day skipper and Untitled roadmap",
      "Also removes 3 steps that open it, in Become a day skipper, Ship v1 and 1 more roadmap",
      "Also removes 5 steps that open it, in Become a day skipper, Ship v1 and 2 more roadmaps",
    ])
  }

  // Roadmap · iOS 03.8: the delete question's cost line, by how many steps follow the step.
  @Test func theDeleteQuestionSaysWhatTheDeleteCosts() {
    #expect([0, 1, 2].map(DeleteQuestion.cost) == ["Removes this step", "Removes this step · 1 branch resplices", "Removes this step · 2 branches resplice"])
  }
}
