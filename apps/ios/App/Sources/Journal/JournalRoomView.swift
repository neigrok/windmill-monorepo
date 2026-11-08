import SwiftUI

// The journal room (Journal · iOS 01.8P–01.12P): a Pages tab holding the day canvas, and Write, today's count and its saved
// state in the tab bar's bottom accessory on iOS 26, or in a plain row above the tab bar on iOS 18.
struct JournalRoomView: View {
  @Bindable var model: JournalModel
  let app: AppModel
  @State var writeAsked = 0
  @State var inkFrames: [String: CGRect] = [:]

  var body: some View {
    if #available(iOS 26.1, *) {
      tabs.tabBarMinimizeBehavior(.onScrollUp).tabViewBottomAccessory(isEnabled: model.writable) { accessory }
    } else if #available(iOS 26, *) {
      tabs.tabBarMinimizeBehavior(.onScrollUp).tabViewBottomAccessory { accessory }
    } else { tabs }
  }

  var tabs: some View {
    TabView {
      Tab("Pages", systemImage: "book.pages") {
        if #available(iOS 26, *) { canvas }
        else {
          canvas.safeAreaInset(edge: .bottom, spacing: 0) {
            if !model.editing {
              accessory.frame(minHeight: RoomSpace.minimumTarget).background(.bar)
                .overlay(alignment: .bottom) { Divider() }
            }
          }
        }
      }
    }.tint(JournalPalette.lamp)
  }

  var canvas: some View { JournalScreen(model: model, app: app, writeAsked: writeAsked, inkFrames: $inkFrames) }

  // One quiet button for Write; where the accessory cannot leave (iOS 26.0, iOS 18's row) it stands disabled over a read-only page.
  var accessory: some View {
    let writable = model.writable
    return Button { writeAsked += 1 } label: {
      HStack(spacing: RoomSpace.related) {
        Label("Write", systemImage: "square.and.pencil").fontWeight(.semibold)
          .foregroundStyle(writable ? JournalPalette.ink : JournalPalette.inkFaint)
          .inkAnchor("write", enabled: model.inkVisible, frames: $inkFrames)
        Spacer(minLength: RoomSpace.related)
        if let count = model.wordCount { Text(count).foregroundStyle(writable ? JournalPalette.inkDim : JournalPalette.inkFaint) }
        if let symbol = model.backup.symbol { Image(systemName: symbol).foregroundStyle(writable ? JournalPalette.inkDim : JournalPalette.inkFaint) }
      }.font(.subheadline).padding(.horizontal, RoomSpace.inset).frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
    }.buttonStyle(.plain).disabled(!writable)
      .inkAnchor("accessory", enabled: model.inkVisible, frames: $inkFrames)
      .accessibilityLabel("Write").accessibilityValue([model.wordCount, model.backup.label].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
      .accessibilityHint("Opens the keyboard on today's page").accessibilityIdentifier("write-today")
  }
}
