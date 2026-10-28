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
  var capabilities: [(String, String)] {
    [("Build", "a program from a screenshot or your own words."), ("Goals", "tell me your goals, and I will plan for them.")]
      + (signedIn ? [("Notes", "I save important facts, like an old injury."), ("Changes", "ask me, and I suggest changes to your routines.")]
         : [("Account", "sign in, and I can also save notes and suggest changes to your routines.")])
  }
  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      CoachBubble(speaker: .coach, tail: false) { Text("Hi, I’m Coach. I can help you with:").accessibilityIdentifier("coach-greeting") }
      CoachBubble(speaker: .coach) {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(capabilities, id: \.0) { anchor, line in Text(anchor).fontWeight(.semibold) + Text(" — " + line) }
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
    (.screenshot, "Add screenshot", "photo.badge.plus"), (.buildManually, "Build my own", "plus"),
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
