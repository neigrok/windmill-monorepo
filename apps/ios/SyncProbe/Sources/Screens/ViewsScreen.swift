import SwiftUI
import SyncAPI
import SyncCore
import SyncEngine

// The drawn and stored views of one type side by side, every record or, for a type with a top-level ref field, only
// those naming one record of the type it refers to (ER-12).
struct ViewsScreen: View {
  static let scope = ScopeRef.product("probe")

  let probe: Probe
  @State private var type = "card"
  @State private var target: RecordID?

  var body: some View {
    NavigationStack {
      VStack {
        Picker("Type", selection: $type) {
          ForEach(productTypes, id: \.self) { Text(verbatim: $0) }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        if let ref, let targets = try? probe.engine.records(Self.scope, ref.target) {
          TargetPicker(field: ref.name, targets: targets, target: $target).id(ref.target)
        }
        if let views {
          SideBySide(drawn: views.drawn, stored: views.stored).id("\(type) \(target?.text ?? "every record")")
        } else {
          Text(verbatim: "No view of \(type) by \(ref?.name ?? "")").frame(maxHeight: .infinity)
        }
      }
      .navigationTitle("Views")
      .onChange(of: type) { target = nil }
    }
  }

  var productTypes: [String] {
    probe.registry.types.map(\.name).filter { probe.registry.lives($0, in: Self.scope) }
  }

  // The chosen type's first top-level ref field, and the type it refers to.
  var ref: (name: String, target: String)? {
    probe.registry.type(type)?.fields.lazy.compactMap { field in field.ref.map { (field.name, $0) } }.first
  }

  // The views of the chosen type, narrowed to the chosen target; nil when the engine refuses the list.
  var views: (drawn: RecordsView, stored: RecordsView)? {
    guard let ref, let target else {
      return try? (probe.engine.records(Self.scope, type, .drawn), probe.engine.records(Self.scope, type, .stored))
    }
    return try? (probe.engine.records(Self.scope, type, where: ref.name, is: target, .drawn),
                 probe.engine.records(Self.scope, type, where: ref.name, is: target, .stored))
  }
}

private struct TargetPicker: View {
  let field: String
  @State var targets: RecordsView
  @Binding var target: RecordID?

  var body: some View {
    Picker(field, selection: $target) {
      Text("every record").tag(RecordID?.none)
      if case .loaded(let snapshot) = targets.state {
        ForEach(snapshot.records, id: \.id) { Text(verbatim: $0.id.description).tag(Optional($0.id)) }
      }
    }
    .padding(.horizontal)
  }
}

private struct SideBySide: View {
  @State var drawn: RecordsView
  @State var stored: RecordsView

  var body: some View {
    switch (drawn.state, stored.state) {
    case (.loaded(let drawnList), .loaded(let storedList)):
      List {
        Section {
          LabeledContent("drawn", value: "\(drawnList.records.count) visible")
          LabeledContent("stored", value: "\(storedList.records.count) visible")
          LabeledContent("first pull complete", value: String(drawnList.firstPullComplete))
        }
        ForEach(Set(drawnList.records.map(\.id)).union(storedList.records.map(\.id)).sorted(), id: \.self) { id in
          VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: id.description).font(.headline)
            HStack(alignment: .top) {
              RecordColumn(mode: "drawn", record: drawnList.record(id))
              RecordColumn(mode: "stored", record: storedList.record(id))
            }
          }
        }
      }
    default:
      ProgressView("Loading")
        .frame(maxHeight: .infinity)
    }
  }
}

private struct RecordColumn: View {
  let mode: String
  let record: Record?

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: mode).bold()
      Text(verbatim: record.map(\.summary) ?? "absent")
    }
    .font(.caption)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

extension Record {
  fileprivate var summary: String {
    let textLines = texts.sorted { $0.key < $1.key }.map { field, text in
      "\(field) \(JSON.string(text.text).jcsText)\(text.merged ? " merged" : "")\(text.pending ? " pending" : "")"
    }
    let flags = [isPending ? "pending" : nil, isHeld ? "held" : nil].compactMap { $0 }
    return ([
      "life \(life.map { "\($0.state.rawValue) \($0.stamp)" } ?? "none")",
      "born \(born?.text ?? "none")",
      "values \(JSON.object(JSON.Object(uniqueKeysWithValues: values.map { ($0.key, $0.value) })).jcsText)",
      "serials \(JSON.object(JSON.Object(uniqueKeysWithValues: serials.map { ($0.key, $0.value) })).jcsText)",
      "rc \(rc.map { "\($0)" } ?? "none") · ru \(ru.map { "\($0)" } ?? "none")",
    ] + textLines + flags).joined(separator: "\n")
  }
}
