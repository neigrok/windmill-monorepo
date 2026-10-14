import SwiftUI

struct GymPage: ViewModifier {
  var titleDisplayMode: NavigationBarItem.TitleDisplayMode = .inline

  func body(content: Content) -> some View {
    content
      .scrollContentBackground(.hidden)
      .background(GymPalette.canvas)
      .tint(GymPalette.accent)
      .navigationBarTitleDisplayMode(titleDisplayMode)
  }
}

// Next and Done above the keyboard while a field has focus, drawn by the page: a keyboard toolbar on iOS 26 shortens
// the keyboard avoidance of the sheets opened after it.
struct KeyboardBar: View {
  var next: (() -> Void)?
  var nextDisabled = false
  let doneIdentifier: String
  let done: () -> Void

  var body: some View {
    HStack {
      Spacer()
      if let next { Button("Next", action: next).frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget).disabled(nextDisabled) }
      Button("Done", action: done).frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget)
        .accessibilityIdentifier(doneIdentifier)
    }.padding(.horizontal)
  }
}

// The room's More: `ellipsis.circle` in the bar presenting a native Menu (docs/design/ios/ios-redesign.md §5).
struct MoreMenu<Content: View>: View {
  let identifier: String
  @ViewBuilder let content: () -> Content

  var body: some View {
    Menu(content: content) { Label("More", systemImage: "ellipsis.circle") }.labelStyle(.iconOnly).accessibilityIdentifier(identifier)
  }
}
