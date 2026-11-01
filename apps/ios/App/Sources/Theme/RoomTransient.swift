import SwiftUI

// The one band (Figma Gym · iOS 00.3): a message with at most one control, an accent action or the
// dismiss xmark. Where its host keys `roomMotion` on what it says, it rises on the system spring and leaves the way it
// came, a 200 ms fade with Reduce Motion; a band with a way to be dismissed also goes by a swipe down, unless its text
// scrolls within a bounded band, where a drag reads the text and its control sends it away. It floats over the list it
// answers, so it stands on glass, never on a row's card.
struct RoomTransient: View {
  let message: String
  let room: RoomColors
  var actionTitle: String?
  var actionSymbol: String?
  var actionIdentifier: String?
  var action: (() -> Void)?
  var dismiss: (() -> Void)?
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.bandScrolls) private var scrolls
  @GestureState(resetTransaction: Transaction(animation: .spring)) private var pull: CGFloat = 0

  var body: some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(spacing: RoomSpace.related))
    let motion = RoomMotion.animation(reduceMotion: reduceMotion)
    layout {
      Text(message).foregroundStyle(room.ink).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let action {
        Button { withAnimation(motion, action) } label: {
          Group {
            if let actionSymbol {
              Image(systemName: actionSymbol).foregroundStyle(room.inkDim).accessibilityLabel(actionTitle ?? "Dismiss")
            } else { Text(actionTitle ?? "Dismiss").foregroundStyle(room.accent) }
          }.frame(minWidth: RoomSpace.minimumTarget, minHeight: RoomSpace.minimumTarget)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
          .accessibilityIdentifier(actionIdentifier ?? actionTitle ?? "transient-action")
      }
    }.font(.footnote)
      .padding(.horizontal, RoomSpace.inset).padding(.vertical, RoomSpace.small)
      .frame(minHeight: RoomSpace.minimumTarget)
      .roomGlass(in: .card, floating: true)
      .contentShape(.card)
      .accessibilityElement(children: .contain)
      .padding(.horizontal, RoomSpace.inset).padding(.vertical, RoomSpace.small)
      .offset(y: pull)
      .gesture(swipe(motion), isEnabled: dismiss != nil && !scrolls)
      .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
  }

  // A pull down past half a minimum target, or a flick that would carry it past a whole one, sends the band away.
  func swipe(_ motion: Animation) -> some Gesture {
    DragGesture(minimumDistance: RoomSpace.related, coordinateSpace: .global)
      .updating($pull) { drag, pull, _ in pull = max(0, drag.translation.height) }
      .onEnded { drag in
        guard drag.translation.height > RoomSpace.minimumTarget / 2 || drag.predictedEndTranslation.height > RoomSpace.minimumTarget else { return }
        withAnimation(motion) { dismiss?() }
      }
  }
}

// At accessibility sizes a band scrolls within a bounded height, so the controls beneath stay in reach; while its text
// overflows, the band tells it so that a vertical drag scrolls rather than dismisses.
struct BoundedBand: ViewModifier {
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var scrolls = false

  func body(content: Content) -> some View {
    if typeSize.isAccessibilitySize {
      CappedHeight(limit: 180) {
        ScrollView { content.environment(\.bandScrolls, scrolls) }.scrollBounceBehavior(.basedOnSize)
          .onScrollGeometryChange(for: Bool.self) { $0.contentSize.height > $0.containerSize.height } action: { scrolls = $1 }
      }
    } else { content }
  }
}

extension EnvironmentValues {
  @Entry var bandScrolls = false
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
