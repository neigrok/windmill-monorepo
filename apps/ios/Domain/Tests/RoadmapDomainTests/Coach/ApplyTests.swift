import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A proposal the person decides (apply-actions.json): Apply as one act, its settling, Reject, and the mark of an Undo that
// took something back, each case by its complete decision over its records, and over them reversed.
struct ApplyTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/apply-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try RoadmapAct.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }
}
