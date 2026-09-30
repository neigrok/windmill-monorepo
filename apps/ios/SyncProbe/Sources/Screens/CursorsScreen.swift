import SwiftUI
import SyncCore
import SyncReplica

struct CursorsScreen: View {
  let probe: Probe

  var body: some View {
    NavigationStack {
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        switch Result(catching: { try probe.snapshot() }) {
        case .success(let device): CursorList(device: device)
        case .failure(let error): Text(verbatim: "The store could not be read: \(error)")
        }
      }
      .navigationTitle("Cursors")
    }
  }
}

private struct CursorList: View {
  let device: LoadedDevice

  var body: some View {
    List {
      ForEach(device.replicas, id: \.id) { replica in
        Section("\(replica.id) · \(replica.meta.state.rawValue)") {
          if replica.cursors.isEmpty { Text("No cursors") }
          ForEach(replica.cursors.sorted { $0.key < $1.key }, id: \.key) { scope, record in
            CursorRow(scope: scope, record: record, staging: replica.staging[scope])
          }
          ForEach(replica.known.sorted { $0.key < $1.key }, id: \.key) { scope, kind in
            LabeledContent("known \(scope.text)", value: kind.rawValue)
          }
        }
      }
    }
  }
}

private struct CursorRow: View {
  let scope: ScopeRef
  let record: CursorRecord
  let staging: Staging?

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: scope.text).font(.headline)
      Text(verbatim: "cursor \(decoded)")
      Text(verbatim: "digest \(record.digest.hex)")
      if let staging { Text(verbatim: "staging digest \(staging.digest.hex)") }
      Text(verbatim: "booted \(record.booted) · mismatchReset \(record.mismatchReset) · digestStop \(record.digestStop ?? "none")")
    }
    .font(.footnote)
  }

  var decoded: String {
    guard let text = record.cursor else { return "none, boots at the next pull" }
    return Cursor(decoding: text)?.json.jcsText ?? "undecodable \(text)"
  }
}
