import SwiftUI

// Every role a room's button takes: the screen's primary, a secondary, a glass seat and a card's decision.

// The one primary of a screen.
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
    configuration.label.frame(width: diameter, height: diameter).roomGlass(in: Circle(), interactive: true)
      .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
  }
}

// A card's decision, the full width: prominent on the accent, or quiet on the canvas, where a destructive button takes
// system red for its label. It is drawn by hand where every other primary is the system's prominent glass
// (docs/design/consistency.md, Coach card decisions); Coach's cards are its one home, so it draws in the gym's colours.
struct RoomDecisionStyle: ButtonStyle {
  enum Emphasis { case prominent, quiet }
  let emphasis: Emphasis
  @Environment(\.isEnabled) private var enabled

  init(_ emphasis: Emphasis) { self.emphasis = emphasis }

  func makeBody(configuration: Configuration) -> some View {
    let prominent = emphasis == .prominent
    let label = prominent ? GymPalette.onAccent : configuration.role == .destructive ? GymPalette.destructive : GymPalette.ink
    configuration.label.font(.headline).foregroundStyle(label)
      .frame(maxWidth: .infinity, minHeight: RoomSpace.controlHeight).padding(.horizontal, RoomSpace.inset)
      .background(prominent ? GymPalette.accent : GymPalette.canvas, in: Capsule())
      .opacity(enabled ? 1 : 0.5).scaleEffect(configuration.isPressed ? 0.98 : 1).contentShape(Capsule())
  }
}

// Liquid Glass on iOS 26; before it the regular material, with the system shadow under a surface that floats over a list.
struct RoomGlass<Surface: Shape>: ViewModifier {
  let shape: Surface
  var interactive = false
  var floating = false

  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 26.0, *) { content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape) }
    else if floating { content.background(.regularMaterial, in: shape).shadow(radius: 8, y: 2) }
    else { content.background(.regularMaterial, in: shape) }
  }
}

// The one primary of a screen, in the reach band, with an optional trailing symbol and a one-line footer that stands
// in the band with it.
struct ActionBand: View {
  let title: String
  let room: RoomColors
  var disabled = false
  var busy = false
  var actionIdentifier: String?
  var footer: String?
  var symbol: String?
  var role: ButtonRole?
  let action: () -> Void

  var body: some View {
    VStack(spacing: RoomSpace.related) {
      Button(role: role, action: action) {
        HStack(spacing: RoomSpace.related) {
          if busy { ProgressView().controlSize(.regular).tint(room.onAccent) }
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

// What stands at the foot of a screen — its one primary, its transient — sits in a bar, so the list's last row clears it
// at rest and what scrolls beneath it softens under the scroll edge: iOS 26's own edge effect, the bar material on
// iOS 18 while content is beneath. A band on a surface carries text outside a button: on both systems it takes the bar
// material while content is beneath, on iOS 26 over the hard edge, so no row reads through its words.
struct ReachBand<Band: View>: ViewModifier {
  let spacing: CGFloat?
  var onSurface = false
  let band: Band
  @State private var beneath = false

  func body(content: Content) -> some View {
    barred(content.onScrollGeometryChange(for: Bool.self) { $0.contentSize.height > $0.visibleRect.maxY - $0.contentInsets.bottom + 1 } action: { beneath = $1 })
  }

  @ViewBuilder func barred(_ content: some View) -> some View {
    if #available(iOS 26.0, *) {
      content.scrollEdgeEffectStyle(onSurface ? .hard : .automatic, for: .bottom)
        .safeAreaBar(edge: .bottom, spacing: spacing) {
          band.background { if onSurface && beneath { Rectangle().fill(.bar).ignoresSafeArea(edges: .bottom) } }
        }
    }
    else {
      content.safeAreaInset(edge: .bottom, spacing: spacing) {
        band.background { if beneath { Rectangle().fill(.bar).ignoresSafeArea(edges: .bottom) } }
      }
    }
  }
}

// A scroll view that passes under a fixed head or foot, not a bar, fades that edge over the height of its inset: a line
// passing it softens away instead of being cut. With no bar there, iOS 26 draws no scroll edge of its own. Inactive, it
// leaves the content as it is.
struct SoftEdge: ViewModifier {
  let edge: VerticalEdge
  let active: Bool
  init(_ edge: VerticalEdge, active: Bool = true) { self.edge = edge; self.active = active }

  @ViewBuilder func body(content: Content) -> some View {
    if active {
      content.contentMargins(edge == .top ? .top : .bottom, RoomSpace.inset, for: .scrollContent).mask {
        VStack(spacing: 0) {
          if edge == .bottom { Rectangle() }
          LinearGradient(colors: [.clear, .black], startPoint: edge == .top ? .top : .bottom, endPoint: edge == .top ? .bottom : .top)
            .frame(height: RoomSpace.inset)
          if edge == .top { Rectangle() }
        }
      }
    } else { content }
  }
}

// The chevron of a door a Button opens, drawn as the system draws a NavigationLink's.
struct DoorChevron: View {
  let room: RoomColors
  var body: some View {
    Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(room.ink.tertiary)
      .dynamicTypeSize(...DynamicTypeSize.accessibility2).accessibilityHidden(true)
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
  func roomGlass(in shape: some Shape, interactive: Bool = false, floating: Bool = false) -> some View {
    modifier(RoomGlass(shape: shape, interactive: interactive, floating: floating))
  }
  func reachBand(spacing: CGFloat? = nil, onSurface: Bool = false, @ViewBuilder _ band: () -> some View) -> some View {
    modifier(ReachBand(spacing: spacing, onSurface: onSurface, band: band()))
  }
  // A bar's items take the room's label colour; the accent stays with the page under the bar and with a confirmation.
  // The tint reaches the items declared before it, so it follows a screen's toolbar.
  func roomBar(_ room: RoomColors) -> some View { tint(room.ink) }
}
