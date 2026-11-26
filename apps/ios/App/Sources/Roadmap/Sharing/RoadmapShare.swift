import SwiftUI
import UIKit
import DomainKit
import RoadmapDomain

// Share (Roadmap on iOS §7.4; Roadmap · iOS 09.1a to 09.2b): one switch on a root, which the title menu's Share… raises over
// the open roadmap. It reads the roadmap's visibility from the phone's copy and writes it by the domain's `SetVisibility`
// through the room's write door, `public` on and `private` off; the server then writes the reach of the roadmap and of
// every subtree under it. A link opens for no one until the server holds the change, so the switch waits for an account
// and a connection. While the roadmap is public the sheet hands out its share address (§4), with a connection or without.
@Observable @MainActor
final class ShareSheet: Identifiable {
  unowned let room: RoadmapModel
  // The roadmap the sheet shares, a root of the person's own list.
  let tree: DomainKit.ID<RoadmapEntry>

  init(of tree: DomainKit.ID<RoadmapEntry>, room: RoadmapModel) {
    self.room = room
    self.tree = tree
  }

  // The roadmap, while the room has it open.
  var open: RoadmapModel.OpenRoadmap? {
    guard let shown = room.shown, shown.id == tree else { return nil }
    return shown
  }

  // The room no longer shows the roadmap: another opened, or none. While the copy is read again, as across a sign-in, the
  // sheet stands.
  var gone: Bool {
    switch room.phase {
    case .open(let shown): shown.id != tree
    case .empty, .failed: true
    case .unread: false
    }
  }

  var isPublic: Bool { open?.tree.meta?.visibility == "public" }

  // A step of the roadmap owns a subtree, which goes public with it (09.1c).
  var subtrees: Bool { open?.rows.values.contains { $0.opening?.owned == true } ?? false }

  var signedIn: Bool { room.links?.sources.signedIn() ?? false }
  var online: Bool { room.links?.sources.online() ?? false }

  // The roadmap's share address, while it is public.
  var address: URL? {
    guard isPublic else { return nil }
    return room.links?.sources.address(of: tree.description)
  }

  // The one sentence under the switch that is true now (09.1a to 09.2b): why the switch waits, else who can see the roadmap.
  var footer: String {
    if !signedIn { return String(localized: "Sign in to share a roadmap.") }
    if !online { return String(localized: "Sharing needs a connection.") }
    if !isPublic { return String(localized: "Only you can view this roadmap.") }
    if subtrees { return String(localized: "Anyone with this link can view and fork this roadmap, subtrees included, and it can appear in the public gallery.") }
    return String(localized: "Anyone with this link can view and fork this roadmap, and it can appear in the public gallery.")
  }

  // The switch turned: the roadmap's visibility written as any change, with no Undo and nothing to confirm (09.1b). What
  // the domain refuses, or a commit that fails, leaves the switch where the copy holds it.
  func turn(public turned: Bool) {
    guard signedIn, online, open != nil, turned != isPublic else { return }
    let step = turned ? "publish" : "private"
    switch room.write(SetVisibility(tree: tree, visibility: turned ? "public" : "private"), as: "visibility") {
    case .committed(_, let receipt):
      room.forget(receipt.gestureId)
      room.telemetry.event("roadmap_verb", properties: ["verb": "share", "step": step, "outcome": "ok"])
    case .unchanged: room.telemetry.event("roadmap_verb", properties: ["verb": "share", "step": step, "outcome": "ok"])
    case .refused, .failed: room.telemetry.event("roadmap_verb", properties: ["verb": "share", "step": step, "outcome": "failed"])
    }
  }

  // Share Link, handed to the system's share sheet.
  func shared() {
    room.telemetry.event("roadmap_verb", properties: ["verb": "share", "step": "link"])
  }

  // Copy Link: the share address on the pasteboard.
  func copy() {
    guard let address else { return }
    UIPasteboard.general.url = address
    room.telemetry.event("roadmap_verb", properties: ["verb": "share", "step": "copy"])
  }

  // Sign In, signed out (09.2a): the shell's sign-in, over the sheet, which stands again once it closes.
  func signIn() {
    room.telemetry.event("roadmap_verb", properties: ["verb": "share", "step": "sign_in"])
  }
}

extension RoadmapModel {
  // Share…, in the title menu of the person's own room, whose roadmap is a root; a roadmap gone into has none.
  func openShare() {
    guard case .owner = role, let shown else { return }
    share = ShareSheet(of: shown.id, room: self)
    telemetry.event("roadmap_verb", properties: ["verb": "share", "step": "open"])
  }
}

// The Share sheet (09.1a to 09.2b): a medium sheet with its close button, the switch over the sentence true now, and while
// the roadmap is public Share Link, the system's share sheet, and Copy Link. Signed out the switch is dimmed and Sign In
// stands at the sheet's foot, opening the shell's sign-in over the sheet.
struct RoadmapShare: View {
  let share: ShareSheet
  let app: AppModel

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Toggle("Public link", isOn: Binding(get: { share.isPublic }, set: { share.turn(public: $0) }))
            .foregroundStyle(RoadmapPalette.ink).tint(RoadmapPalette.accent).disabled(!share.signedIn || !share.online)
            .listRowBackground(RoadmapPalette.card).accessibilityIdentifier("roadmap-share-public")
        } footer: {
          Text(share.footer).foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-share-footer")
        }
        if let address = share.address {
          Section {
            ShareLink(item: address) { Label("Share Link", systemImage: "square.and.arrow.up") }
              .simultaneousGesture(TapGesture().onEnded { share.shared() })
              .listRowBackground(RoadmapPalette.card).accessibilityIdentifier("roadmap-share-link")
            Button("Copy Link", systemImage: "link") { share.copy() }
              .listRowBackground(RoadmapPalette.card).accessibilityIdentifier("roadmap-share-copy")
          }
        }
      }.scrollContentBackground(.hidden).contentMargins(.top, RoomSpace.related, for: .scrollContent)
        .background { RoadmapPalette.canvas.ignoresSafeArea() }
        .navigationTitle("Share").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            if #available(iOS 26.0, *) { Button(role: .close) { share.room.share = nil }.accessibilityIdentifier("roadmap-share-close") }
            else { Button("Done") { share.room.share = nil }.accessibilityIdentifier("roadmap-share-close") }
          }
        }.roomBar(.roadmap)
        .modifier(SignInFoot(share: share, app: app))
    }.tint(RoadmapPalette.accent).presentationDetents([.medium]).presentationDragIndicator(.visible)
      // The shell's sign-in stands over the sheet while the room's waits.
      .onAppear { app.roomSheetUp = true }
      .onDisappear { app.roomSheetUp = false }
      .sheet(isPresented: Binding(get: { app.sheet != nil }, set: { if !$0 { app.cancelAuthentication(); app.sheet = nil } }),
             onDismiss: { app.dismissSheet() }) { AccountSheet(model: app) }
  }

  // 09.2a: Sign In at the sheet's foot while the phone is signed out.
  struct SignInFoot: ViewModifier {
    let share: ShareSheet
    let app: AppModel

    @ViewBuilder func body(content: Content) -> some View {
      if share.signedIn {
        content
      } else if #available(iOS 26.0, *) {
        content.safeAreaBar(edge: .bottom) { button.buttonStyle(.glass) }
      } else {
        content.safeAreaInset(edge: .bottom) { button.buttonStyle(.bordered) }
      }
    }

    var button: some View {
      Button {
        share.signIn()
        app.signIn(for: .share)
      } label: {
        Text("Sign In").font(.body.weight(.semibold)).frame(maxWidth: .infinity)
      }.buttonBorderShape(.capsule).controlSize(.large).tint(RoadmapPalette.accent)
        .padding(.horizontal, RoomSpace.inset).padding(.vertical, 6)
        .accessibilityIdentifier("roadmap-share-sign-in")
    }
  }
}
