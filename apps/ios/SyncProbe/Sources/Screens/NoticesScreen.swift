import SwiftUI
import SyncEngine
import SyncReplica

struct NoticesScreen: View {
  let probe: Probe
  @State private var notices: NoticesView
  @State private var failure: String?

  init(probe: Probe) {
    self.probe = probe
    _notices = State(initialValue: probe.engine.notices("probe"))
  }

  var body: some View {
    NavigationStack {
      List {
        if let failure { Text(verbatim: "Dismiss failed: \(failure)") }
        if notices.notices.isEmpty { Text("No notices") }
        ForEach(notices.notices) { notice in
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: notice.code.text).font(.headline)
            Text(verbatim: notice.id)
            Text(verbatim: "scope \(notice.scope.text) · at \(notice.at)")
            Text(verbatim: "detail \(notice.detail?.jcsText ?? "none")")
            Text(verbatim: "content \(notice.content.json.jcsText)")
            Button("Dismiss") { dismiss(notice.id) }.buttonStyle(.borderless)
          }
          .font(.footnote)
        }
      }
      .navigationTitle("Notices")
    }
  }

  func dismiss(_ id: String) {
    do {
      try probe.engine.dismissNotice(id)
      failure = nil
    } catch {
      failure = "\(error)"
    }
  }
}
