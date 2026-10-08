import SwiftUI

struct RoomTransient: View {
  let message: String
  let room: RoomColors
  var actionTitle: String?
  var actionSymbol: String?
  var actionIdentifier: String?
  var action: (() -> Void)?
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(spacing: RoomSpace.related))
    layout {
      Text(message).foregroundStyle(room.ink).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let action {
        Button(action: action) {
          Group {
            if let actionSymbol {
              Image(systemName: actionSymbol).accessibilityLabel(actionTitle ?? "Dismiss")
            } else { Text(actionTitle ?? "Dismiss") }
          }.foregroundStyle(.tint)
            .frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
          .accessibilityIdentifier(actionIdentifier ?? actionTitle ?? "transient-action")
      }
    }.font(.footnote)
      .padding(.horizontal, RoomSpace.inset).padding(.vertical, RoomSpace.small)
      .frame(minHeight: RoomSpace.minimumTarget)
      .background(room.card, in: RoundedRectangle(cornerRadius: RoomSpace.cardRadius))
      .accessibilityElement(children: .contain)
  }
}

// At accessibility sizes a floating band scrolls within a bounded height, so the controls beneath stay in reach.
struct BoundedBand: ViewModifier {
  @Environment(\.dynamicTypeSize) private var typeSize

  func body(content: Content) -> some View {
    if typeSize.isAccessibilitySize {
      ViewThatFits(in: .vertical) {
        content.fixedSize(horizontal: false, vertical: true)
        ScrollView { content }.scrollBounceBehavior(.basedOnSize)
      }.frame(maxHeight: 180)
    } else { content }
  }
}

struct ActionBand: View {
  let title: String
  var subtitle: String?
  let room: RoomColors
  var disabled = false
  var busy = false
  var actionIdentifier: String?
  let action: () -> Void

  var body: some View {
    VStack(spacing: RoomSpace.related) {
      Button(action: action) {
        HStack(spacing: RoomSpace.related) {
          if busy { ProgressView().tint(room.onAccent) }
          Text(title)
        }.frame(maxWidth: .infinity)
      }.modifier(RoomPrimaryStyle(room: room))
        .disabled(disabled || busy)
        .accessibilityIdentifier(actionIdentifier ?? title)
      if let subtitle { Text(subtitle).font(.footnote).lineLimit(1) }
    }.padding(RoomSpace.inset)
  }
}
