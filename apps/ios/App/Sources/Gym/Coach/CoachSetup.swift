import SwiftUI

nonisolated enum CoachSetupChoice: String, Codable, CaseIterable {
  case screenshot, describe, goal, justLog = "just_log", buildManually = "build_manually"
  var starter: Bool { self == .screenshot || self == .describe || self == .goal }
  var title: String {
    switch self {
    case .screenshot: "Add a screenshot"
    case .describe: "Describe your program"
    case .goal: "Share your goal"
    case .justLog: "Just log"
    case .buildManually: "Build it myself"
    }
  }
  var symbol: String {
    switch self { case .screenshot: "photo.on.rectangle"; case .describe: "text.alignleft"; case .goal: "target"; default: "" }
  }
  var draft: String {
    switch self {
    case .screenshot: "Turn this program into routines."
    case .describe: "My program: "
    case .goal: "My goal: "
    default: ""
    }
  }
}

nonisolated enum CoachSetupEligibility {
  static func shouldOffer(signedIn: Bool, hydrated: Bool, empty: Bool, resolved: Bool,
                          occupied: Bool, hasConversation: Bool, choice: CoachSetupChoice?) -> Bool {
    signedIn && hydrated && empty && resolved && !occupied && !hasConversation && choice == nil
  }
}

struct CoachSetupView: View {
  @ScaledMetric(relativeTo: .title3) private var symbolWidth = 20
  let choose: (CoachSetupChoice) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      VStack(alignment: .leading, spacing: RoomSpace.related) {
        Text("Set up your routines").font(ShellType.title).accessibilityAddTraits(.isHeader)
        Text("Built from what you bring.").font(.body).foregroundStyle(GymPalette.inkDim)
      }.padding(.horizontal, RoomSpace.related)
      VStack(spacing: 0) {
        ForEach(CoachSetupChoice.allCases.filter(\.starter), id: \.self) { choice in
          if choice != .screenshot { Divider().overlay(GymPalette.line).padding(.leading, 48) }
          Button { choose(choice) } label: {
            HStack(spacing: 12) {
              Image(systemName: choice.symbol).font(.title3).foregroundStyle(GymPalette.accent).frame(width: symbolWidth)
              Text(choice.title).font(.body).foregroundStyle(GymPalette.ink)
              Spacer(minLength: 0)
            }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 14).frame(minHeight: 50).contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityIdentifier("coach-setup-" + choice.rawValue)
        }
      }.background(GymPalette.card, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(GymPalette.line, lineWidth: 1))
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 20) { escapes }
        VStack(alignment: .leading, spacing: 0) { escapes }
      }.padding(.horizontal, RoomSpace.inset)
    }
  }
  @ViewBuilder var escapes: some View {
    ForEach([CoachSetupChoice.justLog, .buildManually], id: \.self) { choice in
      Button(choice.title) { choose(choice) }.font(.subheadline.weight(.semibold))
        .frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("coach-setup-" + choice.rawValue)
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
