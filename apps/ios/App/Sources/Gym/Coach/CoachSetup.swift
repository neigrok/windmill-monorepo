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
  @ViewBuilder var actions: some View {
    ForEach([CoachSetupChoice.screenshot, .buildManually], id: \.self) { choice in
      Button { choose(choice) } label: {
        Label(choice == .screenshot ? "Add screenshot" : "Build my own", systemImage: choice == .screenshot ? "photo.badge.plus" : "plus")
          .font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
      }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(GymPalette.accent).frame(minHeight: RoomSpace.minimumTarget)
        .accessibilityIdentifier("coach-setup-" + choice.rawValue)
    }
  }
}

struct CoachChoicesView: View {
  let coach: CoachConversation
  let clarification: CoachClarification
  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      Text(clarification.question).font(.body)
      ForEach(clarification.groups) { group in
        Text(group.label).font(.subheadline.weight(.semibold)).foregroundStyle(GymPalette.inkDim)
        CoachChoiceLayout {
          ForEach(group.options) { option in
            let selected = coach.saved.choices?.clarificationId == clarification.id && coach.saved.choices?.groups[group.id]?.contains(option.id) == true
            Button { coach.select(option, in: group, clarification: clarification) } label: {
              HStack(spacing: RoomSpace.related) {
                if selected { Image(systemName: "checkmark").font(.caption) }
                Text(option.label).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
              }.foregroundStyle(selected ? GymPalette.accent : GymPalette.ink)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(selected ? GymPalette.accentSoft : GymPalette.card, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(selected ? GymPalette.accent : GymPalette.line, lineWidth: 1))
                .frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
              .accessibilityIdentifier("coach-choice-\(group.id)-\(option.id)")
          }
        }
      }
    }
  }
}

struct CoachChoiceLayout: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? 320
    return arrange(subviews, width: width).size
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let layout = arrange(subviews, width: bounds.width)
    for (index, origin) in layout.origins.enumerated() {
      subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), anchor: .topLeading,
                           proposal: ProposedViewSize(width: min(bounds.width, subviews[index].sizeThatFits(.unspecified).width), height: nil))
    }
  }
  func arrange(_ subviews: Subviews, width: CGFloat) -> (size: CGSize, origins: [CGPoint]) {
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
    var origins: [CGPoint] = []
    for subview in subviews {
      let size = subview.sizeThatFits(ProposedViewSize(width: min(width, subview.sizeThatFits(.unspecified).width), height: nil))
      if x > 0 && x + size.width > width { x = 0; y += rowHeight; rowHeight = 0 }
      origins.append(CGPoint(x: x, y: y)); x += size.width + 8; rowHeight = max(rowHeight, size.height)
    }
    return (CGSize(width: width, height: y + rowHeight), origins)
  }
}
