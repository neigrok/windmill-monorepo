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

// A sheet that edits a record commits from its bar: the dismissal leading,
// the commit trailing in the room's accent — the system's prominent checkmark on iOS 26, a bold label before it — so
// nothing stands at the sheet's foot; a sheet over the workout's rack (03.25) keeps its checkmark in plain glass. Its
// destructive act is the form's last row.
struct SheetCommit: ViewModifier {
  let title: String
  let identifier: String
  var dismissal = "Cancel"
  var dismissalIdentifier: String?
  var disabled = false
  var busy = false
  var prominent = true
  let dismiss: () -> Void
  let commit: () -> Void

  func body(content: Content) -> some View {
    content.toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button(dismissal, action: dismiss).disabled(busy).accessibilityIdentifier(dismissalIdentifier ?? dismissal)
      }
      if prominent {
        ToolbarItem(placement: .confirmationAction) {
          confirm.disabled(disabled || busy).accessibilityIdentifier(identifier).tint(GymPalette.accent)
        }
      } else {
        ToolbarItem(placement: .topBarTrailing) {
          Button(title, systemImage: "checkmark", action: commit).disabled(disabled || busy).accessibilityIdentifier(identifier)
        }
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

// A pushed screen, or Coach while its composer has focus, hides the tab bar, and the tab bar's accessory goes with it
// (Figma Gym · iOS 03.5): the room reads this from each tab's stack.
struct TabBarHidden: PreferenceKey {
  static let defaultValue = false
  static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

// A tab's root holds its list's end clear of the tab bar and its accessory: across a pop, which lays the root out for a moment
// before the bar returns and would clamp the list under it, and as the finger lets go of a bounce that brought the bar back,
// since a bar that grows under a finger leaves the list's inset where the touch found it. The inset taking up the hold, or a
// finger, lets it go.
struct HeldFoot: ViewModifier {
  struct Foot {
    var bar: CGFloat = 0
    var inset: CGFloat = 0
  }
  struct Hold {
    let margin: CGFloat
    let until: CGFloat
  }

  @State var foot = Foot()
  @State var touched: Foot?
  @State var hold: Hold?

  func body(content: Content) -> some View {
    content.contentMargins(.bottom, hold?.margin ?? 0, for: .scrollContent)
      .onDisappear { hold = Hold(margin: foot.inset, until: foot.inset); touched = nil }
      .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: { foot.bar = $0 }
      .onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.bottom } action: { _, inset in
        foot.inset = inset
        if let hold, inset >= hold.until { self.hold = nil }
      }
      .onScrollPhaseChange { _, phase in
        switch phase {
        case .tracking, .interacting:
          hold = nil
          touched = touched ?? foot
        default:
          guard let touched else { return }
          let grown = foot.bar - touched.bar
          if grown > 0 && foot.inset == touched.inset { hold = Hold(margin: grown, until: foot.inset + grown) }
          if phase == .idle { self.touched = nil }
        }
      }
  }
}

extension View {
  func gymTabBar(hidden: Bool = true) -> some View {
    toolbar(hidden ? .hidden : .automatic, for: .tabBar).preference(key: TabBarHidden.self, value: hidden)
  }
  func sheetCommit(_ title: String, identifier: String, dismissal: String = "Cancel", dismissalIdentifier: String? = nil,
                   disabled: Bool = false, busy: Bool = false, prominent: Bool = true, dismiss: @escaping () -> Void,
                   commit: @escaping () -> Void) -> some View {
    modifier(SheetCommit(title: title, identifier: identifier, dismissal: dismissal, dismissalIdentifier: dismissalIdentifier,
                         disabled: disabled, busy: busy, prominent: prominent, dismiss: dismiss, commit: commit))
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

// A number typed in place at a form row's end, drawn as Fix set's Load field (03.25): a 120 × 36 well on the system
// fill, growing with the text size, outlined in the accent while it has focus.
struct FieldWell: ViewModifier {
  let focused: Bool
  @ScaledMetric(relativeTo: .body) private var width = 120.0
  @ScaledMetric(relativeTo: .body) private var height = 36.0

  func body(content: Content) -> some View {
    content.multilineTextAlignment(.trailing).monospacedDigit()
      .padding(.horizontal, 10).frame(width: width, height: height)
      .background(GymPalette.control, in: RoundedRectangle(cornerRadius: 10))
      .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(focused ? GymPalette.accent : .clear, lineWidth: 1.5) }
  }
}

// A tab's one creation act, floating bottom-trailing in the tab's reach band, 16 pt from the edge and 12 pt above the tab
// bar, so the list's last row clears it: Liquid Glass with its symbol, and its label when it has one, in the accent. A
// bare symbol is a 60 pt circle named for VoiceOver by the act; a labelled act is a 52 pt capsule. Before iOS 26 the
// glass is the regular material.
struct FloatingAction: View {
  let title: String
  let symbol: String
  var labelled = false
  let identifier: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Group {
        if labelled {
          Label(title, systemImage: symbol).padding(.leading, 18).padding(.trailing, 22).frame(minHeight: RoomSpace.controlHeight)
        } else {
          Image(systemName: symbol).font(.title).frame(width: 60, height: 60).accessibilityLabel(title)
        }
      }.font(.headline).foregroundStyle(GymPalette.accent).roomGlass(in: Capsule(), interactive: true, floating: true).contentShape(Capsule())
    }.buttonStyle(.plain).accessibilityIdentifier(identifier)
      .frame(maxWidth: .infinity, alignment: .trailing)
      .padding(.horizontal, RoomSpace.inset).padding(.bottom, 12)
  }
}

// The room's More: `ellipsis.circle` in the bar presenting a native Menu.
struct MoreMenu<Content: View>: View {
  let identifier: String
  @ViewBuilder let content: () -> Content

  var body: some View {
    Menu(content: content) { Label("More", systemImage: "ellipsis.circle") }.labelStyle(.iconOnly).accessibilityIdentifier(identifier)
  }
}
