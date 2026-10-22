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
}
