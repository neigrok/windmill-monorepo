import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore

// The corpus's JSON as the normalized records the reads take, and each read's result in the form the corpus states it.

extension JSON {
  // A member that is absent or null as nil, any other decoded.
  func optional<Value>(_ key: String, _ decode: (JSON) throws -> Value) rethrows -> Value? {
    guard let value = self[key], !value.isNull else { return nil }
    return try decode(value)
  }

  func optionalString(_ key: String) throws -> String? { try optional(key) { try $0.asString() } }
  func optionalBool(_ key: String) throws -> Bool? { try optional(key) { try $0.asBool() } }
  func optionalInstant(_ key: String) throws -> Instant? { try optional(key) { Instant(ms: try $0.asInteger()) } }
  func optionalStamp(_ key: String) throws -> Stamp? { try optional(key, Stamp.init(json:)) }

  static func strings(_ items: [String]) -> JSON { .array(items.map { .string($0) }) }
}

extension Step {
  init(form: JSON) throws {
    let links = try form.optional("links") { links in
      try links.asArray().map { Step.Link(url: try $0.member("url").asString(), label: try $0.member("label").asString()) }
    }
    self.init(id: try form.member("id").asString(), present: try form.optionalBool("present"), born: try form.optionalStamp("born"),
              rc: try form.optionalInstant("rc"), ru: try form.optionalInstant("ru"), label: try form.optionalString("label"),
              icon: try form.optionalString("icon"), color: try form.optionalString("color"), ord: try form.optionalString("ord"),
              status: try form.optionalString("status"), description: try form.optionalString("description"), links: links,
              branch: try form.optionalString("branch"), branchStamp: try form.optionalStamp("branchStamp"))
  }
}

extension Kind {
  init(form: JSON) throws {
    self.init(id: try form.member("id").asString(), present: try form.optionalBool("present"), born: try form.optionalStamp("born"),
              hue: try form.member("hue").asString(), label: try form.optionalString("label"),
              description: try form.optionalString("description"), ord: try form.optionalString("ord"))
  }
}

extension RoadmapTree {
  // An absent `meta` is a blank one, a null `meta` none; an absent `root` is the roadmap's own id.
  init(form: JSON) throws {
    let id = try form.member("id").asString()
    let meta: Metadata? = try (form["meta"] ?? [:]).nullable { meta in
      Metadata(title: try meta.optionalString("title"), guide: try meta.optionalString("guide"),
               guideInherited: try meta.optionalBool("guideInherited"), root: try meta.optionalString("root") ?? id,
               depth: try meta.optional("depth") { Int(try $0.asInteger()) }, visibility: try meta.optionalString("visibility"),
               reach: try meta.optionalString("reach"))
    }
    let read = try form.optional("read") { name in
      guard let read = Read(rawValue: try name.asString()) else { throw ContractError("no read state \(name)") }
      return read
    }
    let parent = try form.optional("parent") { Parent(tree: try $0.member("tree").asString(), step: try $0.member("step").asString()) }
    let edges = try (form["edges"]?.asArray() ?? []).map(Edge.init(form:))
    let marks = try (form["marks"]?.asArray() ?? []).map { mark in
      Mark(node: try mark.member("node").asString(), status: try mark.member("status").asString(),
           outOfOrder: try mark.member("outOfOrder").asBool(), recordedAt: try mark.optionalInstant("recordedAt"),
           deviceAt: try mark.optionalInstant("deviceAt"), stamp: try mark.optionalStamp("stamp"))
    }
    let pointers = try (form["pointers"]?.asArray() ?? []).map { pointer in
      Pointer(node: try pointer.member("node").asString(), present: try pointer.member("present").asBool(),
              opens: try pointer.member("opens").asString(), setAt: try pointer.optionalStamp("setAt"))
    }
    self.init(id: id, present: try form.optionalBool("present"), read: read, own: try form.optionalBool("own"),
              updatedAt: try form.optionalInstant("updatedAt"), parent: parent, meta: meta,
              nodes: try (form["nodes"]?.asArray() ?? []).map(Step.init(form:)), edges: edges,
              kinds: try (form["kinds"]?.asArray() ?? []).map(Kind.init(form:)), marks: marks, pointers: pointers)
  }
}

extension RoadmapTree.Edge {
  init(form: JSON) throws {
    self.init(from: try form.member("from").asString(), to: try form.member("to").asString(), present: try form.member("present").asBool())
  }

  var ends: JSON { [.string(from), .string(to)] }
}

extension FollowGraph {
  // `subjects` selects the steps read in detail; it never narrows the states.
  func form(subjects: [String]) -> JSON {
    let debt = owedIndex()
    let steps: [JSON] = subjects.map { id in
      let owed = debt.owed(id)
      return ["id": .string(id), "followed": .array(followed(id).map(\.form)), "unmet": .strings(unmet(id)), "owed": .strings(owed),
              "owedCount": JSON(owed.count), "unlocks": .strings(unlocks(id))]
    }
    let states: [JSON] = self.states.map { id, state in ["id": .string(id), "state": .string(state.rawValue)] }
    return ["presentIds": .strings(ids), "states": .array(states), "steps": .array(steps)]
  }
}

extension Followed {
  var form: JSON { ["id": .string(id), "incoming": .array(incoming.map(\.ends)), "throughAbsent": .bool(throughAbsent)] }
}

extension Counts {
  var form: JSON { ["done": JSON(done), "total": JSON(total)] }
}

extension RoadmapAccount {
  var form: JSON {
    let trees: [JSON] = self.trees.map { tree in
      let location = location(of: tree.id)
      return ["id": .string(tree.id), "standing": .string(location.standing.rawValue), "place": location.place?.form ?? .null,
              "title": .of(location.title), "read": .string(tree.read.rawValue), "counts": counts(tree.id)?.form ?? .null,
              "complete": .bool(isComplete(tree.id)), "openings": .array(openings(of: tree.id).map(\.form))]
    }
    return ["trees": .array(trees), "loops": .array(loops.map(JSON.strings))]
  }
}

extension Location.Place {
  var form: JSON {
    let steps: [JSON] = path.map { ["tree": .string($0.tree), "step": .string($0.step), "title": .of($0.title)] }
    let owner: JSON = parent.map { ["tree": .string($0.tree), "step": .string($0.step)] } ?? .null
    return ["root": .string(root), "parent": owner, "path": .array(steps), "depth": JSON(depth)]
  }
}

extension OpeningRead {
  var form: JSON {
    ["node": .string(opening.node), "kind": .string(opening.kind.rawValue), "tree": .string(opening.tree),
     "status": .string(opening.status.rawValue), "complete": .bool(complete), "counts": counts?.form ?? .null, "loop": .bool(loop)]
  }
}

extension Progress {
  var form: JSON {
    let dated: [JSON] = dates.map { ["node": .string($0.node), "at": .of($0.at)] }
    return ["completed": .strings(completed), "dates": .array(dated)]
  }
}

extension Guide {
  var form: JSON { ["tree": .string(tree), "title": .string(title), "text": .string(text), "own": .bool(own)] }
}

extension ListedRoadmap {
  var form: JSON { ["id": .string(id), "title": .of(title), "counts": counts?.form ?? .null, "updatedAt": .of(updatedAt)] }
}

extension LegendRead {
  var form: JSON {
    let owners: [JSON] = hues.map { ["hue": .string($0.name), "id": .string($0.owner)] }
    let collisions: [JSON] = hues.filter { !$0.others.isEmpty }.map {
      ["hue": .string($0.name), "owner": .string($0.owner), "others": .strings($0.others)]
    }
    return ["ids": .strings(kinds.map(\.id)), "owners": .array(owners), "collisions": .array(collisions)]
  }
}

extension NodeFilter {
  init(form: JSON) throws {
    self.init(query: try form.optionalString("query") ?? "", color: try form.optionalString("color"), kind: try form.optionalString("kind"))
  }
}

extension BoardQuery {
  init(form: JSON) throws {
    let sort = try form.optional("sort") { name in
      guard let sort = Sort(rawValue: try name.asString()) else { throw ContractError("no Board sort \(name)") }
      return sort
    }
    self.init(sort: sort ?? .roadmap, kinds: try form.optional("kinds") { try $0.asArray().map { try $0.asString() } } ?? [],
              search: try form.optionalString("search") ?? "", branch: try form.optionalString("branch"),
              doneExpanded: try form.optionalBool("doneExpanded") ?? false)
  }
}

extension BoardRead {
  var form: JSON {
    let columns: [JSON] = self.columns.map {
      ["name": .string($0.name.rawValue), "count": JSON($0.ids.count), "ids": .strings($0.ids), "shown": .strings($0.shown),
       "folded": .bool($0.folded)]
    }
    let cards: [JSON] = self.cards.map { card in
      let needs: JSON = card.needs.map { ["first": .string($0.first), "extra": JSON($0.extra), "toGo": JSON($0.toGo)] } ?? .null
      let unlocks: JSON = card.unlocks.map { ["first": .string($0.first), "extra": JSON($0.extra)] } ?? .null
      return ["id": .string(card.id), "column": .string(card.column.rawValue), "needs": needs, "unlocks": unlocks,
              "unlockCount": JSON(card.unlockCount)]
    }
    return ["overall": overall.form, "sort": .string(sort.rawValue), "branch": .of(branch), "recovery": .of(recovery?.rawValue),
            "columns": .array(columns), "cards": .array(cards)]
  }
}

extension LandingFact {
  var form: JSON { ["node": .string(node), "incoming": .array(incoming.map(\.ends)), "followed": .array(followed.map(\.form))] }
}
