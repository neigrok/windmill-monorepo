import SyncCore

// Roadmap's server rules (engine.md Appendix A.1): its commands and their inverses, the life a change to a step or a kind
// carries, a root's visibility and the reach of its branch, the end of a root, the owner's workspace and Coach's records.
// corpus/README.md states the same rules. They read records in their wire form and write deltas in it, a null stamp the
// one the server mints.

public struct RoadmapServerRules: ServerRules {
  static let maxDepth: Int64 = 8
  static let ownerOnly: Set<String> = ["pointer", "subtask", "stepLink", "stepNote"]
  static let writerTerminal: [JSON] = ["completed", "declined", "failed", "stopped"]
  static let finalRegisters: Set<String> = ["state", "text", "calls", "receipts"]
  static let revivedByAChange: Set<String> = ["node", "kind"]
  // The genesis legend (packages/api-contract/genesis.js), each kind ordered by its place in it.
  static let genesisKinds: [(id: String, values: JSON.Object)] = [
    ("build", ["hue": "terracotta", "label": "Build", "description": "Things you make", "ord": "a0"]),
    ("learn", ["hue": "olive", "label": "Learn", "description": "Things you figure out", "ord": "a1"]),
    ("milestone", ["hue": "gold", "label": "Milestone", "description": "Moments that matter", "ord": "a2"]),
  ]

  public init() {}

  // MARK: Discovery

  // Discovery reads the owner's roadmaps and declares every scope a command or a consequence reads or writes: the branch
  // under a step whose life the intent touches, the branch under a roadmap whose visibility it writes, the scopes a subtree
  // command plants or uproots, and, for a dying root, the overlays and trees of the steps whose pointer opens it.
  public func discoverEffectScopes(in context: RuleContext, command: CheckedCommand?) throws -> Set<ScopeKey> {
    let account = context.roadmapScope
    let roadmaps = Roadmaps(context.storedRows("tree", in: account))
    var keys: Set<ScopeKey> = []
    func declare(_ tree: String) {
      let key = ScopeKey(.tree(tree))
      if context.state.scopes[key]?.isAlive == true { keys.insert(key) }
    }
    func branch(_ place: RoadmapPlace) {
      for id in roadmaps.branch(of: place) { declare(id) }
    }
    if case .tree(let tree) = context.scope.kind {
      let operations: [RestoreOperation] = command.flatMap { (command: CheckedCommand) -> [RestoreOperation]? in
        guard command.name == "roadmap.restoreTree" else { return nil }
        return try? context.registry.restoreArguments(.object(command.args), of: command.definition).operations
      } ?? []
      let visible = context.deltas.contains { $0.key.type == "meta" && $0.fields["visibility"] != nil }
        || operations.contains { (operation: RestoreOperation) -> Bool in
          guard case .field(let key, .field("visibility"), _, _) = operation else { return false }
          return key.type == "meta"
        }
      if visible {
        keys.insert(account)
        for id in roadmaps.under(tree) { declare(id) }
      }
      let restored: [RecordKey] = operations.filter { (operation: RestoreOperation) -> Bool in
        guard operation.key.type == "node" else { return false }
        guard case .field(_, let slot, _, _) = operation else { return true }
        return slot == .life
      }.map(\.key)
      let touched: [RecordKey] = context.deltas.filter { $0.key.type == "node" && $0.life != nil }.map(\.key) + restored
      if !touched.isEmpty { keys.insert(account) }
      for key in touched { branch(RoadmapPlace(tree: tree, step: Self.name(of: key))) }
      return keys
    }
    guard context.scope == account else { return [] }
    switch command?.name {
    case "roadmap.createSubtree"?:
      let (tree, step, subtree) = (command?.string("tree") ?? "", command?.string("step") ?? "", command?.string("subtree") ?? "")
      keys.formUnion([ScopeKey(.tree(tree)), ScopeKey(.tree(subtree)), context.overlay(of: tree)])
      branch(RoadmapPlace(tree: tree, step: step))
      return keys
    case "roadmap.redoCreateSubtree"?:
      let (tree, step, subtree) = (command?.input("tree") ?? "", command?.input("step") ?? "", command?.input("subtree") ?? "")
      declare(tree)
      keys.insert(ScopeKey(.tree(subtree)))
      branch(RoadmapPlace(tree: tree, step: step))
      return keys
    case "roadmap.undoCreateSubtree"?:
      declare(command?.input("tree") ?? "")
      declare(command?.input("subtree") ?? "")
      return keys
    default:
      break
    }
    let deaths: [String] = command?.name == "roadmap.undoCreateRoadmap" ? [command?.input("tree") ?? ""]
      : context.deltas.filter { $0.key.type == "tree" && $0.life?.state == .dead }.map { Self.name(of: $0.key) }
    let roots = deaths.filter { roadmaps.isAlive($0) && roadmaps.place(of: $0) == nil }
    let lost = Set(roots.flatMap { [$0] + roadmaps.under($0) })
    for tree in roadmaps.ids.filter({ roadmaps.isAlive($0) && !lost.contains($0) }).sorted(by: Self.precedes) {
      let overlay = context.overlay(of: tree)
      let opening = context.storedRows("pointer", in: overlay).filter { Self.isPresent($0) && Self.opens($0, oneOf: roots) }
      if opening.isEmpty { continue }
      keys.insert(overlay)
      declare(tree)
      for pointer in opening { branch(RoadmapPlace(tree: tree, step: Self.id(of: pointer))) }
    }
    return keys
  }

  // `roadmap.createSubtree` replays while the step owns a subtree; roadmap keeps no command receipts.
  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool {
    guard command.name == "roadmap.createSubtree" else { return false }
    let place = RoadmapPlace(tree: command.string("tree"), step: command.string("step"))
    return !Roadmaps(context.storedRows("tree", in: context.scope)).owned(by: place).isEmpty
  }

  public func keptRevisions(_ revisions: [Revision]) -> [Revision] {
    Revision.latestOfEachField(revisions)
  }

  // MARK: Commands

  public func run(_ command: CheckedCommand, in context: RuleContext) throws -> CommandOutcome {
    switch command.name {
    case "roadmap.createSubtree":
      return try createSubtree(RoadmapPlace(tree: command.string("tree"), step: command.string("step")), root: command.string("root"),
                               subtree: command.string("subtree"), in: context)
    case "roadmap.recolourKind":
      return try recolourKind(command.string("kind"), hue: command.args["hue"] ?? .null, in: context)
    case "roadmap.undoCreateRoadmap":
      return try undoCreateRoadmap(command.input("tree"), evidence: try context.registry.evidence(command.args["evidence"] ?? .null), in: context)
    case "roadmap.undoCreateSubtree":
      return try undoCreateSubtree(RoadmapPlace(tree: command.input("tree"), step: command.input("step")), subtree: command.input("subtree"),
                                   evidence: try context.registry.evidence(command.args["evidence"] ?? .null), in: context)
    case "roadmap.redoCreateSubtree":
      return try redoCreateSubtree(RoadmapPlace(tree: command.input("tree"), step: command.input("step")), root: command.input("root"),
                                   subtree: command.input("subtree"), evidence: try context.registry.evidence(command.args["evidence"] ?? .null),
                                   in: context)
    default:
      throw Refusal(.invalid)
    }
  }

  // §4 a subtree under a step: its `tree` record with its place, its meta and genesis kinds, and the step's `branch`. A step
  // that already owns a subtree answers it. A step deleted elsewhere is revived, as any change to a step is.
  func createSubtree(_ place: RoadmapPlace, root: String, subtree: String, in context: RuleContext) throws -> CommandOutcome {
    let holder = ScopeKey(.tree(place.tree))
    let node = context.storedRow(RecordKey("node", RecordID(place.step)), in: holder)
    if let owned = Roadmaps(context.storedRows("tree", in: context.scope)).owned(by: place).first {
      var into: [ScopeKey: [PlannedDelta]] = [:]
      if let node, !Self.isPresent(node) {
        var revived: JSON.Object = ["t": "node", "id": .string(place.step), "life": ["alive", .null]]
        revived["born"] = node["born"]
        into[holder] = [try Self.delta(.object(revived), in: holder, from: .command, context: context)]
      }
      let key = RecordKey("tree", RecordID(owned))
      let born: Stamp? = context.state.rows[context.scope]?[key]?.lattice.born
      let claim = WriteClaim(key: key, from: owned.isSameID(as: subtree) ? nil : RecordID(subtree), born: born.map(WriteClaim.Born.stored))
      return CommandOutcome(write: [claim], product: context.product, into: into)
    }
    guard let node else { throw Refusal(.unknownRecord) }
    let pointer = context.storedRow(RecordKey("pointer", RecordID(place.step)), in: context.overlay(of: place.tree))
    if Self.isPresent(pointer) && Self.value(pointer, "opens") != nil { throw Refusal("step-opens-a-tree") }
    if depth(under: place.tree, in: context) > Self.maxDepth { throw Refusal("depth-limit") }
    return try plant(place, root: root, subtree: subtree, node: node, in: context)
  }

  // The depth a subtree of `tree` takes: one below `tree`'s, unset reading 0.
  func depth(under tree: String, in context: RuleContext) -> Int64 {
    let meta = context.storedRow(RecordKey("meta", "meta"), in: ScopeKey(.tree(tree)))
    return ((try? Self.value(meta, "depth")?.asInteger()) ?? 0) + 1
  }

  // createSubtree's steps 5 and 6: the subtree's record, its meta and genesis kinds, and the step's `branch`.
  func plant(_ place: RoadmapPlace, root: String, subtree: String, node: JSON?, in context: RuleContext) throws -> CommandOutcome {
    let holder = ScopeKey(.tree(place.tree))
    let holderMeta = context.storedRow(RecordKey("meta", "meta"), in: holder)
    let holderRoot: String = (try? Self.value(holderMeta, "root")?.asString()) ?? place.tree
    guard root.isSameID(as: holderRoot) else { throw Refusal(.invalid) }
    guard case .none = context.idState(of: RecordKey("tree", RecordID(subtree))) else { throw Refusal(.idTaken) }
    let planted = ScopeKey(.tree(subtree))
    let meta: JSON = ["t": "meta", "id": "meta", "f": [
      "root": [.string(root), .null], "parent": [place.json, .null], "depth": [JSON(depth(under: place.tree, in: context)), .null],
      "reach": [Self.value(holderMeta, "reach") ?? "private", .null],
    ]]
    let kinds: [JSON] = Self.genesisKinds.map { (kind: (id: String, values: JSON.Object)) -> JSON in
      let fields = JSON.Object(uniqueKeysWithValues: kind.values.members.map { (member: (key: String, value: JSON)) -> (String, JSON) in
        (member.key, [member.value, .null])
      })
      return ["t": "kind", "id": .string(kind.id), "born": .null, "life": ["alive", .null], "f": .object(fields)]
    }
    var branch: JSON.Object = ["t": "node", "id": .string(place.step), "f": ["branch": [.string(subtree), .null]]]
    branch["born"] = node?["born"]
    if !Self.isPresent(node) { branch["life"] = ["alive", .null] }
    let record: JSON = ["t": "tree", "id": .string(subtree), "born": .null, "life": ["alive", .null], "f": ["parent": [place.json, .null]]]
    let seeded: [PlannedDelta] = try ([meta] + kinds).map { (delta: JSON) throws -> PlannedDelta in
      try Self.delta(delta, in: planted, from: .command, context: context)
    }
    return CommandOutcome(
      deltas: [try Self.delta(record, in: context.scope, from: .command, context: context)],
      write: [WriteClaim(key: RecordKey("tree", RecordID(subtree)), born: .minted, fields: ["parent"])], product: context.product,
      into: [holder: [try Self.delta(.object(branch), in: holder, from: .command, context: context)], planted: seeded])
  }

  // §4 a kind's hue and the colour of every step that wears it, present or not. A kind deleted elsewhere is revived; no
  // step is.
  func recolourKind(_ kind: String, hue: JSON, in context: RuleContext) throws -> CommandOutcome {
    guard let record = context.storedRow(RecordKey("kind", RecordID(kind)), in: context.scope) else { throw Refusal(.unknownRecord) }
    let before = Self.value(record, "hue") ?? "terracotta"
    if before == hue { return CommandOutcome(product: context.product) }
    let wearers = context.storedRows("node", in: context.scope).filter { (Self.value($0, "color") ?? "terracotta") == before }
      .sorted { Self.precedes(Self.id(of: $0), Self.id(of: $1)) }
    var recoloured: JSON.Object = ["t": "kind", "id": .string(kind), "f": ["hue": [hue, .null]]]
    recoloured["born"] = record["born"]
    if !Self.isPresent(record) { recoloured["life"] = ["alive", .null] }
    let deltas: [JSON] = [.object(recoloured)] + wearers.map { Self.written($0, ["color": [hue, .null]]) }
    return CommandOutcome(deltas: try deltas.map { (delta: JSON) throws -> PlannedDelta in
      try Self.delta(delta, in: context.scope, from: .command, context: context)
    }, product: context.product)
  }

  // A product inverse's evidence against the declared scopes as stored: a row of a scope not declared or not alive reads
  // absent, so evidence there no longer holds.
  func skip(by evidence: Evidence, in context: RuleContext) throws -> String? {
    try context.skip(by: evidence) { (key: RecordKey, scope: ScopeKey) -> Row? in
      guard context.declared.contains(scope), context.state.scopes[scope]?.isAlive == true else { return nil }
      return context.state.rows[scope]?[key]
    }
  }

  // K-3: Undo of creating a roadmap. While its record, its tree scope and its owner's overlay of it are as the creation left
  // them, the roadmap dies as any root dies (§4's consequences).
  func undoCreateRoadmap(_ tree: String, evidence: Evidence, in context: RuleContext) throws -> CommandOutcome {
    let record = RecordAddress(scope: .product("roadmap"), key: RecordKey("tree", RecordID(tree)))
    guard evidence.unchangedCreatedRecords.contains(where: { $0.record == record }),
          evidence.unchangedCreatedScopes.contains(where: { $0.scope == .tree(tree) }) else { throw Refusal(.invalid) }
    if let code = try skip(by: evidence, in: context) { return Self.skipped(code, in: context) }
    let stored = context.storedRow(record.key, in: context.scope)
    if Self.value(stored, "parent") != nil { throw Refusal("not-a-root") }
    if (context.state.scopes[context.overlay(of: tree)]?.seq ?? 0) > 0 { return Self.skipped("scope-changed", in: context) }
    return CommandOutcome(deltas: [try Self.delta(Self.killed(stored), in: context.scope, from: .command, context: context)],
                          detail: InverseOutcome.detail([InverseOutcome(index: 0)]), product: context.product)
  }

  // R-8 Undo of creating a subtree: while the step's `branch` is the act's, and the subtree's record, its tree scope and its
  // owner's overlay are as the creation left them, the subtree dies and the step's `branch` clears, together.
  func undoCreateSubtree(_ place: RoadmapPlace, subtree: String, evidence: Evidence, in context: RuleContext) throws -> CommandOutcome {
    let record = RecordAddress(scope: .product("roadmap"), key: RecordKey("tree", RecordID(subtree)))
    guard evidence.ownedFields.contains(where: { $0.target == place.branch }),
          evidence.unchangedCreatedRecords.contains(where: { $0.record == record }),
          evidence.unchangedCreatedScopes.contains(where: { $0.scope == .tree(subtree) }) else { throw Refusal(.invalid) }
    if let code = try skip(by: evidence, in: context) { return Self.skipped(code, in: context) }
    let stored = context.storedRow(record.key, in: context.scope)
    guard Self.value(stored, "parent") == place.json else { throw Refusal(.invalid) }
    if (context.state.scopes[context.overlay(of: subtree)]?.seq ?? 0) > 0 { return Self.skipped("scope-changed", in: context) }
    let holder = ScopeKey(.tree(place.tree))
    let step = context.storedRow(RecordKey("node", RecordID(place.step)), in: holder)
    let cleared = Self.written(step, ["branch": [.null, .null]])
    return CommandOutcome(deltas: [try Self.delta(Self.killed(stored), in: context.scope, from: .command, context: context)],
                          detail: InverseOutcome.detail([InverseOutcome(index: 0)]), product: context.product,
                          into: [holder: [try Self.delta(cleared, in: holder, from: .command, context: context)]])
  }

  // R-8 Redo: while the step's `branch` is still the one the Undo wrote, a new subtree under a fresh id, planted as
  // createSubtree plants it; otherwise nothing.
  func redoCreateSubtree(_ place: RoadmapPlace, root: String, subtree: String, evidence: Evidence, in context: RuleContext) throws -> CommandOutcome {
    guard evidence.ownedFields.contains(where: { $0.target == place.branch }) else { throw Refusal(.invalid) }
    if let code = try skip(by: evidence, in: context) { return Self.skipped(code, in: context) }
    let node = context.storedRow(RecordKey("node", RecordID(place.step)), in: ScopeKey(.tree(place.tree)))
    var planted = try plant(place, root: root, subtree: subtree, node: node, in: context)
    planted.detail = InverseOutcome.detail([InverseOutcome(index: 0)])
    return planted
  }

  // MARK: Checks

  // §6.1 step 10 on the joined records: each type's rule, then §5's revival, then §4's consequences.
  public func effects(_ changes: [RecordChange], in context: inout RuleContext) throws -> Effects {
    var outcome = RoadmapOutcome(context, changes)
    for change in changes { try rule(change, in: context, outcome: &outcome) }
    revive(in: context, outcome: &outcome)
    if context.originScope == context.roadmapScope { endBranches(changes, in: context, outcome: &outcome) }
    settleVisibility(changes, in: context, outcome: &outcome)
    settleReach(changes, in: context, outcome: &outcome)
    var effects = Effects()
    for (scope, deltas) in outcome.byScope {
      effects.byScope[scope] = try deltas.map { (delta: JSON) throws -> PlannedDelta in
        try Self.delta(delta, in: scope, from: .check, context: context)
      }
    }
    return effects
  }

  // One rule a type, on a joined record of this intent.
  func rule(_ change: RecordChange, in context: RuleContext, outcome: inout RoadmapOutcome) throws(Refusal) {
    let original = change.before.row?.json
    let after = change.after.json
    switch change.key.type {
    case "tree":
      // Only a root is deleted by a person: a subtree goes with the step that owns it.
      guard context.origin.isReplica, Self.died(original, after), Self.value(original, "parent") != nil else { return }
      if context.deltas.contains(where: { $0.key == change.key && $0.life?.state == .dead }) { throw Refusal("not-a-root") }
    case "meta":
      // Only a root has a visibility; the owner's guide replaces one a fork inherited, unless the same intent says it is
      // inherited.
      let visible = change.scope == context.originScope && context.deltas.contains { $0.key.type == "meta" && $0.fields["visibility"] != nil }
      if visible, case .tree(let tree) = change.scope.kind,
         Self.value(context.storedRow(RecordKey("tree", RecordID(tree)), in: context.roadmapScope), "parent") != nil {
        throw Refusal("not-a-root")
      }
      guard original?["f"]?["guide"] != after["f"]?["guide"], Self.value(after, "guideInherited") == .bool(true),
            !context.deltas.contains(where: { $0.key.type == "meta" && $0.fields["guideInherited"] != nil }) else { return }
      outcome.append(["t": "meta", "id": "meta", "f": ["guideInherited": [false, .null]]], in: change.scope)
    case let type where Self.ownerOnly.contains(type):
      // R-3: a pointer and the workspace are admitted only in the overlay of the roadmap's owner.
      let overlay = context.state.scopes[change.scope]
      let governing = overlay?.governedBy.flatMap { (text: String) -> ScopeKey? in try? ScopeKey(parsing: text) }.flatMap { context.state.scopes[$0] }
      guard let overlay, let governing, governing.owner.isSameID(as: overlay.owner) else { throw Refusal(.forbidden) }
    case "coachThread":
      // Coach's conversation (Roadmap Coach §9): its death kills its messages, with their write fates, and its proposals.
      guard Self.died(original, after) else { return }
      for message in outcome.rows("coachMessage", in: change.scope) where Self.value(message, "threadId") == change.key.id.json {
        outcome.kill(message, in: change.scope)
        outcome.endFates(of: message["id"] ?? .null, in: change.scope)
      }
      for proposal in outcome.rows("coachProposal", in: change.scope) where Self.value(proposal, "threadId") == change.key.id.json {
        outcome.kill(proposal, in: change.scope)
      }
    case "coachMessage":
      // A message's death kills its write fates; once its writer has ended the turn, its state, text, calls and receipts
      // are final.
      if Self.died(original, after) { return outcome.endFates(of: change.key.id.json, in: change.scope) }
      let ended = Self.isPresent(original) && Self.value(original, "state").map(Self.writerTerminal.contains) == true
      let writes: [String] = context.deltas.filter { $0.key == change.key }.flatMap { Array($0.fields.keys) }
      if ended && writes.contains(where: Self.finalRegisters.contains) { throw Refusal("turn-final") }
    default:
      return
    }
  }

  // §5: a change to a step or a kind carries its life as alive; one that is still dead once it has joined, the delete being
  // newer, the server revives.
  func revive(in context: RuleContext, outcome: inout RoadmapOutcome) {
    for delta in context.deltas where Self.revivedByAChange.contains(delta.key.type) && delta.life?.state == .alive {
      let row = outcome.row(delta.key, in: context.originScope)
      if Self.isPresent(row) { continue }
      var revived: JSON.Object = ["t": .string(delta.key.type), "id": delta.key.id.json, "life": ["alive", .null]]
      revived["born"] = row?["born"]
      outcome.append(.object(revived), in: context.originScope)
    }
  }

  // §4: a roadmap's death kills every subtree under it, and a root's deletes each step of the owner's other roadmaps whose
  // pointer opens it.
  func endBranches(_ changes: [RecordChange], in context: RuleContext, outcome: inout RoadmapOutcome) {
    let account = context.roadmapScope
    let roadmaps = Roadmaps(outcome.rows("tree", in: account))
    let deaths = changes.filter { $0.scope == account && $0.key.type == "tree" && Self.died($0.before.row?.json, $0.after.json) }
    for death in deaths {
      for id in roadmaps.under(Self.name(of: death.key)) {
        if let row = roadmaps.rows[id] { outcome.kill(row, in: account) }
      }
    }
    let roots = deaths.filter { Self.value($0.before.row?.json, "parent") == nil }.map { Self.name(of: $0.key) }
    guard !roots.isEmpty else { return }
    let standing = outcome.rows("tree", in: account).filter(Self.isPresent).map(Self.id).sorted(by: Self.precedes)
    for tree in standing {
      let overlay = context.overlay(of: tree)
      guard context.declared.contains(overlay) else { continue }
      let opening = context.storedRows("pointer", in: overlay).filter { Self.isPresent($0) && Self.opens($0, oneOf: roots) }
        .sorted { Self.precedes(Self.id(of: $0), Self.id(of: $1)) }
      let holder = ScopeKey(.tree(tree))
      for pointer in opening {
        if let node = outcome.row(RecordKey("node", RecordID(Self.id(of: pointer))), in: holder) { outcome.kill(node, in: holder) }
      }
    }
  }

  // §4: a root's reach is its visibility, so a change of the visibility, by the owner's write or an Undo's restore, writes
  // the root's reach and the reach of every subtree under it, standing ones taking the visibility.
  func settleVisibility(_ changes: [RecordChange], in context: RuleContext, outcome: inout RoadmapOutcome) {
    guard case .tree(let tree) = context.originScope.kind,
          let record = changes.first(where: { $0.scope == context.originScope && $0.key.type == "meta" }) else { return }
    let visibility = Self.value(record.after.json, "visibility") ?? "private"
    guard visibility != (Self.value(record.before.row?.json, "visibility") ?? "private") else { return }
    if (Self.value(record.after.json, "reach") ?? "private") != visibility { outcome.append(Self.metaReach(visibility), in: record.scope) }
    let roadmaps = Roadmaps(outcome.rows("tree", in: context.roadmapScope))
    for (id, reach) in reaches(roadmaps.under(tree), of: roadmaps, in: outcome) { outcome.append(Self.metaReach(reach), in: ScopeKey(.tree(id))) }
  }

  // §4: a step's death that ends a subtree's standing writes `reach` private on every subtree under it, and its revival
  // writes the reach of the roadmap above back.
  func settleReach(_ changes: [RecordChange], in context: RuleContext, outcome: inout RoadmapOutcome) {
    let steps: [(scope: ScopeKey, key: RecordKey)] = changes.filter { $0.key.type == "node" }.map { ($0.scope, $0.key) }
      + outcome.appended.filter { $0.key.type == "node" }
    let flipped = steps.filter { Self.isPresent(context.storedRow($0.key, in: $0.scope)) != Self.isPresent(outcome.row($0.key, in: $0.scope)) }
    guard !flipped.isEmpty else { return }
    let roadmaps = Roadmaps(outcome.rows("tree", in: context.roadmapScope))
    let subtrees: [String] = flipped.flatMap { (step: (scope: ScopeKey, key: RecordKey)) -> [String] in
      guard case .tree(let tree) = step.scope.kind else { return [] }
      return roadmaps.branch(of: RoadmapPlace(tree: tree, step: Self.name(of: step.key)))
    }
    for (id, reach) in reaches(subtrees, of: roadmaps, in: outcome) { outcome.append(Self.metaReach(reach), in: ScopeKey(.tree(id))) }
  }

  // §4 reach over the subtrees given, parents first: a subtree's is its parent's while it and the step that owns it are
  // present, and private otherwise. Answers the reach each subtree takes where it changes.
  func reaches(_ subtrees: [String], of roadmaps: Roadmaps, in outcome: RoadmapOutcome) -> [(tree: String, reach: JSON)] {
    let reachOf = { (tree: String) -> JSON in Self.value(outcome.row(RecordKey("meta", "meta"), in: ScopeKey(.tree(tree))), "reach") ?? "private" }
    var unique: [String] = []
    for id in subtrees where !unique.contains(id) { unique.append(id) }
    let ordered = unique.sorted { (a: String, b: String) -> Bool in
      let (depthA, depthB) = (roadmaps.depth(of: a), roadmaps.depth(of: b))
      return depthA != depthB ? depthA < depthB : Self.precedes(a, b)
    }
    var settled: [String: JSON] = [:]
    var changed: [(tree: String, reach: JSON)] = []
    for id in ordered {
      let reach: JSON
      if let place = roadmaps.place(of: id), roadmaps.isAlive(id),
         Self.isPresent(outcome.row(RecordKey("node", RecordID(place.step)), in: ScopeKey(.tree(place.tree)))) {
        reach = settled[place.tree] ?? reachOf(place.tree)
      } else {
        reach = "private"
      }
      settled[id] = reach
      if reach != reachOf(id) { changed.append((id, reach)) }
    }
    return changed
  }

  // MARK: Records in wire form

  // A field's value, nil while it is unset or null.
  static func value(_ row: JSON?, _ field: String) -> JSON? {
    guard case .array(let register)? = row?["f"]?[field], let value = register.first, !value.isNull else { return nil }
    return value
  }

  static func isPresent(_ row: JSON?) -> Bool {
    guard case .array(let life)? = row?["life"] else { return false }
    return life.first == "alive"
  }

  static func died(_ original: JSON?, _ after: JSON?) -> Bool { isPresent(original) && !isPresent(after) }

  static func id(of row: JSON) -> String { (try? row["id"]?.asString()) ?? "" }

  static func name(of key: RecordKey) -> String { (try? key.id.json.asString()) ?? "" }

  static func key(of row: JSON) -> RecordKey { RecordKey((try? row["t"]?.asString()) ?? "", RecordID(id(of: row))) }

  static func precedes(_ a: String, _ b: String) -> Bool { a.utf8.lexicographicallyPrecedes(b.utf8) }

  static func opens(_ pointer: JSON, oneOf roots: [String]) -> Bool {
    guard let opened = try? value(pointer, "opens")?.asString() else { return false }
    return roots.contains { $0.isSameID(as: opened) }
  }

  // A record written whatever its life: a dead one keeps its stored life, so the write revives nothing.
  static func written(_ record: JSON?, _ fields: JSON.Object) -> JSON {
    var object: JSON.Object = ["t": record?["t"] ?? .null, "id": record?["id"] ?? .null, "f": .object(fields)]
    object["born"] = record?["born"]
    if !isPresent(record) { object["life"] = record?["life"] }
    return .object(object)
  }

  static func killed(_ record: JSON?) -> JSON {
    var object: JSON.Object = ["t": record?["t"] ?? .null, "id": record?["id"] ?? .null, "life": ["dead", .null]]
    object["born"] = record?["born"]
    return .object(object)
  }

  static func metaReach(_ reach: JSON) -> JSON { ["t": "meta", "id": "meta", "f": ["reach": [reach, .null]]] }

  static func skipped(_ code: String, in context: RuleContext) -> CommandOutcome {
    CommandOutcome(detail: InverseOutcome.detail([InverseOutcome(index: 0, skipped: code)]), product: context.product)
  }

  // A delta of the rules in wire form as admission reads it in `scope`.
  static func delta(_ json: JSON, in scope: ScopeKey, from source: ChangeSource, context: RuleContext) throws(Refusal) -> PlannedDelta {
    try IntentShape.effect(json, in: scope, source: source, registry: context.registry)
  }
}

// A roadmap's place: the step of the roadmap that holds it. A root has none.
struct RoadmapPlace: Hashable {
  let tree: String
  let step: String

  init(tree: String, step: String) {
    self.tree = tree
    self.step = step
  }

  init?(_ json: JSON?) {
    guard let tree = try? json?["tree"]?.asString(), let step = try? json?["step"]?.asString() else { return nil }
    self.init(tree: tree, step: step)
  }

  var json: JSON { ["tree": .string(tree), "step": .string(step)] }

  // The step's `branch` register, which a subtree command's evidence owns.
  var branch: Target { Target(RecordAddress(scope: .tree(tree), key: RecordKey("node", RecordID(step))), .field("branch")) }
}

// The owner's roadmaps as their `tree` records hold them: where a subtree sits, which subtrees a step owns, and what lies
// under a roadmap.
struct Roadmaps {
  let rows: [String: JSON]

  init(_ rows: [JSON]) {
    var byId: [String: JSON] = [:]
    for row in rows { byId[RoadmapServerRules.id(of: row)] = row }
    self.rows = byId
  }

  var ids: [String] { Array(rows.keys) }

  func place(of id: String) -> RoadmapPlace? { RoadmapPlace(RoadmapServerRules.value(rows[id], "parent")) }

  func isAlive(_ id: String) -> Bool { RoadmapServerRules.isPresent(rows[id]) }

  // The alive subtrees a step owns, the least id first.
  func owned(by place: RoadmapPlace) -> [String] {
    rows.filter { RoadmapServerRules.isPresent($0.value) && RoadmapServerRules.value($0.value, "parent") == place.json }
      .map(\.key).sorted(by: RoadmapServerRules.precedes)
  }

  // Every alive subtree under `tree`, each after the roadmap that holds its step.
  func under(_ tree: String) -> [String] {
    var found: [String] = []
    var holders: [String] = [tree]
    while !holders.isEmpty {
      let holder = holders.removeFirst()
      let children = rows.filter { (id: String, row: JSON) -> Bool in
        RoadmapServerRules.isPresent(row) && RoadmapServerRules.value(row, "parent")?["tree"] == .string(holder)
          && !id.isSameID(as: tree) && !found.contains(id)
      }.map(\.key).sorted(by: RoadmapServerRules.precedes)
      for id in children {
        found.append(id)
        holders.append(id)
      }
    }
    return found
  }

  // The subtrees a step owns and every subtree under them: the branch its presence decides.
  func branch(of place: RoadmapPlace) -> [String] {
    owned(by: place).flatMap { [$0] + under($0) }
  }

  func depth(of id: String) -> Int64 {
    var depth: Int64 = 0
    var place = place(of: id)
    while let current = place, depth <= RoadmapServerRules.maxDepth + 1 {
      depth += 1
      place = self.place(of: current.tree)
    }
    return depth
  }
}

// The rows of the declared scopes as this intent leaves them: stored, then joined, then what the rules append, each delta
// they append by scope in order.
struct RoadmapOutcome {
  let context: RuleContext
  var joined: [ScopeKey: [RecordKey: JSON]] = [:]
  var byScope: [ScopeKey: [JSON]] = [:]
  var appended: [(scope: ScopeKey, key: RecordKey)] = []

  init(_ context: RuleContext, _ changes: [RecordChange]) {
    self.context = context
    for change in changes { joined[change.scope, default: [:]][change.key] = change.after.json }
  }

  func row(_ key: RecordKey, in scope: ScopeKey) -> JSON? {
    joined[scope]?[key] ?? context.storedRow(key, in: scope)
  }

  func rows(_ type: String, in scope: ScopeKey) -> [JSON] {
    var rows: [RecordKey: JSON] = [:]
    for (key, row) in context.state.rows[scope] ?? [:] where key.type.isSameID(as: type) { rows[key] = row.json }
    for (key, row) in joined[scope] ?? [:] where key.type.isSameID(as: type) { rows[key] = row }
    return rows.sorted { $0.key < $1.key }.map(\.value)
  }

  mutating func append(_ delta: JSON, in scope: ScopeKey) {
    let key = RoadmapServerRules.key(of: delta)
    byScope[scope, default: []].append(delta)
    appended.append((scope, key))
    var row: JSON.Object = (try? (row(key, in: scope) ?? ["t": delta["t"] ?? .null, "id": delta["id"] ?? .null]).asObject()) ?? [:]
    if let life = delta["life"] { row["life"] = life }
    if case .object(let fields)? = delta["f"] {
      var merged: JSON.Object = (try? row["f"]?.asObject()) ?? [:]
      for (name, register) in fields.members { merged[name] = register }
      row["f"] = .object(merged)
    }
    joined[scope, default: [:]][key] = .object(row)
  }

  mutating func kill(_ row: JSON, in scope: ScopeKey) {
    guard RoadmapServerRules.isPresent(self.row(RoadmapServerRules.key(of: row), in: scope)) else { return }
    append(RoadmapServerRules.killed(row), in: scope)
  }

  // A message's death kills its write fates.
  mutating func endFates(of message: JSON, in scope: ScopeKey) {
    for fate in rows("coachWriteFate", in: scope) where RoadmapServerRules.value(fate, "messageId") == message { kill(fate, in: scope) }
  }
}

extension RuleContext {
  // The owner's `self/roadmap`.
  fileprivate var roadmapScope: ScopeKey { ScopeKey(.product(account: account, name: "roadmap")) }

  fileprivate func overlay(of tree: String) -> ScopeKey { ScopeKey(.overlay(account: account, tree: tree)) }

  // A scope's stored rows of a type in wire form, in record order, declared or not: discovery reads them to declare.
  fileprivate func storedRows(_ type: String, in scope: ScopeKey) -> [JSON] {
    (state.rows[scope] ?? [:]).filter { $0.key.type.isSameID(as: type) }.sorted { $0.key < $1.key }.map(\.value.json)
  }

  fileprivate func storedRow(_ key: RecordKey, in scope: ScopeKey) -> JSON? {
    state.rows[scope]?[key]?.json
  }
}
