import SwiftUI
import RoadmapDomain
import RoadmapLayout

// The Graph (Roadmap · iOS 04.1, 04.2, 04.4): the open roadmap's picture on one Canvas, which runs under the room's
// bars. One finger pans and a pinch zooms about the point it began at; a tap selects the step it lands on, by its disc
// or by a 44 pt target where the disc is smaller, and a tap on empty canvas selects none. The canvas draws again only
// when the picture, the camera, the captions or the selection change. VoiceOver hears one element, which says how far
// the roadmap is and names the Board as the way to its steps.
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
        Canvas { context, _ in
          guard let picture, let camera else { return }
          GraphDrawing(picture: picture, camera: camera, captions: captions, selected: selected).draw(in: &context)
          graph.drew()
        }.gesture(moves)
          .simultaneousGesture(SpatialTapGesture().onEnded { tap in roadmap.select(graph.step(at: tap.location)) })
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
            .accessibilityHint("The Board lists every step.").accessibilityIdentifier("roadmap-graph")
        }
    }
  }

  // A drag moves the camera by what it adds to its translation, from its first report on; while a pinch is under way
  // the pinch alone moves the camera, since its fingers drag too.
  var moves: some Gesture {
    DragGesture().updating($dragged) { drag, last, _ in
      let from = last ?? drag.translation
      last = drag.translation
      if pinched == nil { roadmap.graph.pan(by: CGSize(width: drag.translation.width - from.width, height: drag.translation.height - from.height)) }
    }.simultaneously(with: MagnifyGesture().updating($pinched) { pinch, last, _ in
      roadmap.graph.zoom(by: pinch.magnification / (last ?? 1), about: pinch.startLocation)
      last = pinch.magnification
    })
  }
}

// The Graph's band slot holding the selected step (Roadmap · iOS 04.2; the kit's Step bar, Selected): the step's state
// symbol in its kind's colour, its name, and the way to its page.
struct GraphStepBar: View {
  let row: RoadmapModel.Row

  var body: some View {
    NavigationLink(value: RoadmapModel.Visit.step(row.id, by: .graph)) {
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
