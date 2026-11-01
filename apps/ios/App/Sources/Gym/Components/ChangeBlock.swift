import SwiftUI
import GymDomain

// The diff language Coach's cards share: each change a block — its kind, what it changes, and one line per field.

extension ProposalDiff.Kind {
  var word: String {
    switch self {
    case .renamed: "Renamed"
    case .moved: "Moved"
    case .changed: "Changed"
    case .removed: "Removed"
    case .added: "Added"
    }
  }
  var symbol: String {
    switch self {
    case .renamed, .changed: "pencil"
    case .moved: "line.3.horizontal"
    case .removed: "minus"
    case .added: "plus"
    }
  }
  // A removal speaks in system red, a move in ink-dim, everything else in the accent.
  var tint: Color {
    switch self {
    case .removed: GymPalette.destructive
    case .moved: GymPalette.inkDim
    default: GymPalette.accent
    }
  }
}

// *CHANGED* over *Bench Press* over its field lines; a removed block strikes its title and dims it, and a dimmed block —
// one that can no longer happen — draws every word in ink-dim.
struct ChangeBlock: View {
  let kind: ProposalDiff.Kind
  let title: String?
  let fields: [ProposalDiff.Field]
  var dimmed = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(kind.word, systemImage: kind.symbol).labelStyle(ChangeBadgeStyle())
        .font(.footnote.weight(.semibold)).textCase(.uppercase).foregroundStyle(kind.tint)
      if let title {
        Text(title).font(.headline).strikethrough(kind == .removed)
          .foregroundStyle(kind == .removed || dimmed ? GymPalette.inkDim : GymPalette.ink)
      }
      ForEach(Array(fields.enumerated()), id: \.offset) { _, field in DiffField(field: field, dimmed: dimmed) }
    }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .combine)
  }
}

// *× Rejected · Push A*: what a rejected card folds to, one quiet line where it stood.
struct RejectedLine: View {
  let subject: String
  var body: some View {
    Label("Rejected · " + subject, systemImage: "xmark").labelStyle(ChangeBadgeStyle())
      .font(.subheadline).foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading)
      .accessibilityElement(children: .combine)
  }
}

struct ChangeBadgeStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) { configuration.icon.imageScale(.small); configuration.title }
  }
}

// *Load  ~~82.5 kg~~ → 90 kg*: the old value struck in ink-dim, the new one semibold; a value that stays is plain ink-dim,
// a new one semibold, a gone one struck. At accessibility sizes the value stands under its label.
struct DiffField: View {
  let field: ProposalDiff.Field
  var dimmed = false
  @ScaledMetric(relativeTo: .body) var labelWidth = 110.0
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 0))
    layout {
      Text(field.label).foregroundStyle(GymPalette.inkDim)
        .frame(width: typeSize.isAccessibilitySize ? nil : labelWidth, alignment: .leading)
      value.frame(maxWidth: .infinity, alignment: .leading)
    }.font(.body).monospacedDigit()
      .accessibilityElement(children: .ignore).accessibilityLabel(spoken)
  }
  var value: Text {
    let old = Text(field.before ?? "").strikethrough().foregroundStyle(GymPalette.inkDim)
    let new = Text(field.after ?? "").fontWeight(.semibold).foregroundStyle(dimmed ? GymPalette.inkDim : GymPalette.ink)
    switch field.state {
    case .changed: return old + Text("  ") + Text(Image(systemName: "arrow.right")).font(.footnote).foregroundStyle(GymPalette.inkFaint) + Text("  ") + new
    case .same: return Text(field.after ?? "").foregroundStyle(GymPalette.inkDim)
    case .new: return new
    case .gone: return old
    }
  }
  var spoken: String {
    switch field.state {
    case .changed: "\(field.label), \(field.before ?? "") to \(field.after ?? "")"
    case .same: "\(field.label), \(field.after ?? "")"
    case .new: "\(field.label), \(field.after ?? "")"
    case .gone: "\(field.label), \(field.before ?? ""), removed"
    }
  }
}

// A card in Coach's conversation, the reading width on the card colour; a card that waits on the lifter carries the
// accent stroke, one that can no longer happen the line's.
struct ChangeCard: ViewModifier {
  var stroke: Color?
  func body(content: Content) -> some View {
    content.padding(RoomSpace.inset).frame(maxWidth: .infinity, alignment: .leading)
      .background(GymPalette.card, in: RoundedRectangle(cornerRadius: RoomSpace.coachCardRadius, style: .continuous))
      .overlay { if let stroke { RoundedRectangle(cornerRadius: RoomSpace.coachCardRadius, style: .continuous).stroke(stroke, lineWidth: 1) } }
  }
}
