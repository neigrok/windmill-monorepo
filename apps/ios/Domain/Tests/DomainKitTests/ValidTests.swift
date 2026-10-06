import DomainKit
import SyncAPI
import SyncCore
import Testing

// §4.5 and INV-5: `Valid` refuses a U+0000 that no check caught in a field it names, since the engine refuses it in every
// string it sends; a field it does not name is not read.
struct ValidTests {
  @Test(arguments: [true, false])
  func readGuardsMayAccompanyOneWriteOfTheSameRecord(guardFirst: Bool) throws {
    let card = Kit.Card(id: ID("card0001"), title: "Push")
    var plan = Plan()
    if guardFirst { plan.guardRead(card.id, fields: ["tier", "title"]) }
    plan.update(try Valid(card, fields: ["title"], at: Kit.moment), fields: ["title"], guarded: true)
    plan.guardRead(card.id, fields: ["tier"])
    let gesture = try plan.gesture(in: Kit.Card.scope, registry: Kit.registry)
    #expect(gesture == Gesture(changes: [.update("card", card.id.record, ["title": .string("Push")])], guards: [
      RegisterRef(type: "card", id: card.id.record, field: "tier"),
      RegisterRef(type: "card", id: card.id.record, field: "title"),
    ]))
  }

  @Test func readGuardsDoNotPermitTwoWritesOfTheSameRecord() throws {
    let card = Kit.Card(id: ID("card0001"), title: "Push")
    var plan = Plan()
    plan.guardRead(card.id, fields: ["tier"])
    for _ in 0..<2 { plan.update(try Valid(card, fields: ["title"], at: Kit.moment), fields: ["title"]) }
    #expect(throws: PlanError(rule: 2, "two operations name \(card.id.ref.key)")) {
      try plan.gesture(in: Kit.Card.scope, registry: Kit.registry)
    }
  }

  @Test func aNulNoCheckCatchesIsAViolationOfItsField() {
    var card = Kit.Card(id: ID("card0001"), title: "Push")
    card.body = "Sets\u{0}"
    #expect(throws: Violation(rule: "card.body", path: "body", reason: .nul)) { try Valid(card, at: Kit.moment) }
    #expect(throws: Never.self) { try Valid(card, fields: ["title"], at: Kit.moment) }
  }

  @Test func aNestedNulNamesItsPath() {
    var card = Kit.Card(id: ID("card0001"), title: "Push")
    card.extra = ["cues": ["fine", "cue\u{0}"]]
    #expect(throws: Violation(rule: "card.extra", path: "extra.cues.1", reason: .nul)) { try Valid(card, fields: ["extra"], at: Kit.moment) }
  }
}
