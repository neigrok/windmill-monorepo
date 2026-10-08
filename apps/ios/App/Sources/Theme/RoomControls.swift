import SwiftUI

struct RoomPrimaryStyle: ViewModifier {
  let room: RoomColors
  @Environment(\.isEnabled) private var enabled

  func body(content: Content) -> some View {
    styled(content).controlSize(.large).buttonBorderShape(.capsule).tint(room.accent)
      .foregroundStyle(enabled ? AnyShapeStyle(room.onAccent) : AnyShapeStyle(.secondary))
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

struct RoomSeatStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    seat(configuration.label.frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget)
      .contentShape(Circle()))
  }

  @ViewBuilder private func seat<V: View>(_ content: V) -> some View {
    if #available(iOS 26.0, *) { content.glassEffect(.regular.interactive(), in: Circle()) }
    else { content.background(.regularMaterial, in: Circle()) }
  }
}
