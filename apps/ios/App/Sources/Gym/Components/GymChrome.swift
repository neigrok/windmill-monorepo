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

// A sheet that edits a record commits from its bar (docs/design/ios/ios-redesign.md §5 Sheets): the dismissal leading,
// the commit trailing in the room's accent — the system's prominent checkmark on iOS 26, a bold label before it — so
// nothing stands at the sheet's foot. Its destructive act is the form's last row.
struct SheetCommit: ViewModifier {
  let title: String
  let identifier: String
  var dismissal = "Cancel"
  var dismissalIdentifier: String?
  var disabled = false
  var busy = false
  let dismiss: () -> Void
  let commit: () -> Void

  func body(content: Content) -> some View {
    content.toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button(dismissal, action: dismiss).disabled(busy).accessibilityIdentifier(dismissalIdentifier ?? dismissal)
      }
      ToolbarItem(placement: .confirmationAction) {
        confirm.disabled(disabled || busy).accessibilityIdentifier(identifier).tint(GymPalette.accent)
      }
    }.roomBar(.gym)
  }

  // The checkmark is drawn on-accent, as the band's primary is, so it reads at 4.5:1 on the prominent fill.
  @ViewBuilder var confirm: some View {
    if #available(iOS 26.0, *) {
      Button(role: .confirm, action: commit) {
        Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(disabled || busy ? GymPalette.inkFaint : GymPalette.onAccent)
      }.buttonStyle(.glassProminent).accessibilityLabel(title)
    } else { Button(action: commit) { Text(title).bold() } }
  }
}

extension View {
  func sheetCommit(_ title: String, identifier: String, dismissal: String = "Cancel", dismissalIdentifier: String? = nil,
                   disabled: Bool = false, busy: Bool = false, dismiss: @escaping () -> Void, commit: @escaping () -> Void) -> some View {
    modifier(SheetCommit(title: title, identifier: identifier, dismissal: dismissal, dismissalIdentifier: dismissalIdentifier,
                         disabled: disabled, busy: busy, dismiss: dismiss, commit: commit))
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
