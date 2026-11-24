import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The shared address cases, `packages/api-contract/roadmap-addresses.json`, which the web's router and the backend's
// `WebAddress` also run: each address names its roadmap and step, and each is written back as the case writes it.
struct AddressesTests {
  struct Case: CustomTestStringConvertible, Sendable {
    let why: String
    let tree: String
    let step: String?
    let yours: Bool
    let address: String

    var testDescription: String { "\(why) — \(address)" }
  }

  static func cases() throws -> [Case] {
    try Contract.json("roadmap-addresses.json").member("cases").asArray().map { one in
      Case(why: try one.member("why").asString(), tree: try one.member("treeId").asString(), step: try one["nodeId"]?.asString(),
           yours: try one.member("yours").asBool(), address: try one.member("address").asString())
    }
  }

  // An address as the system hands it over: its path, and its fragment without the `#`.
  static func read(_ address: String) -> RoadmapAddress? {
    let parts = address.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
    return RoadmapAddress(path: String(parts[0]), fragment: parts.count > 1 ? String(parts[1]) : nil)
  }

  @Test func theCasesHoldEveryFormOfAnAddress() throws {
    let forms = Set(try Self.cases().map { "\($0.yours ? "yours" : "theirs") \($0.step == nil ? "roadmap" : "step")" })
    #expect(forms == ["yours roadmap", "theirs roadmap", "yours step", "theirs step"])
  }

  @Test(arguments: try cases())
  func anAddressNamesItsRoadmapAndStepAndIsWrittenSo(_ one: Case) throws {
    let read = try #require(Self.read(one.address))
    #expect(read == RoadmapAddress(tree: one.tree, step: one.step))
    #expect((one.yours ? read.own : read.shared) == one.address)
  }

  @Test(arguments: ["/t/", "/t", "/t/not-a-tree", "/t/t_9362D9BC883E0A1E", "/t/t_9362d9bc883e0a1e/more", "/#/app/t_123", "/#/app/new",
                    "/#/app/", "/#/settings", "/t/t_9362d9bc883e0a1e#/browse", "/gallery", "/"])
  func anAddressOfNoRoadmapNamesNone(_ address: String) {
    #expect(Self.read(address) == nil)
  }

  @Test func aShareWithATrailingSlashAndAnAppRouteOverAShareAreRead() {
    #expect(Self.read("/t/t_9362d9bc883e0a1e/") == RoadmapAddress(tree: "t_9362d9bc883e0a1e"))
    #expect(Self.read("/t/t_00000000000000aa#/app/t_9362d9bc883e0a1e?step=a%2Fb") == RoadmapAddress(tree: "t_9362d9bc883e0a1e", step: "a/b"))
  }
}
