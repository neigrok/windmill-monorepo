import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

struct PreferencesTests {
  @Test func theThreePhonePreferencesAgreeWithTheRegistry() throws {
    try RegistryCheck.entity(GymPreferences.self, sample: GymPreferences(), book: GymRules.book, registry: SyncSchema.registry)
  }

  @Test func concurrentPreferenceEditsPreserveUntouchedRegistersWithoutGuards() throws {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let b = a.device()
    var initial = Draft(new: GymPreferences())
    initial.current.confirmHaptic = false
    #expect(saved(a.runner.save(&initial, SavePreferences.self)))
    a.sync()
    var mine = try a.runner.open(ID("prefs"), orNew: GymPreferences())
    var theirs = try b.runner.open(ID("prefs"), orNew: GymPreferences())
    mine.current.units = "lb"
    theirs.current.confirmSound = true
    #expect(saved(a.runner.save(&mine, SavePreferences.self)))
    #expect(saved(b.runner.save(&theirs, SavePreferences.self)))
    a.sync()
    let expected = GymPreferences(units: "lb", confirmHaptic: false, confirmSound: true)
    #expect(try a.drawn(GymPreferences.self) == [expected])
    #expect(try b.drawn(GymPreferences.self) == [expected])
    #expect(try a.notices(GymRefusal.self).isEmpty && b.notices(GymRefusal.self).isEmpty)
  }

  @Test(arguments: try Contract.vectors("gym/domain/preferences-actions.json"))
  func vector(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let result: JSON
    if let action = vector.input["action"] {
      switch try action.asString() {
      case "SavePreferences":
        let value = try GymPreferences(form: input.member("preferences"))
        result = try corpus.save(SavePreferences.self, vector, opening: GymPreferences(), edit: { $0 = value }, result: \.form, refusal: \.form)
      case let name: throw ContractError("no preferences action \(name)")
      }
    } else {
      result = try corpus.read(vector, in: GymPreferences.scope) { read in
        switch try vector.input.member("read").asString() {
        case "Preferences":
          let value = try read.repository(GymPreferences.self).find(ID("prefs"), in: .drawn) ?? GymPreferences()
          return ["id": value.id.json, "fields": .object(fields: value.fields)]
        case "RestSettings":
          let rest = try restSettings(read)
          return ["seconds": .of(rest.seconds), "sound": .bool(rest.sound)]
        case let name: throw ContractError("no preferences read \(name)")
        }
      }
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}
