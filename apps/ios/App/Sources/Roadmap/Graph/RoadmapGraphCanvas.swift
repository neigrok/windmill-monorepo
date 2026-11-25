import SwiftUI
import RoadmapDomain
import RoadmapLayout

// The Graph (Roadmap · iOS 04.1, 04.2, 04.4, 04.5): the open roadmap's picture on its surface, which runs under the
// room's bars. One finger pans and a pinch zooms about the point it began at; a tap selects the step it lands on, by
// its disc or by a 44 pt target where the disc is smaller, and a tap on empty canvas selects none. While Fit stands a
// tap anywhere ends it. VoiceOver hears one element, which says how far the roadmap is and names the Board as the way
// to its steps, or under Fit what a tap does.
struct RoadmapGraphCanvas: View {
  let roadmap: RoadmapModel
  // How far the roadmap is, in the bar's words.
  let progress: String
  // What the gestures under way have given the camera so far: a drag's translation and a pinch's magnification.
  @GestureState private var dragged: CGSize?
  @GestureState private var pinched: Double?

  var body: some View {
    let graph = roadmap.graph
    let (picture, camera, captions) = (graph.picture, graph.camera, graph.captions)
    let selected = roadmap.selected.flatMap { (step: String) -> Int? in picture?.placeOf[UTF16Text(step)] }
    if graph.unseated {
      // A roadmap whose steps cannot be seated has no picture: the room's words for a roadmap it cannot show (10.9).
      ContentUnavailableView {
        Label { Text("Couldn’t load this roadmap").foregroundStyle(RoadmapPalette.ink) } icon: { Image(systemName: "map").foregroundStyle(RoadmapPalette.inkDim) }
      }
    } else {
      GeometryReader { space in
        let bars = space.safeAreaInsets
        GraphSurface(picture: picture, camera: camera, captions: captions, selected: selected, opened: graph.marks, pinched: graph.pinched,
                     pinch: graph.pinch, crowd: graph.crowd) { _ in graph.drew() }
          .gesture(moves)
          .simultaneousGesture(SpatialTapGesture().onEnded { tap in
            if graph.fitted { roadmap.unfit() } else { roadmap.select(graph.step(at: tap.location)) }
          })
          .ignoresSafeArea()
          .accessibilityHidden(true)
          .onChange(of: [space.size.width, space.size.height, bars.top, bars.trailing, bars.bottom, bars.leading], initial: true) {
            graph.resize(Viewport(width: space.size.width + bars.leading + bars.trailing, height: space.size.height + bars.top + bars.bottom),
                         under: Insets(top: bars.top, right: bars.trailing, bottom: bars.bottom, left: bars.leading))
          }
      }.onChange(of: dragged == nil && pinched == nil) { _, still in
        if still { graph.rest() }
      }
        .onDisappear { graph.closed() }
        .sensoryFeedback(trigger: roadmap.selected) { _, selected in selected == nil ? nil : .selection }
        // What VoiceOver hears of the Graph stands over what the bars leave of it, where the picture is framed.
        .overlay {
          Color.clear.allowsHitTesting(false).accessibilityElement().accessibilityLabel("Graph").accessibilityValue(progress)
            .accessibilityHint(graph.fitted ? Text("Brings the bars back.") : Text("The Board lists every step."))
            .accessibilityIdentifier("roadmap-graph")
        }
    }
  }

  // How far a finger goes before a drag begins: the picture keeps still for that much of its way.
  static let slop = 10.0

  // A drag moves the camera by its translation past the slop, so a first report that comes late, carrying more of the
  // finger's way, moves the picture all the same; while a pinch is under way the pinch alone moves the camera, since its
  // fingers drag too.
  var moves: some Gesture {
    DragGesture(minimumDistance: Self.slop).updating($dragged) { drag, last, _ in
      let way = drag.translation, reach = max(hypot(way.width, way.height), Self.slop)
      let from = last ?? CGSize(width: way.width * Self.slop / reach, height: way.height * Self.slop / reach)
      last = way
      if pinched == nil { roadmap.graph.pan(by: CGSize(width: way.width - from.width, height: way.height - from.height)) }
    }.simultaneously(with: MagnifyGesture().updating($pinched) { pinch, last, _ in
      roadmap.graph.zoom(by: pinch.magnification / (last ?? 1), about: pinch.startLocation)
      last = pinch.magnification
    })
  }
}

// The Graph's band slot holding the selected step (Roadmap · iOS 04.2; the kit's Step bar, Selected): the step's state
// symbol in its kind's colour, its name, and the way to its page.
struct GraphStepBar: View {
  let roadmap: RoadmapModel
  let row: RoadmapModel.Row

  var body: some View {
    NavigationLink(value: roadmap.stacked(.step(row.id, by: .graph))) {
      HStack(spacing: 10) {
        Image(systemName: row.card.column.symbol).imageScale(.large).foregroundStyle(RoadmapPalette.kind(row.step.color))
          .accessibilityLabel(row.colour ?? "").accessibilityHidden(row.colour == nil)
        Text(row.name).font(.body.weight(.semibold)).foregroundStyle(RoadmapPalette.ink).lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        DoorChevron(room: .roadmap)
      }
    }.buttonStyle(RoomSecondaryStyle(room: .roadmap)).buttonBorderShape(.capsule).controlSize(.large)
      .padding(.horizontal, RoomSpace.inset).padding(.bottom, RoomSpace.related)
      .accessibilityElement(children: .combine).accessibilityIdentifier("roadmap-graph-step")
  }
}

// The Graph's band slot with no step selected (Roadmap · iOS 04.1, 04.3; the kit's Step bar, Next): *Next* and the first
// Up next step, over a menu of every Up next step in Roadmap Order under their count. A step picked is selected and
// brought to the centre of the canvas.
struct GraphNextBar: View {
  let roadmap: RoadmapModel
  // The Up next steps in Roadmap Order, the first of which the bar names.
  let rows: [RoadmapModel.Row]

  var body: some View {
    glass(Menu {
      Section {
        ForEach(rows) { row in
          Button { roadmap.pick(row) } label: {
            // A menu draws a template symbol in its own ink, so the kind's colour is the image's own.
            Label { Text(row.name) } icon: {
              Image(uiImage: (UIImage(systemName: row.card.column.symbol) ?? UIImage())
                .withTintColor(UIColor(RoadmapPalette.kind(row.step.color)), renderingMode: .alwaysOriginal))
            }
          }
        }
      } header: {
        Text(String(localized: "\(rows.count) up next", locale: .copy, comment: "The title of Next's menu on the Graph: how many steps are Up next"))
          .onAppear { roadmap.nextOpened() }
      }
    } label: {
      HStack(spacing: 10) {
        Text(String(localized: "roadmap.graph.next", defaultValue: "Next",
                    comment: "The Graph's bar, before the name of the first Up next step: the step to take next"))
          .font(.subheadline.weight(.semibold)).foregroundStyle(RoadmapPalette.inkDim)
        Text(rows.first?.name ?? "").font(.body.weight(.semibold)).foregroundStyle(RoadmapPalette.ink).lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        Image(systemName: "chevron.up.chevron.down").imageScale(.small).foregroundStyle(RoadmapPalette.inkDim)
      }
    }.menuOrder(.fixed)).buttonBorderShape(.capsule).controlSize(.large).tint(RoadmapPalette.ink)
      .padding(.horizontal, RoomSpace.inset).padding(.bottom, RoomSpace.related)
      .accessibilityIdentifier("roadmap-graph-next")
  }

  // The system's regular glass, bordered before iOS 26, as the selected step's bar wears it.
  @ViewBuilder func glass(_ menu: some View) -> some View {
    if #available(iOS 26.0, *) { menu.buttonStyle(.glass) }
    else { menu.buttonStyle(.bordered) }
  }
}
