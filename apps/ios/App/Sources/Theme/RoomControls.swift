import SwiftUI

struct RoomPrimaryStyle: ViewModifier {
  let accent: Color
  let onAccent: Color

  func body(content: Content) -> some View {
    styled(content).controlSize(.large).buttonBorderShape(.capsule)
      .tint(accent).foregroundStyle(onAccent)
  }

  @ViewBuilder private func styled(_ content: Content) -> some View {
    if #available(iOS 26.0, *) { content.buttonStyle(.glassProminent) }
    else { content.buttonStyle(.borderedProminent) }
  }
}

struct RoomSecondaryStyle: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 26.0, *) { content.buttonStyle(.glass) }
    else { content.buttonStyle(.bordered) }
  }
}

struct RoomSeatStyle: ViewModifier {
  func body(content: Content) -> some View {
    seat(content.frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget)
      .contentShape(Circle()).buttonStyle(.plain))
  }

  @ViewBuilder private func seat<V: View>(_ content: V) -> some View {
    if #available(iOS 26.0, *) { content.glassEffect(.regular.interactive(), in: Circle()) }
    else { content.background(.regularMaterial, in: Circle()) }
  }
}
