import SwiftUI
import RoadmapDomain

// The room's foot (Roadmap · iOS 01.11, 02.2, 03.4, 03.6b, 03.9, 05.7, 05.10): the one band, a receipt with its Undo or a
// limit that refused a gesture, over the control the screen keeps there. Every screen of the room stands on the same
// band, the step form too, whose foot is away while one of its fields has the keyboard.
struct RoadmapFoot<Control: View>: ViewModifier {
  let roadmap: RoadmapModel
  let away: Bool
  let control: Control

  func body(content: Content) -> some View {
    content.reachBand {
      VStack(spacing: 0) {
        if !away, let band = roadmap.band {
          RoomTransient(message: band.says.words, room: .roadmap, actionTitle: String(localized: "Undo"), actionIdentifier: "roadmap-undo",
                        action: band.undo == nil ? nil : { roadmap.undo() }, dismiss: { roadmap.endBand() },
                        type: .subheadline, actionWeight: .semibold)
            .accessibilityIdentifier("roadmap-band")
        }
        if !away { control }
      }.roomMotion(roadmap.band)
    }
  }
}

// What the band says, in the boards' words over what the model tells of the act. A step completed on its own page is
// named by the page, so its band says what opened.
extension RoadmapModel.Band.Says {
  var words: String {
    switch self {
    case .completed(let step, let upNext, let inPlace):
      let done = RoadmapModel.Row.name(of: step)
      if upNext.isEmpty { return String(localized: "\(done) done", comment: "The band after a step is completed: the step's name") }
      let first = RoadmapModel.Row.name(of: upNext[0])
      if inPlace && upNext.count == 1 {
        return String(localized: "\(first) is up next", comment: "The band after a step is completed on its page: the one step it brought up next")
      }
      if inPlace {
        return String(localized: "\(upNext.count) steps up next", locale: .copy,
                      comment: "The band after a step is completed on its page: how many steps it brought up next")
      }
      if upNext.count == 1 {
        return String(localized: "\(done) done · \(first) up next", locale: .copy,
                      comment: "The band after a step is completed: the step's name, and the one step it brought up next")
      }
      return String(localized: "\(done) done · \(upNext.count) up next", locale: .copy,
                    comment: "The band after a step is completed: the step's name, and how many steps it brought up next")
    case .reset(let step, let locked):
      if locked == 0 { return String(localized: "\(RoadmapModel.Row.name(of: step)) reset", comment: "The band after a step is reset: the step's name") }
      return String(localized: "\(locked) steps locked again", locale: .copy,
                    comment: "The band after a step is reset: how many steps it returned to Locked")
    case .deleted(let step):
      return String(localized: "\(RoadmapModel.Row.name(of: step)) deleted", comment: "The band while a delete is held: the name of the step or of the roadmap")
    case .created(let step, let group):
      return String(localized: "\(RoadmapModel.Row.name(of: step)) added · \(group.title)",
                    comment: "The band after a step is made: the step's name, and the group it landed in")
    case .saved(let step):
      return String(localized: "\(RoadmapModel.Row.name(of: step)) saved", comment: "The band after a step's changes are saved: the step's name")
    case .deletedRoadmap(let title):
      return String(localized: "\(ListedRoadmap.name(of: title)) deleted", comment: "The band while a delete is held: the name of the step or of the roadmap")
    case .refused(.keepsStartingStep): return String(localized: "A roadmap keeps one starting step")
    case .refused(.full): return String(localized: "This roadmap is at its limit.")
    }
  }
}

// A step's delete question (Roadmap · iOS 03.8), on the view that stays on screen once the swipe or the menu that asked
// has closed, a step's Board row, its page's … button or its form's Delete Step: the step's name, what the delete costs,
// and Delete Step. Closed any other way, it deletes nothing.
struct DeleteQuestion: ViewModifier {
  let roadmap: RoadmapModel
  let asked: (name: String, followers: Int)?

  // The question is read as the screen draws, so the screen draws again once it is asked: a Board row the system slid
  // away with its destructive action is back under the question. `doors` are the gestures this view asks by.
  init(roadmap: RoadmapModel, step: String, by doors: [RoadmapModel.Door]) {
    self.roadmap = roadmap
    guard case .step(let row, let door, let followers) = roadmap.question, row.id == step, doors.contains(door) else {
      asked = nil
      return
    }
    asked = (row.name, followers)
  }

  func body(content: Content) -> some View {
    content.confirmationDialog(String(localized: "Delete \(asked?.name ?? "")?", comment: "The question a delete asks, with the name of the step or of the roadmap"),
                               isPresented: Binding(get: { asked != nil }, set: { if !$0 { roadmap.answer(delete: false) } }), titleVisibility: .visible) {
      Button("Delete Step", role: .destructive) { roadmap.answer(delete: true) }
    } message: {
      Text(Self.cost(followers: asked?.followers ?? 0))
    }
  }

  // What a delete takes with it: the step alone, and each step that follows it is read through it.
  static func cost(followers: Int) -> String {
    if followers == 0 { return String(localized: "Removes this step") }
    return String(localized: "Removes this step · \(followers) branches resplice", locale: .copy,
                  comment: "A step's delete question: how many steps that follow the step are linked past it")
  }
}

// A roadmap's delete question (Roadmap · iOS 01.10), on the view that stays on screen once the title menu or the swipe
// that asked has closed, the Board or the roadmap's row in All Roadmaps: the roadmap's name, what else goes, and Delete
// Roadmap. Closed any other way, it deletes nothing.
struct DeleteRoadmapQuestion: ViewModifier {
  let roadmap: RoadmapModel
  let asked: (name: String, openers: RoadmapModel.Openers?)?

  // `row` is the roadmap whose row in All Roadmaps this is; none on the Board, whose title menu asks of the open roadmap.
  init(roadmap: RoadmapModel, row: String?) {
    self.roadmap = roadmap
    guard case .roadmap(let listed, let place, let openers) = roadmap.question, row.map({ place == .list && $0 == listed.id }) ?? (place == .menu) else {
      asked = nil
      return
    }
    asked = (listed.name, openers)
  }

  func body(content: Content) -> some View {
    content.confirmationDialog(String(localized: "Delete \(asked?.name ?? "")?", comment: "The question a delete asks, with the name of the step or of the roadmap"),
                               isPresented: Binding(get: { asked != nil }, set: { if !$0 { roadmap.answer(delete: false) } }), titleVisibility: .visible) {
      Button("Delete Roadmap", role: .destructive) { roadmap.answer(delete: true) }
    } message: {
      if let openers = asked?.openers { Text(Self.cost(openers)) }
    }
  }

  // What else goes, in the web's sentences with roadmap for its tree: the steps of the person's other roadmaps that open
  // this one, and the roadmaps that hold them, the first two by name.
  static func cost(_ openers: RoadmapModel.Openers) -> String {
    let names = openers.roadmaps.map { (title: String?) -> String in ListedRoadmap.name(of: title) }
    if names.count == 1 && openers.steps == 1 {
      return String(localized: "Also removes the step that opens it in \(names[0])", comment: "A roadmap's delete question: the one roadmap whose one step opens it")
    }
    if names.count == 1 {
      return String(localized: "Also removes \(openers.steps) steps that open it in \(names[0])", locale: .copy,
                    comment: "A roadmap's delete question: how many steps open it, and the one roadmap that holds them")
    }
    if names.count == 2 {
      return String(localized: "Also removes \(openers.steps) steps that open it, in \(names[0]) and \(names[1])", locale: .copy,
                    comment: "A roadmap's delete question: how many steps open it, and the two roadmaps that hold them")
    }
    return String(localized: "Also removes \(openers.steps) steps that open it, in \(names[0]), \(names[1]) and \(names.count - 2) more roadmaps", locale: .copy,
                  comment: "A roadmap's delete question: how many steps open it, the first two roadmaps that hold them, and how many more roadmaps do")
  }
}

extension View {
  func roadmapFoot(_ roadmap: RoadmapModel, away: Bool = false, @ViewBuilder _ control: () -> some View) -> some View {
    modifier(RoadmapFoot(roadmap: roadmap, away: away, control: control()))
  }
}
