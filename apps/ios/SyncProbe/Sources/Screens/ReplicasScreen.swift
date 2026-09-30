import SwiftUI
import SyncReplica

struct ReplicasScreen: View {
  let probe: Probe

  var body: some View {
    NavigationStack {
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        switch Result(catching: { try probe.snapshot() }) {
        case .success(let device): ReplicaList(device: device)
        case .failure(let error): Text(verbatim: "The store could not be read: \(error)")
        }
      }
      .navigationTitle("Replicas")
    }
  }
}

private struct ReplicaList: View {
  let device: LoadedDevice

  var body: some View {
    List {
      Section("Device") {
        LabeledContent("Active replica", value: device.active)
        LabeledContent("Pending sign-in", value: device.meta.pendingSignIn ?? "none")
      }
      ForEach(device.replicas, id: \.id) { replica in
        Section(replica.id == device.active ? "\(replica.id) · active" : replica.id) {
          LabeledContent("state", value: replica.meta.state.rawValue)
          LabeledContent("account", value: replica.meta.account ?? "none")
          LabeledContent("nextN", value: "\(replica.meta.nextN)")
          LabeledContent("ackThrough", value: "\(replica.meta.ackThrough)")
          LabeledContent("serverEpoch", value: replica.meta.serverEpoch ?? "none")
          LabeledContent("offset", value: "\(replica.meta.serverOffsetMs) ms · \(replica.meta.offset.samples.count) samples")
          LabeledContent("authPaused", value: String(replica.meta.authPaused))
        }
      }
    }
  }
}
