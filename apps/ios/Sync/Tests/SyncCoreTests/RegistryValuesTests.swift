import SyncCore
import SyncTesting
import Testing

// A command's arguments rounded at any depth, as a commit sends them; and the checks admission runs, every number on its
// domain's quantum wherever it stands. The corpus pins field values; these pin arguments and the edges it does not.

struct RegistryValuesTests {
  static let gym = try! Registry(json: Corpus.registryFile("gym"))

  static func importing(_ sets: JSON, extra: JSON.Object = [:]) -> Command {
    var args: JSON.Object = ["id": "sess0001", "startedAt": 1_000, "finishedAt": 2_000, "sets": sets]
    for (name, value) in extra.members { args[name] = value }
    return Command(name: "gym.importSession", args: .object(args))
  }

  static func set(weightKg: JSON, rpe: JSON) -> JSON {
    ["id": "set00001", "exerciseId": "dip", "weightKg": weightKg, "reps": 5, "rpe": rpe, "completedAt": 1_500]
  }

  @Test func aCommandsArgumentsRoundToTheirDomainsQuantaAtAnyDepth() {
    let rounded = Self.gym.rounded(Self.importing([Self.set(weightKg: 60.004, rpe: 7.25), Self.set(weightKg: -0.005, rpe: .null)]))
    #expect(rounded == Self.importing([Self.set(weightKg: 60, rpe: 7.3), Self.set(weightKg: -0.01, rpe: .null)]))
  }

  // What the registry does not declare is left for admission to refuse: an unknown argument, an argument of another
  // shape, and a command the registry holds no such name of.
  @Test func whatTheRegistryDoesNotDeclareIsLeftAsItIs() {
    let unknown = Self.importing([Self.set(weightKg: 60.004, rpe: 7.25)], extra: ["extra": 1.005])
    #expect(Self.gym.rounded(unknown) == Self.importing([Self.set(weightKg: 60, rpe: 7.3)], extra: ["extra": 1.005]))
    #expect(Self.gym.rounded(Self.importing(["weightKg": 60.004])) == Self.importing(["weightKg": 60.004]))
    let stranger = Command(name: "gym.lift", args: ["weightKg": 60.004])
    #expect(Self.gym.rounded(stranger) == stranger)
  }

  @Test func aNestedNumberIsAdmittedOnlyOnItsQuantum() throws {
    let sets = try #require(Self.gym.command("gym.importSession")?.args.first { $0.name == "sets" })
    #expect(Self.gym.admits([Self.set(weightKg: 60.01, rpe: 7.3)], for: sets))
    #expect(!Self.gym.admits([Self.set(weightKg: 60.004, rpe: 7.3)], for: sets))
    #expect(!Self.gym.admits([Self.set(weightKg: 60, rpe: 7.25)], for: sets))
  }

  // A number too large to round in doubles stays as it is, and its domain refuses it.
  @Test func aNumberTooLargeToRoundStaysAsItIs() throws {
    let kg = try #require(Self.gym.type("weighin")?.field("kg")?.domain)
    #expect(kg.rounded(1e308) == 1e308)
    #expect(!kg.admits(1e308))
  }
}
