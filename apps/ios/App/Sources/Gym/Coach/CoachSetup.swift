import SwiftUI

// The greeting offers Add screenshot and Build my own; the other cases stay so drafts kept by earlier versions still read.
nonisolated enum CoachSetupChoice: String, Codable, CaseIterable {
  case screenshot, describe, goal, justLog = "just_log", buildManually = "build_manually"
  var starter: Bool { self == .screenshot || self == .describe || self == .goal }
}

nonisolated enum CoachSetupEligibility {
  static func shouldOffer(signedIn: Bool, hydrated: Bool, empty: Bool, resolved: Bool,
                          occupied: Bool, hasConversation: Bool, choice: CoachSetupChoice?) -> Bool {
    signedIn && hydrated && empty && resolved && !occupied && !hasConversation && choice == nil
  }
}

// Coach's first word, local and no model turn: two bubbles — who it is, then what it can do, each line led by its anchor
// word — and under them Add screenshot and Build my own. Signed out, the account is the third thing it offers.
struct CoachSetupView: View {
  let signedIn: Bool
  let choose: (CoachSetupChoice) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  // What Coach offers, a line each: its term set semibold, a dash, and what the term means.
  enum Capability {
    case build, goals, notes, changes, account

    var term: Text {
      switch self {
      case .build: Text("Build", comment: "A term in Coach's greeting: building a program")
      case .goals: Text("Goals", comment: "A term in Coach's greeting: the person's goals")
      case .notes: Text("Notes", comment: "The notes Coach keeps: a term in Coach's greeting, a settings row and its screen's title")
      case .changes: Text("Changes", comment: "A term in Coach's greeting: the changes Coach suggests to routines")
      case .account: Text("Account", comment: "A term in Coach's greeting: the person's Windmill account")
      }
    }
    var line: Text {
      let term = self.term.fontWeight(.semibold)
      return switch self {
      case .build: Text("\(term) — a program from a screenshot or your own words.", comment: "Coach's greeting; the placeholder is the term Build")
      case .goals: Text("\(term) — tell me your goals, and I will plan for them.", comment: "Coach's greeting; the placeholder is the term Goals")
      case .notes: Text("\(term) — I save important facts, like an old injury.", comment: "Coach's greeting; the placeholder is the term Notes")
      case .changes: Text("\(term) — ask me, and I suggest changes to your routines.", comment: "Coach's greeting; the placeholder is the term Changes")
      case .account: Text("\(term) — sign in, and I can also save notes and suggest changes to your routines.",
                          comment: "Coach's greeting; the placeholder is the term Account")
      }
    }
  }
  var capabilities: [Capability] { [.build, .goals] + (signedIn ? [.notes, .changes] : [.account]) }
  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      CoachBubble(speaker: .coach, tail: false) { Text("Hi, I’m Coach. I can help you with:").accessibilityIdentifier("coach-greeting") }
      CoachBubble(speaker: .coach) {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(capabilities, id: \.self) { $0.line }
        }
      }.accessibilityElement(children: .combine).accessibilityIdentifier("coach-capabilities")
      Group {
        if typeSize.isAccessibilitySize {
          VStack(alignment: .leading, spacing: RoomSpace.related) { actions }
        } else {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: RoomSpace.related) { actions }
            VStack(alignment: .leading, spacing: RoomSpace.related) { actions }
          }
        }
      }.padding(.top, RoomSpace.related)
    }
  }
  // What the greeting offers under its bubbles, in order; a goal or just logging is never one of them.
  static let choices: [(choice: CoachSetupChoice, title: String, symbol: String)] = [
    (.screenshot, String(localized: "Add screenshot"), "photo.badge.plus"), (.buildManually, String(localized: "Build my own"), "plus"),
  ]
  @ViewBuilder var actions: some View {
    ForEach(Self.choices, id: \.choice) { action in
      Button { choose(action.choice) } label: {
        Label(action.title, systemImage: action.symbol).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
      }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(GymPalette.accent).frame(minHeight: RoomSpace.minimumTarget)
        .accessibilityIdentifier("coach-setup-" + action.choice.rawValue)
    }
  }
}
