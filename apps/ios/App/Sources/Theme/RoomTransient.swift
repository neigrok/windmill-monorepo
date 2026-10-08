import SwiftUI

struct RoomTransient: View {
  let message: String
  let room: RoomColors
  var actionTitle: String?
  var actionSymbol: String?
  var actionIdentifier: String?
  var action: (() -> Void)?

  var body: some View {
    HStack(spacing: RoomSpace.related) {
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
