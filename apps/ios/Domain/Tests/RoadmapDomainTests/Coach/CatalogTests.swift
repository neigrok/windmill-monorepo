import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import SyncSchema
import Testing

// Catalog `roadmap/1` as the phone reads it, and the caps of packages/api-contract/roadmap/limits.json the phone holds a
// direct write to before anything is sent (Roadmap Coach §6, rule 4).
struct CatalogTests {
  @Test func everyAbilityIsDeclaredOfferedToEverySeatAndDeclaredToNoProviderAsStrict() {
    #expect(Catalog.roadmap.version == "roadmap/1")
    #expect(Catalog.roadmap.abilities.map(\.name) == RoadmapAbilities.names + ["propose_roadmap_change"])
    #expect(Catalog.roadmap.offered(seat: .anon).map(\.name) == Catalog.roadmap.abilities.map(\.name))
    #expect(Catalog.roadmap.abilities.allSatisfy { !$0.strict })
  }

  @Test func theCapsALimitNamesAreTheOnesTheDomainHoldsAWriteTo() throws {
    let specs: [String: Int] = [
      "label": RoadmapSpecs.label.max, "description": RoadmapSpecs.description.max, "links": RoadmapSpecs.links.max,
      "linkLabel": RoadmapSpecs.linkLabel.max, "linkUrl": RoadmapSpecs.linkUrl.max, "subtask": RoadmapSpecs.subtask.max,
      "kindLabel": RoadmapSpecs.kindLabel.max, "kindDescription": RoadmapSpecs.kindDescription.max,
    ]
    for limit in try Contract.json("roadmap/limits.json").member("limits").asObject().members {
      let max = Int(try limit.value.member("max").asInteger())
      if let web = try limit.value["web"]?.asString() {
        #expect(specs[web] == max, "\(limit.key)")
        continue
      }
      let registered = try limit.value.member("registry").asArray().map { try $0.asString() }
      guard try limit.value.member("unit").asString() == "items", registered.count == 1, let type = SyncSchema.registry.type(registered[0]) else { continue }
      #expect(type.cap == max, "\(limit.key)")
    }
  }
}
