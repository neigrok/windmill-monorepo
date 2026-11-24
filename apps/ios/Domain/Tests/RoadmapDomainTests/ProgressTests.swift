import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A person's marks and an owner's pointers: each case of progress-actions.json by its complete decision.
struct ProgressTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/progress-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try RoadmapAct.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }
}
