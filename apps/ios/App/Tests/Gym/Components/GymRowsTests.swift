import Testing
import DomainKit
import GymDomain
import SyncCore
@testable import Windmill

@Suite @MainActor struct GymRowsTests {
  @Test func aSessionsTilesDrawTheFactsItsReadoutKnowsWithLabelsThatAgree() {
    let start = Instant(ms: 1_790_164_800_000)
    let set = { (id: String, kg: Double) in
      TrainingSet(id: ID(RecordID(id)), sessionId: ID("push"), exerciseId: ID("bench-press"), weightKg: kg, reps: 5, completedAt: start)
    }
    var session = Session(id: ID("push"), startedAt: start, finishedAt: Instant(ms: start.ms + 3_780_000))
    #expect(FactTiles(SessionReadout(session: session, sets: [set("1", 80)], catalogue: Catalogue(custom: [], names: []))).facts == [
      .init(value: "1h 03m", label: "Duration"), .init(value: "1", label: "Working set"), .init(value: "400 kg", label: "Volume"),
    ])
    session.finishedAt = nil
    #expect(FactTiles(SessionReadout(session: session, sets: [set("1", 80), set("2", 82.5)], catalogue: Catalogue(custom: [], names: []))).facts == [
      .init(value: "2", label: "Working sets"), .init(value: "812.5 kg", label: "Volume"),
    ])
  }

  // A finished set reads its place and numbers, then what it says against the plan, then its effort and note, as one line.
  @Test func aSetRowReadsAsOneLine() {
    var set = TrainingSet(id: ID("set"), sessionId: ID("push"), exerciseId: ID("bench-press"), weightKg: 100, reps: 5, completedAt: Instant(ms: 0))
    #expect(SetRow(marker: "1", set: set).spoken == "1 · 100 × 5")
    set.weightKg = 90; set.rpe = 8; set.note = "Smooth last set."
    #expect(SetRow(marker: "1", set: set, caption: "+30 over plan").spoken == "1 · 90 × 5, +30 over plan, RPE 8 · Smooth last set.")
    #expect(SetRow(marker: "2", set: set, time: "9:41", reading: .columns).spoken == "2 · 90 × 5, 9:41 · RPE 8 · Smooth last set.")
  }

  @Test func everyDoorThatDiscardsAWorkoutAsksInTheBoardsWords() {
    #expect([0, 1, 5].map(DiscardWorkoutAlert.message(sets:)) == [
      "This deletes the workout. You can’t undo this.",
      "This deletes the workout and its 1 set. You can’t undo this.",
      "This deletes the workout and its 5 sets. You can’t undo this.",
    ])
  }
}
