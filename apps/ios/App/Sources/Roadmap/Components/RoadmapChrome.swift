import SwiftUI
import UIKit
import RoadmapDomain

// The room's foot (Roadmap · iOS 01.8b, 01.11, 02.2, 02.16b, 02.16c, 02.18, 03.4, 03.6b, 03.9, 05.7, 05.10, 09.4, 10.2,
// 10.4): the one band, a receipt with its Undo, a limit that refused a gesture, or what the room tells once, a change that
// met one made elsewhere with Show, over the control the screen keeps there. Every screen of the room stands on the same
// band, the step form too, whose foot is away while one of its fields has the keyboard. The band is drawn only where the
// person can see it (`RoadmapModel.drawsBand`), and a landing line is told as its band is drawn. Every screen of a reader's
// cover stands on Fork.
struct RoadmapFoot<Control: View>: ViewModifier {
  let roadmap: RoadmapModel
  let away: Bool
  // The foot stands in a sheet the room raised, in front of the room's own screens.
  let inSheet: Bool
  let control: Control
  @Environment(\.openURL) private var openURL
  // The cover the screen stands on, for a reader; none in the person's own room.
  @Environment(RoadmapCover.self) private var cover: RoadmapCover?

  func body(content: Content) -> some View {
    content.reachBand {
      VStack(spacing: 0) {
        if roadmap.drawsBand(away: away, inSheet: inSheet), let band = roadmap.band {
          switch band.says {
          case .pasteRefused:
            // 02.16c: a paste not allowed leads to Windmill's page in Settings, where that choice lives.
            RoomTransient(message: band.says.words, room: .roadmap, actionTitle: String(localized: "Settings"), actionIdentifier: "roadmap-settings",
                          action: {
                            roadmap.openedSettings()
                            if let settings = URL(string: UIApplication.openSettingsURLString) { openURL(settings) }
                          }, dismiss: { roadmap.endBand() }, type: .subheadline, actionWeight: .semibold)
              .accessibilityIdentifier("roadmap-band")
          case .landed(let line):
            // 10.2, 10.4: a line is told as its band is drawn, announced once, and opens its step's page.
            RoomTransient(message: band.says.words, room: .roadmap, actionTitle: String(localized: "Show"), actionIdentifier: "roadmap-show",
                          action: { roadmap.showLanded(line) }, dismiss: { roadmap.endBand() }, type: .subheadline, actionWeight: .semibold)
              .accessibilityIdentifier("roadmap-band")
              .onAppear { if roadmap.seen(line) { UIAccessibility.post(notification: .announcement, argument: band.says.words) } }
          default:
            RoomTransient(message: band.says.words, room: .roadmap, actionTitle: String(localized: "Undo"), actionIdentifier: "roadmap-undo",
                          action: band.undo == nil && band.coach == nil ? nil : { roadmap.undo() }, dismiss: { roadmap.endBand() },
                          type: .subheadline, actionWeight: .semibold)
              .accessibilityIdentifier("roadmap-band")
          }
        }
        if !away { control }
        if !away, let cover { ForkFoot(cover: cover) }
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
      return String(localized: "\(RoadmapModel.Row.name(of: step)) deleted", comment: "The band while a delete is held: the name of the step or of the roadmap, a subtask's words, a link's title or a Coach conversation's title")
    case .deletedSteps(let count):
      return String(localized: "\(count) steps deleted", locale: .copy, comment: "The band while a delete of several steps is held: how many")
    case .recolored(let count):
      return String(localized: "\(count) steps recolored", locale: .copy, comment: "The band after several steps are moved to one kind: how many")
    case .removedKind(let name):
      return String(localized: "\(name) removed", comment: "The band after a kind no step wears is removed: the kind's name")
    case .created(let step, let group):
      return String(localized: "\(RoadmapModel.Row.name(of: step)) added · \(group.title)",
                    comment: "The band after a step is made: the step's name, and the group it landed in")
    case .saved(let step):
      return String(localized: "\(RoadmapModel.Row.name(of: step)) saved", comment: "The band after a step's changes are saved: the step's name")
    case .savedGuide(let cleared):
      return cleared ? String(localized: "Guide removed", comment: "The band after a roadmap's guide is saved blank")
        : String(localized: "Guide saved", comment: "The band after a roadmap's guide is saved")
    case .deletedRoadmap(let title):
      return String(localized: "\(ListedRoadmap.name(of: title)) deleted", comment: "The band while a delete is held: the name of the step or of the roadmap, a subtask's words, a link's title or a Coach conversation's title")
    case .forked(let steps):
      return String(localized: "Forked · \(steps) steps planted", locale: .copy, comment: "The band once a fork's copy opens: how many steps it planted")
    case .unforked(let offline):
      return offline ? String(localized: "Forking needs a connection.") : String(localized: "Couldn’t fork this roadmap. Try again.")
    case .checked(_, let label):
      return String(localized: "\(label) checked", comment: "The band after a subtask is checked: the subtask's words")
    case .deletedFromWorkspace(let name), .deletedConversation(let name):
      return String(localized: "\(name) deleted", comment: "The band while a delete is held: the name of the step or of the roadmap, a subtask's words, a link's title or a Coach conversation's title")
    case .planted(let steps, let done):
      if done == 0 { return String(localized: "Roadmap planted · \(steps) steps", locale: .copy, comment: "The band once a roadmap is planted from a plan: how many steps it holds") }
      return String(localized: "Roadmap planted · \(steps) steps · \(done) already done", locale: .copy,
                    comment: "The band once a roadmap is planted from a plan: how many steps it holds, and how many of them the plan brought done")
    case .added(let steps):
      return String(localized: "Added \(steps) steps", locale: .copy, comment: "The band once steps pasted into a roadmap are added: how many")
    case .noText: return String(localized: "No text to paste", comment: "The band when Paste Steps finds no text on the clipboard")
    case .pasteRefused: return String(localized: "Paste not allowed", comment: "The band when the system was not allowed to hand Paste Steps the copied text")
    case .attached: return String(localized: "Roadmap attached")
    case .detached(let markBack):
      return markBack ? String(localized: "Roadmap detached · your mark is back") : String(localized: "Roadmap detached")
    case .refused(.keepsStartingStep): return String(localized: "A roadmap keeps one starting step")
    case .refused(.full): return String(localized: "This roadmap is at its limit.")
    case .landed(let line): return line.band
    case .coachWrote(let receipt): return CoachReceiptLine.words(receipt)
    case .coachUndone: return CoachReceiptLine.undone
    // An Undo that brought nothing back (02.10d, 06.5c): a delete names what could not come back, one thing by its name
    // and several steps by their count, and any other act could not be undone.
    case .unrestored(.deletedSteps(let count)):
      return String(localized: "Couldn’t bring back \(count) steps", locale: .copy, comment: "The band after an Undo of a delete of several steps brought none back: how many")
    case .unrestored(let receipt):
      let lost: String? = switch receipt {
      case .deleted(let step): RoadmapModel.Row.name(of: step)
      case .deletedRoadmap(let title): ListedRoadmap.name(of: title)
      case .removedKind(let name), .deletedFromWorkspace(let name), .deletedConversation(let name): name
      default: nil
      }
      guard let lost else { return String(localized: "Couldn’t undo", comment: "The band after an Undo that brought nothing back of an act that is not a delete") }
      return String(localized: "Couldn’t bring back \(lost)",
                    comment: "The band after an Undo of a delete brought nothing back: the name of the step, the roadmap or the kind, or a subtask's words or a link's title")
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

// The delete question of several steps (Roadmap · iOS 02.10b), on the bottom toolbar's Delete N Steps, which stays on
// screen: how many steps, what the delete costs, and Delete N Steps. Closed any other way, it deletes nothing.
struct DeleteStepsQuestion: ViewModifier {
  let roadmap: RoadmapModel
  let asked: (steps: Int, followers: Int)?

  init(roadmap: RoadmapModel) {
    self.roadmap = roadmap
    guard case .steps(let rows, let followers) = roadmap.question else {
      asked = nil
      return
    }
    asked = (rows.count, followers)
  }

  func body(content: Content) -> some View {
    let steps = asked?.steps ?? 0
    return content.confirmationDialog(String(localized: "Delete \(steps) steps?", locale: .copy, comment: "The question a delete of several steps asks: how many"),
                                      isPresented: Binding(get: { asked != nil }, set: { if !$0 { roadmap.answer(delete: false) } }), titleVisibility: .visible) {
      Button(Self.delete(steps), role: .destructive) { roadmap.answer(delete: true) }
    } message: {
      Text(Self.cost(steps: steps, followers: asked?.followers ?? 0))
    }
  }

  // The bottom toolbar's button and the question's answer: Delete N Steps.
  static func delete(_ steps: Int) -> String {
    String(localized: "Delete \(steps) Steps", locale: .copy, comment: "The button that deletes the steps chosen, and the answer of its question: how many")
  }

  // What the delete takes with it: the steps, and each step outside them that follows one is read past it.
  static func cost(steps: Int, followers: Int) -> String {
    if followers == 0 { return String(localized: "Removes \(steps) steps", locale: .copy, comment: "A delete of several steps: how many it removes") }
    return String(localized: "Removes \(steps) steps · \(followers) branches resplice", locale: .copy,
                  comment: "A delete of several steps: how many it removes, and how many steps that follow them are linked past them")
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
  func roadmapFoot(_ roadmap: RoadmapModel, away: Bool = false, inSheet: Bool = false, @ViewBuilder _ control: () -> some View) -> some View {
    modifier(RoadmapFoot(roadmap: roadmap, away: away, inSheet: inSheet, control: control()))
  }
}
