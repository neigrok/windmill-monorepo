import SwiftUI

// The room's foot (Roadmap · iOS 02.2, 03.4, 03.6b, 03.9): the one band, a receipt with its Undo or a limit that refused
// a gesture, over the control the screen keeps there. The Board and a step's page stand on the same band.
struct RoadmapFoot<Control: View>: ViewModifier {
  let roadmap: RoadmapModel
  let control: Control

  func body(content: Content) -> some View {
    content.reachBand {
      VStack(spacing: 0) {
        if let band = roadmap.band {
          RoomTransient(message: band.says.words, room: .roadmap, actionTitle: String(localized: "Undo"), actionIdentifier: "roadmap-undo",
                        action: band.undo == nil ? nil : { roadmap.undo() }, dismiss: { roadmap.endBand() },
                        type: .subheadline, actionWeight: .semibold)
            .accessibilityIdentifier("roadmap-band")
        }
        control
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
      return String(localized: "\(RoadmapModel.Row.name(of: step)) deleted", comment: "The band while a step's delete is held: the step's name")
    case .refused(.keepsStartingStep): return String(localized: "A roadmap keeps one starting step")
    case .refused(.full): return String(localized: "This roadmap is at its limit.")
    }
  }
}

// A delete's question (Roadmap · iOS 03.8), on the view that stays on screen once the swipe or the menu that asked has
// closed, a step's Board row or its page's … button: the step's name, what the delete costs, and Delete Step. Closed any
// other way, it deletes nothing.
struct DeleteQuestion: ViewModifier {
  let roadmap: RoadmapModel
  let asked: Bool

  // The question is read as the screen draws, so the screen draws again once it is asked: a Board row the system slid
  // away with its destructive action is back under the question.
  init(roadmap: RoadmapModel, step: String, onPage: Bool) {
    self.roadmap = roadmap
    asked = roadmap.question.map { $0.row.id == step && ($0.door == .page) == onPage } ?? false
  }

  func body(content: Content) -> some View {
    let name = roadmap.question?.row.name ?? ""
    content.confirmationDialog(String(localized: "Delete \(name)?", comment: "The question a step's delete asks, with the step's name"),
                               isPresented: Binding(get: { asked }, set: { if !$0 { roadmap.answer(delete: false) } }), titleVisibility: .visible) {
      Button("Delete Step", role: .destructive) { roadmap.answer(delete: true) }
    } message: {
      Text(Self.cost(followers: roadmap.question?.followers ?? 0))
    }
  }

  // What a delete takes with it: the step alone, and each step that follows it is read through it.
  static func cost(followers: Int) -> String {
    if followers == 0 { return String(localized: "Removes this step") }
    return String(localized: "Removes this step · \(followers) branches resplice", locale: .copy,
                  comment: "A step's delete question: how many steps that follow the step are linked past it")
  }
}

extension View {
  func roadmapFoot(_ roadmap: RoadmapModel, @ViewBuilder _ control: () -> some View) -> some View {
    modifier(RoadmapFoot(roadmap: roadmap, control: control()))
  }
}
