import DomainKit
import SyncCore
import Testing

// §4.5 and INV-5: `Valid` refuses a U+0000 that no check caught in a field it names, since the engine refuses it in every
// string it sends; a field it does not name is not read.
struct ValidTests {
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
