import SwiftUI

// The greeting offers Add screenshot and Build myself; the other cases stay so drafts kept by earlier versions still read.
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

struct CoachSetupView: View {
  let choose: (CoachSetupChoice) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      Text("I’m Coach. I can help you plan training and understand your log. Tell me what you’re working on, or share a routine.")
        .font(.body).accessibilityIdentifier("coach-greeting")
      if typeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: RoomSpace.related) { actions }
      } else {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: RoomSpace.related) { actions }
          VStack(alignment: .leading, spacing: RoomSpace.related) { actions }
        }
      }
    }
  }
  @ViewBuilder var actions: some View {
    ForEach([CoachSetupChoice.screenshot, .buildManually], id: \.self) { choice in
      Button { choose(choice) } label: {
        Label(choice == .screenshot ? "Add screenshot" : "Build myself", systemImage: choice == .screenshot ? "photo.badge.plus" : "plus")
          .font(.subheadline).fixedSize(horizontal: false, vertical: true)
          .frame(minHeight: RoomSpace.minimumTarget)
      }.buttonStyle(.borderless).accessibilityIdentifier("coach-setup-" + choice.rawValue)
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
