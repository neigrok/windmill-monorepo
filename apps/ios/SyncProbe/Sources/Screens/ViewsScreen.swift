import SwiftUI
import SyncAPI
import SyncCore
import SyncEngine

struct ViewsScreen: View {
  let probe: Probe
  @State private var type = "card"

  var body: some View {
    NavigationStack {
      VStack {
        Picker("Type", selection: $type) {
          ForEach(productTypes, id: \.self) { Text(verbatim: $0) }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        SideBySide(
          drawn: probe.engine.records(.product("probe"), type, .drawn),
          stored: probe.engine.records(.product("probe"), type, .stored))
          .id(type)
      }
      .navigationTitle("Views")
    }
  }

  var productTypes: [String] {
    probe.registry.types.map(\.name).filter { probe.registry.lives($0, in: .product("probe")) }
  }
}

private struct SideBySide: View {
  @State var drawn: RecordsView
  @State var stored: RecordsView

  var body: some View {
    List {
      Section {
        LabeledContent("drawn", value: "\(drawn.records.count) visible")
        LabeledContent("stored", value: "\(stored.records.count) visible")
        LabeledContent("first pull complete", value: String(drawn.firstPullComplete))
      }
      ForEach(Set(drawn.records.keys).union(stored.records.keys).sorted(), id: \.self) { id in
        VStack(alignment: .leading, spacing: 4) {
          Text(verbatim: id.description).font(.headline)
          HStack(alignment: .top) {
            RecordColumn(mode: "drawn", record: drawn.records[id])
            RecordColumn(mode: "stored", record: stored.records[id])
          }
        }
      }
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
