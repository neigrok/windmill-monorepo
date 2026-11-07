import SwiftUI
import GymDomain

// The diff language Coach's cards share: each change a block — its kind, what it changes, and one line per field. A
// proposal draws it with stock parts (08.2P): the kind's circled symbol leading the movement, LabeledContent fields and its
// decisions in one row. The drafts card, a made movement and the workout receipt keep the block with its kind word.

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
  // The circled symbol that says the kind before a proposal's movement.
  var badge: String {
    switch self {
    case .renamed, .changed: "pencil.circle.fill"
    case .moved: "arrow.up.arrow.down.circle.fill"
    case .removed: "minus.circle.fill"
    case .added: "plus.circle.fill"
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

extension ProposalDiff.Field {
  // *~~82.5 kg~~ → 90 kg*: the old value struck in ink-dim, the new one semibold; a value that stays is plain ink-dim, a new
  // one semibold, a gone one struck.
  func value(dimmed: Bool) -> Text {
    let old = Text(before ?? "").strikethrough().foregroundStyle(GymPalette.inkDim)
    let new = Text(after ?? "").fontWeight(.semibold).foregroundStyle(dimmed ? GymPalette.inkDim : GymPalette.ink)
    switch state {
    case .changed: return old + Text("  ") + Text(Image(systemName: "arrow.right")).font(.footnote).foregroundStyle(GymPalette.inkFaint) + Text("  ") + new
    case .same: return Text(after ?? "").foregroundStyle(GymPalette.inkDim)
    case .new: return new
    case .gone: return old
    }
  }
  var spoken: String {
    switch state {
    case .changed: "\(label), \(before ?? "") to \(after ?? "")"
    case .same, .new: "\(label), \(after ?? "")"
    case .gone: "\(label), \(before ?? ""), removed"
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

// *× Rejected · Push A*: what a rejected card folds to, one quiet line where it stood; a proposal's takes the circled
// symbol its card's symbols rhyme with (08.13P).
struct RejectedLine: View {
  let subject: String
  var symbol = "xmark"
  var body: some View {
    Label("Rejected · " + subject, systemImage: symbol).labelStyle(ChangeBadgeStyle())
      .font(.subheadline).foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget, alignment: .leading)
      .accessibilityElement(children: .combine)
  }
}

struct ChangeBadgeStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) { configuration.icon.imageScale(.small); configuration.title }
  }
}

// *Load  ~~82.5 kg~~ → 90 kg* in a fixed label column. At accessibility sizes the value stands under its label.
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
      field.value(dimmed: dimmed).frame(maxWidth: .infinity, alignment: .leading)
    }.font(.body).monospacedDigit()
      .accessibilityElement(children: .ignore).accessibilityLabel(field.spoken)
  }
}

// A proposal's change (08.2P, 02L.9P): its movement led by the kind's circled symbol, a rename — which has no movement —
// titled by its word, and the kind said to VoiceOver. A removed change strikes its title; a dimmed one, out of date, draws
// every word and symbol in ink-dim.
struct ChangeTitle: View {
  let kind: ProposalDiff.Kind
  let title: String?
  var dimmed = false
  var body: some View {
    Label {
      Text(title ?? kind.word).strikethrough(kind == .removed)
        .foregroundStyle(kind == .removed || dimmed ? GymPalette.inkDim : GymPalette.ink)
    } icon: {
      Image(systemName: kind.badge).foregroundStyle(dimmed ? GymPalette.inkDim : kind.tint)
    }.labelStyle(SymbolColumnStyle())
      .accessibilityElement(children: .ignore).accessibilityLabel(title.map { kind.word + ", " + $0 } ?? kind.word)
  }
}

// A label whose symbol keeps a column of its own, so what stands under its title lines up with the title.
struct SymbolColumnStyle: LabelStyle {
  @ScaledMetric(relativeTo: .body) var column = 32.0
  func makeBody(configuration: Configuration) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 0) { configuration.icon.frame(width: column, alignment: .leading); configuration.title }
  }
}

// A field of a proposal's change: its label, then its value trailing. In the sheet's Form it is the Form's own row; on the
// card (`.card`) the label is ink-dim, the line subheadline, and at accessibility sizes the value stands under its label.
struct ProposalField: View {
  let field: ProposalDiff.Field
  var dimmed = false
  var body: some View {
    LabeledContent { field.value(dimmed: dimmed) } label: { dimmed ? Text(field.label).foregroundStyle(GymPalette.inkDim) : Text(field.label) }
      .monospacedDigit()
      .accessibilityElement(children: .ignore).accessibilityLabel(field.spoken)
  }
}

struct CardFieldStyle: LabeledContentStyle {
  func makeBody(configuration: Configuration) -> some View { Field(configuration: configuration) }

  struct Field: View {
    let configuration: LabeledContentStyleConfiguration
    @Environment(\.dynamicTypeSize) var typeSize
    var body: some View {
      let stacked = typeSize.isAccessibilitySize
      let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.inset))
      layout {
        configuration.label.foregroundStyle(GymPalette.inkDim)
        if !stacked { Spacer(minLength: 0) }
        configuration.content.multilineTextAlignment(stacked ? .leading : .trailing)
      }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

extension LabeledContentStyle where Self == CardFieldStyle {
  static var card: CardFieldStyle { CardFieldStyle() }
}

// A proposal card's head (08.2P): its symbol, then the routine over the count. Every state keeps the shape; only the
// symbol and the words change. Out of date, the reason stands under the title as a line of its own.
struct ProposalHeading: View {
  let symbol: String
  let tint: Color
  let title: String
  var dimmed = false
  var subtitle: String?
  var reason: String?
  var bounce = false
  // The card's identifier, which the head and the reason extend; the head's value is the word its card stands on.
  let identifier: String
  let value: String
  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.headline).foregroundStyle(dimmed ? GymPalette.inkDim : GymPalette.ink)
          if let subtitle { Text(subtitle).font(.subheadline).foregroundStyle(GymPalette.inkDim) }
        }.accessibilityElement(children: .combine).accessibilityIdentifier(identifier + "-header").accessibilityValue(value)
        if let reason {
          Text(reason).font(.subheadline).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier(identifier + "-out-of-date")
        }
      }
    } icon: {
      Image(systemName: symbol).font(.title3).foregroundStyle(tint).symbolEffect(.bounce, value: bounce).accessibilityHidden(true)
    }.labelStyle(SymbolColumnStyle())
  }
}

// A card in Coach's conversation, the reading width on the card colour; a card that waits on the lifter carries the
// accent stroke, one that can no longer happen the line's.
struct ChangeCard: ViewModifier {
  var stroke: Color?
  func body(content: Content) -> some View {
    content.padding(RoomSpace.inset).frame(maxWidth: .infinity, alignment: .leading)
      .background(GymPalette.card, in: .card)
      .overlay { if let stroke { RoundedRectangle.card.stroke(stroke, lineWidth: 1) } }
  }
}

// A proposal on Coach's canvas (08.2P): a GroupBox on the card colour at the room's radius, with no stroke. Its head stands
// first in its content: drawn as the GroupBox's label, the accessibility tree held it twice.
struct ProposalBoxStyle: GroupBoxStyle {
  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 0) { configuration.content }
      .padding(RoomSpace.inset).frame(maxWidth: .infinity, alignment: .leading).background(GymPalette.card, in: .card)
  }
}

// A card's decisions under what it says (C.1): large capsules, 10 pt apart and 16 pt below the content, each label taking
// the card's width. Apply is the room's primary, Reject and a removal its secondary.
struct CardDecisions<Decisions: View>: View {
  @ViewBuilder let decisions: Decisions

  var body: some View {
    VStack(spacing: 10) { decisions }
      .font(.headline).controlSize(.large).buttonBorderShape(.capsule).padding(.top, RoomSpace.inset)
  }
}

// A proposal's decisions in one row under its changes (08.2P): Reject, then Apply under the right thumb. At accessibility
// sizes, where the row cannot hold both, Apply stands over Reject. The two layouts are chosen by the text size rather
// than measured, so only the drawn pair is ever in the accessibility tree.
struct DecisionRow<Reject: View, Apply: View>: View {
  @ViewBuilder let reject: Reject
  @ViewBuilder let apply: Apply
  @Environment(\.dynamicTypeSize) var typeSize

  var body: some View {
    Group {
      if typeSize.isAccessibilitySize { VStack(spacing: 10) { apply; reject } }
      else { HStack(spacing: 10) { reject; apply } }
    }.font(.headline).controlSize(.large).buttonBorderShape(.capsule).padding(.top, RoomSpace.related)
  }
}
