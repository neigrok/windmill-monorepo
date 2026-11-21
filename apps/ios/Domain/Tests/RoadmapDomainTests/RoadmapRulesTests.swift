import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// Roadmap's rule book against its pinned file, its refusal and the registry, and every LOCAL rule against its vectors.
struct RoadmapRulesTests {
  @Test func theBookIsThePinnedOne() throws {
    try RuleBookParity.check(RoadmapRules.book, file: "roadmap/domain/rules.json")
  }

  @Test func everyCodeMapsAndEveryLocalRuleHasVectors() throws {
    let actions = ["roadmaps", "steps", "kinds", "progress", "workspace"].map { "roadmap/domain/\($0)-actions.json" }
    try RuleBookCheck.check(RoadmapRules.book, refusal: RoadmapRefusal.self, vectors: "roadmap/domain/values.json", actionVectors: actions)
  }

  @Test func everyEntityAgreesWithTheRegistryItsSampleSettingEveryFieldItWrites() throws {
    let (book, registry) = (RoadmapRules.book, SyncSchema.registry)
    let tree = ID<RoadmapEntry>("t_0000000000000001")
    let basics = ID<RoadmapStep>("basics")
    try RegistryCheck.entity(RoadmapEntry.self, sample: RoadmapEntry(id: tree), book: book, registry: registry)
    try RegistryCheck.entity(RoadmapMeta.self, sample: RoadmapMeta(title: "Learn Rust", guide: "One step a day.", visibility: "unlisted"),
                             book: book, registry: registry)
    let step = RoadmapStep(id: basics, label: "Basics", icon: "book", color: "olive", ord: "a0", description: "Start here.",
                           links: [Step.Link(url: "https://doc.rust-lang.org", label: "Docs")])
    try RegistryCheck.entity(RoadmapStep.self, sample: step, book: book, registry: registry)
    try RegistryCheck.entity(RoadmapLink.self, sample: RoadmapLink(from: basics, to: ID("ownership")), book: book, registry: registry)
    let kind = RoadmapKind(id: ID("learn"), hue: "olive", label: "Learn", description: "Things you figure out", ord: "a1")
    try RegistryCheck.entity(RoadmapKind.self, sample: kind, book: book, registry: registry)
    try RegistryCheck.entity(StepMark.self, sample: StepMark(id: ID("basics"), status: "complete", outOfOrder: true), book: book, registry: registry)
    try RegistryCheck.entity(StepPointer.self, sample: StepPointer(id: ID("basics"), opens: tree), book: book, registry: registry)
    try RegistryCheck.entity(Subtask.self, sample: Subtask(id: ID("sub00001"), step: basics, label: "Install rustup", done: true),
                             book: book, registry: registry)
    try RegistryCheck.entity(WorkspaceLink.self, sample: WorkspaceLink(id: ID("lnk00001"), step: basics, url: "https://www.rust-lang.org", title: "Rust"),
                             book: book, registry: registry)
    try RegistryCheck.entity(StepNote.self, sample: StepNote(id: ID("basics"), text: "Moves, not copies."), book: book, registry: registry)
  }

  @Test(arguments: try Contract.vectors("roadmap/domain/values.json"))
  func localRule(_ vector: Vector) throws {
    let result = try ProductCorpus(RoadmapRules.book).value(vector)
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }
}

extension RoadmapRefusal {
  // The forms packages/api-contract/roadmap/domain/README.md states.
  var form: JSON {
    switch self {
    case .invalid(let violation): ["invalid": violation.form]
    case .gone(let subject, let path): ["gone": ["subject": subject.form, "path": path.form]]
    case .taken(let subject, let path): ["taken": ["subject": subject.form, "path": path.form]]
    case .tooLarge(let subject, let path): ["tooLarge": ["subject": subject.form, "path": path.form]]
    case .full(let type, let cap, let path): ["full": ["type": .string(type), "cap": JSON(cap), "path": path.form]]
    case .roadmapGone(let refused): ["roadmapGone": refused.form]
    case .unreachable(let refused): ["unreachable": refused.form]
    case .notARoot(let refused): ["notARoot": refused.form]
    case .stepOpensARoadmap(let refused): ["stepOpensARoadmap": refused.form]
    case .depthLimit(let refused): ["depthLimit": refused.form]
    case .other(let refused): ["other": refused.form]
    }
  }
}
