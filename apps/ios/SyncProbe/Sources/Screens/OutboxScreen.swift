import SwiftUI
import SyncReplica

struct OutboxScreen: View {
  let probe: Probe

  var body: some View {
    NavigationStack {
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        switch Result(catching: { try probe.snapshot() }) {
        case .success(let device): OutboxList(device: device, deviceNow: probe.clock.nowMs())
        case .failure(let error): Text(verbatim: "The store could not be read: \(error)")
        }
      }
      .navigationTitle("Outbox")
    }
  }
}

private struct OutboxList: View {
  let device: LoadedDevice
  let deviceNow: Int64

  var body: some View {
    List {
      ForEach(device.replicas, id: \.id) { replica in
        Section("\(replica.id) · \(replica.meta.state.rawValue)") {
          if replica.outbox.isEmpty { Text("No entries") }
          ForEach(replica.outbox, id: \.localId) { entry in
            EntryRow(entry: entry, deviceNow: deviceNow)
          }
        }
      }
    }
  }
}

private struct EntryRow: View {
  let entry: OutboxEntry
  let deviceNow: Int64

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: "\(entry.state.rawValue) · n \(entry.n.map { "\($0)" } ?? "none")").font(.headline)
      Text(verbatim: entry.localId)
      Text(verbatim: "lineage \(entry.lineage) · scope \(entry.scope.text)")
      Text(verbatim: "stamp \(entry.stamp.text)")
      Text(verbatim: "holds \(holds)")
      if entry.state == .held {
        Text(verbatim: "releases in \((Double(max(0, entry.releaseAt - deviceNow)) / 1000).formatted(.number.precision(.fractionLength(1)))) s")
      }
    }
    .font(.footnote)
  }

  var holds: String {
    let command = entry.intent.command.map { ["command \($0.name)"] } ?? []
    return (command + entry.intent.deltas.map(\.key.description)).joined(separator: ", ")
  }
}
