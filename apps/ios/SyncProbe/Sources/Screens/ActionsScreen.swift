import SwiftUI
import SyncAPI
import SyncCore
import SyncEngine

struct ActionsScreen: View {
  let probe: Probe
  @State private var hold = false
  @State private var lastAction = "No action yet"

  var body: some View {
    NavigationStack {
      List {
        Section("Last action") { Text(verbatim: lastAction).font(.footnote) }
        Section("Undo") {
          if probe.engine.undoOffers.offers.isEmpty { Text("Nothing held") }
          ForEach(probe.engine.undoOffers.offers) { offer in
            TimelineView(.periodic(from: .now, by: 0.1)) { _ in
              HStack {
                Text(verbatim: "\(offer.id)\nreleases in \(secondsUntil(offer.releaseAt))").font(.footnote)
                Spacer()
                Button("Undo") { perform("Undo \(offer.id)") { try probe.engine.undo(offer.id) ? "undone" : "an entry was already released" } }
                  .buttonStyle(.borderless)
              }
            }
          }
        }
        Section { Toggle("Hold each gesture for Undo", isOn: $hold) }
        ForEach(Preset.sections, id: \.title) { section in
          Section(section.title) {
            ForEach(section.presets, id: \.title) { preset in
              Button(preset.title) { perform(preset.title) { try commit(in: .product("probe"), preset.decide) } }
            }
          }
        }
        Section("The first board's tree") {
          Button("Follow its tree and overlay") { perform("Follow") { try follow(firstBoardTree()) } }
          Button("Create a tag, derived id") {
            perform("Create a tag") {
              try commit(in: .tree(firstBoardTree())) { tx in
                SyncAPI.Gesture(changes: [.create("tag", id: .derived(label: "tag \(tx.now % 1_000)"), ["label": .string("Tag \(tx.now % 1_000)")])])
              }
            }
          }
          Button("Edit the first tag's memo, text") {
            perform("Edit a memo") {
              let tree = try firstBoardTree()
              let tag = try firstTag(in: tree)
              return try commit(in: .overlay(tree)) { tx in
                SyncAPI.Gesture(changes: [.write("mark", tag, texts: ["memo": TextEdit(text: "memo \(tx.now % 10_000)")])])
              }
            }
          }
        }
      }
      .navigationTitle("Actions")
    }
  }

  func perform(_ title: String, _ action: () throws -> String) {
    do {
      lastAction = "\(title): \(try action())"
    } catch {
      lastAction = "\(title) failed: \(error)"
    }
  }

  func commit(in scope: ScopeRef, _ decide: (any CommitContext) throws -> SyncAPI.Gesture) throws -> String {
    let (outcome, _) = try probe.engine.commit(scope) { tx in
      var gesture = try decide(tx)
      gesture.hold = hold
      return (gesture, ())
    }
    return outcome?.summary ?? "nothing committed"
  }

  func follow(_ tree: String) throws -> String {
    let followed = try [ScopeRef.tree(tree), .overlay(tree)].map { scope in "\(scope.text) \(try probe.engine.subscribe(scope).rawValue)" }
    return followed.joined(separator: ", ")
  }

  func firstBoardTree() throws -> String {
    let boards = try probe.engine.read(.product("probe")) { try $0.drawn("board") }.map(\.id).sorted()
    guard let tree = boards.first?.string else { throw ProbeError("no board is drawn") }
    return tree
  }

  func firstTag(in tree: String) throws -> RecordID {
    guard let tag = try probe.engine.read(.tree(tree), { try $0.drawn("tag") }).map(\.id).sorted().first else {
      throw ProbeError("the tree of \(tree) holds no tag")
    }
    return tag
  }

  func secondsUntil(_ releaseAt: Int64) -> String {
    "\((Double(max(0, releaseAt - probe.clock.nowMs())) / 1000).formatted(.number.precision(.fractionLength(1)))) s"
  }
}

// One preset commit in self/probe: the gesture it decides from the views inside the commit's transaction.
private struct Preset {
  let title: String
  let decide: (any CommitContext) throws -> SyncAPI.Gesture

  init(_ title: String, decide: @escaping (any CommitContext) throws -> SyncAPI.Gesture) {
    self.title = title
    self.decide = decide
  }

  static let sections: [(title: String, presets: [Preset])] = [
    ("Cards", [
      Preset("Create a card at the bottom") { tx in
        SyncAPI.Gesture(changes: [
          .create("card", ["title": .string("Card \(tx.now % 10_000)"), "tier": "draft"],
                  anchor: OrderAnchor(field: "ord", below: try orderedCards(tx).last)),
        ])
      },
      Preset("Retitle the top card, guarded") { tx in
        let card = try topCard(tx)
        return SyncAPI.Gesture(changes: [.update("card", card, ["title": .string("Title \(tx.now % 10_000)")])],
                               guards: [RegisterRef(type: "card", id: card, field: "title")])
      },
      Preset("Move the bottom card to the top") { tx in
        SyncAPI.Gesture(changes: [.move("card", try orderedCards(tx).last ?? topCard(tx), to: OrderAnchor(field: "ord", below: nil))])
      },
      Preset("Delete the top card") { tx in
        SyncAPI.Gesture(changes: [.delete("card", try topCard(tx))])
      },
    ]),
    ("Runs and laps", [
      Preset("Start a run, probe.start") { tx in
        let run = try tx.mintID("run")
        let label = JSON.string("Run \(tx.now % 1_000)")
        return SyncAPI.Gesture(
          changes: [],
          command: Command(name: "probe.start", args: ["id": run.json, "label": label, "startedAt": JSON(tx.now), "join": true]),
          predict: [.create("run", id: .given(run), ["startedAt": JSON(tx.now), "label": label])])
      },
      Preset("End the open run, probe.end") { tx in
        let run = try openRun(tx)
        let endedAt = JSON(max((try? run.values["startedAt"]?.asInteger()) ?? 0, tx.now))
        return SyncAPI.Gesture(
          changes: [], command: Command(name: "probe.end", args: ["runId": run.id.json, "endedAt": endedAt]),
          predict: [.update("run", run.id, ["endedAt": endedAt])])
      },
      Preset("Add a lap to the open run") { tx in
        SyncAPI.Gesture(changes: [.create("lap", ["runId": try openRun(tx).id.json, "weight": 12.5])])
      },
      Preset("A card and a lap, atomic") { tx in
        SyncAPI.Gesture(changes: [
          .create("card", ["title": .string("Pair \(tx.now % 10_000)"), "tier": "draft"]),
          .create("lap", ["runId": try openRun(tx).id.json, "weight": 20]),
        ], atomic: true)
      },
    ]),
    ("Boards, days and the device", [
      Preset("Create a board") { _ in
        SyncAPI.Gesture(changes: [.create("board")])
      },
      Preset("Copy the first board, probe.copy") { tx in
        guard let source = try tx.drawn("board").map(\.id).sorted().first else { throw ProbeError("no board is drawn") }
        let copy = try tx.mintID("board")
        return SyncAPI.Gesture(
          changes: [], command: Command(name: "probe.copy", args: ["src": source.json, "dst": copy.json]),
          predict: [.create("board", id: .given(copy))])
      },
      Preset("Put today, scored, retiring a held removal") { tx in
        let today = day(tx.now)
        return SyncAPI.Gesture(changes: [.put("day", today, present: true, ["score": JSON(tx.now % 11)])],
                               retire: [RecordRef(type: "day", id: today)])
      },
      Preset("Remove today") { tx in
        SyncAPI.Gesture(changes: [.put("day", day(tx.now), present: false)])
      },
      Preset("Write the rack device row") { tx in
        SyncAPI.Gesture(changes: [], local: [DeviceWrite(key: "rack", value: ["at": JSON(tx.now)])])
      },
    ]),
  ]

  static func orderedCards(_ tx: any ScopeReader) throws -> [RecordID] {
    try tx.drawn("card")
      .compactMap { card in (try? card.values["ord"]?.asString()).flatMap { try? FractionalKey($0) }.map { (key: $0, id: card.id) } }
      .sorted { ($0.key, $0.id) < ($1.key, $1.id) }
      .map(\.id)
  }

  static func topCard(_ tx: any ScopeReader) throws -> RecordID {
    guard let card = try orderedCards(tx).first ?? tx.drawn("card").map(\.id).sorted().first else { throw ProbeError("no card is drawn") }
    return card
  }

  static func openRun(_ tx: any ScopeReader) throws -> Record {
    let open = try tx.drawn("run").filter { $0.values["endedAt"]?.isNull ?? true }
    guard let run = open.max(by: { ((try? $0.values["startedAt"]?.asInteger()) ?? 0) < ((try? $1.values["startedAt"]?.asInteger()) ?? 0) }) else {
      throw ProbeError("no open run is drawn")
    }
    return run
  }

  static func day(_ ms: Int64) -> RecordID {
    RecordID(Date(timeIntervalSince1970: Double(ms) / 1000).formatted(.iso8601.year().month().day()))
  }
}

extension CommitOutcome {
  fileprivate var summary: String {
    switch self {
    case .committed(let receipt):
      [
        "committed \(receipt.gestureId) at \(receipt.stamp)",
        "entries \(receipt.localIds.joined(separator: ", "))",
        "ids \(receipt.ids.map { $0?.description ?? "none" }.joined(separator: ", "))",
        "releaseAt \(receipt.releaseAt.map { "\($0)" } ?? "none")",
        "retired \(receipt.retired.joined(separator: ", "))",
      ].joined(separator: "\n")
    case .refused(let code, let detail, let notice):
      "refused \(code) · detail \(detail?.jcsText ?? "none") · notice \(notice ?? "none")"
    }
  }
}
