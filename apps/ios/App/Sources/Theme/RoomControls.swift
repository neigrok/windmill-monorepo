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

// A glass circle holding one symbol, 44 pt unless a smaller seat is asked for; its target is 44 pt either way.
struct RoomSeatStyle: ButtonStyle {
  var diameter = RoomSpace.minimumTarget

  func makeBody(configuration: Configuration) -> some View {
    seat(configuration.label.frame(width: diameter, height: diameter))
      .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
  }

  @ViewBuilder private func seat<V: View>(_ content: V) -> some View {
    if #available(iOS 26.0, *) { content.glassEffect(.regular.interactive(), in: Circle()) }
    else { content.background(.regularMaterial, in: Circle()) }
  }
}

// The one floating primary of a screen, in the reach band, with an optional trailing symbol and one-line footer.
struct ActionBand: View {
  let title: String
  let room: RoomColors
  var disabled = false
  var busy = false
  var actionIdentifier: String?
  var footer: String?
  var symbol: String?
  let action: () -> Void

  var body: some View {
    VStack(spacing: RoomSpace.related) {
      Button(action: action) {
        HStack(spacing: RoomSpace.related) {
          if busy { ProgressView().tint(room.onAccent) }
          Text(title)
          if let symbol { Image(systemName: symbol).accessibilityHidden(true) }
        }.frame(maxWidth: .infinity)
      }.modifier(RoomPrimaryStyle(room: room))
        .disabled(disabled || busy)
        .accessibilityIdentifier(actionIdentifier ?? title)
      if let footer {
        Text(footer).font(.footnote).foregroundStyle(room.inkDim).multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
    }.padding(RoomSpace.inset)
  }
}

// iOS 26 draws the subtitle under the inline title; iOS 18 stacks the two in the bar's principal slot.
struct RoomTitle: ViewModifier {
  let title: String
  let subtitle: String?

  func body(content: Content) -> some View {
    if #available(iOS 26.0, *), let subtitle {
      content.navigationTitle(title).navigationSubtitle(subtitle)
    } else if let subtitle {
      content.navigationTitle(title).toolbar {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 0) {
            Text(title).font(.headline)
            Text(subtitle).font(.caption).foregroundStyle(.secondary)
          }.accessibilityElement(children: .combine)
        }
      }
    } else { content.navigationTitle(title) }
  }
}

extension View {
  func roomTitle(_ title: String, subtitle: String?) -> some View { modifier(RoomTitle(title: title, subtitle: subtitle)) }
}
