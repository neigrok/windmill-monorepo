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
      .modifier(FloatingSurface())
      .accessibilityElement(children: .contain)
      .padding(.horizontal, RoomSpace.inset).padding(.vertical, RoomSpace.small)
  }
}

// A band floats over the list it answers, so it stands on the system's floating surface, never on a row's card.
struct FloatingSurface: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: RoomSpace.cardRadius)
    if #available(iOS 26.0, *) { content.glassEffect(.regular, in: shape) }
    else { content.background(.regularMaterial, in: shape).shadow(radius: 8, y: 2) }
  }
}

// At accessibility sizes a band scrolls within a bounded height, so the controls beneath stay in reach.
struct BoundedBand: ViewModifier {
  @Environment(\.dynamicTypeSize) private var typeSize

  func body(content: Content) -> some View {
    if typeSize.isAccessibilitySize {
      CappedHeight(limit: 180) { ScrollView { content }.scrollBounceBehavior(.basedOnSize) }
    } else { content }
  }
}

struct CappedHeight: Layout {
  let limit: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let content = subviews.first else { return .zero }
    let ideal = content.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
    return CGSize(width: proposal.width ?? ideal.width, height: min(ideal.height, limit))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}
