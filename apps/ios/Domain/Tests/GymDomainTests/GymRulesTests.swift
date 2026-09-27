import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// The gym's declarations against the registry and its pinned book, and its LOCAL rules against their vectors.
struct GymRulesTests {
  @Test func everyEntityAgreesWithTheRegistry() throws {
    let sample = Note(id: ID("note0001"), title: "How I want to be talked to", body: "Blunt. No pep talks.")
    try RegistryCheck.entity(Note.self, sample: sample, book: GymRules.book, registry: SyncSchema.registry)
  }

  @Test func everyCodeMapsAndEveryLocalRuleHasVectors() throws {
    try RuleBookCheck.check(GymRules.book, refusal: GymRefusal.self, vectors: "gym/domain/values.json")
  }

  @Test func theBookIsThePinnedOne() throws {
    try RuleBookParity.check(GymRules.book, file: "gym/domain/rules.json")
  }

  // A spec case applies the book's own spec at its field; an entity case validates a note built from its fields.
  @Test(arguments: try Contract.vectors("gym/domain/values.json"))
  func localRule(_ vector: Vector) throws {
    let input = vector.input
    let result: JSON
    do {
      if let spec = input["spec"] {
        let declared = try #require([NoteRules.title, NoteRules.body].first { $0.json == spec })
        let field = String(declared.path.dropFirst("note.".count))
        result = ["value": .string(try declared.apply(try input.member("value").asString(), at: Path(field)))]
      } else {
        let fields = try input.member("fields").asObject().members
        let values = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0.value) })
        let note = try Note(Fields(Record(type: Note.type, id: "vector00", life: nil, born: nil, values: values, texts: [:], serials: [:],
                                          rc: nil, ru: nil, isVisible: true, isPending: false, isHeld: false)))
        let moment = Moment(now: Instant(ms: try input.member("now").asInteger()),
                            zone: FixedZone(offsetSeconds: Int(try input.member("offsetSeconds").asInteger())))
        result = ["fields": .object(fields: try Valid(note, at: moment).value.fields)]
      }
    } catch let violation as Violation {
      result = ["violation": violation.form]
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}
