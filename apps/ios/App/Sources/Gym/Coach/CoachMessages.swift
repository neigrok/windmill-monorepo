import SwiftUI
import UIKit
import DomainKit
import GymDomain
import SyncSchema

// Who speaks a bubble: the lifter's are accent and stand at the trailing edge, Coach's are card and stand at the leading.
nonisolated enum CoachSpeaker { case lifter, coach }

// A message bubble, 18 pt round; the last bubble of a group carries a tail at its foot, on its speaker's side.
nonisolated struct CoachBubbleShape: Shape {
  let speaker: CoachSpeaker
  let tail: Bool
  func path(in rect: CGRect) -> SwiftUI.Path {
    let path = SwiftUI.Path(roundedRect: rect, cornerRadius: 18, style: .continuous)
    guard tail else { return path }
    var hook = SwiftUI.Path()
    let trailing = speaker == .lifter
    let edge = trailing ? rect.maxX : rect.minX, out: CGFloat = trailing ? 1 : -1
    hook.move(to: CGPoint(x: edge - out * 8, y: rect.maxY - 16))
    hook.addQuadCurve(to: CGPoint(x: edge + out * 5, y: rect.maxY), control: CGPoint(x: edge - out * 1, y: rect.maxY - 3))
    hook.addQuadCurve(to: CGPoint(x: edge - out * 14, y: rect.maxY - 3), control: CGPoint(x: edge - out * 4, y: rect.maxY + 1))
    hook.closeSubpath()
    return path.union(hook)
  }
}

struct CoachBubble<Content: View>: View {
  let speaker: CoachSpeaker
  var tail = true
  var fullWidth = false
  @ViewBuilder let content: Content
  var body: some View {
    let lifter = speaker == .lifter
    content.padding(.horizontal, 12).padding(.vertical, 8)
      .foregroundStyle(lifter ? GymPalette.onAccent : GymPalette.ink)
      .frame(maxWidth: fullWidth ? .infinity : nil, alignment: .leading)
      .background(lifter ? GymPalette.accent : GymPalette.card, in: CoachBubbleShape(speaker: speaker, tail: tail))
      .frame(maxWidth: .infinity, alignment: lifter ? .trailing : .leading)
      .containerRelativeFrame(.horizontal, alignment: lifter ? .trailing : .leading) { length, _ in fullWidth ? length - 2 * RoomSpace.inset : length * 0.78 }
      .frame(maxWidth: .infinity, alignment: lifter ? .trailing : .leading)
  }
}

// Coach is typing: three dots in Coach's bubble, where its answer will grow.
struct CoachTyping: View {
  var body: some View {
    CoachBubble(speaker: .coach) {
      Image(systemName: "ellipsis").font(.title3.weight(.bold)).foregroundStyle(GymPalette.inkDim)
        .symbolEffect(.variableColor.iterative.dimInactiveLayers.nonReversing, options: .repeat(.continuous))
        .frame(minHeight: 20)
    }.accessibilityElement().accessibilityLabel("Coach is thinking").accessibilityIdentifier("coach-typing")
  }
}

// The lifter's turn: each photo its own bubble, then the words in the bubble that closes the group, at the trailing edge.
struct CoachQuestion: View {
  let gym: GymModel
  let text: String
  let pictures: [Picture]
  var draft: (CoachAttachment, Data)?
  var body: some View {
    VStack(alignment: .trailing, spacing: RoomSpace.small) {
      ForEach(pictures, id: \.id) { picture in CoachPhotoView(gym: gym, id: picture.id, side: 200) }
      if let draft { CoachPhotoView(gym: gym, id: draft.0.id, side: 200, local: (draft.0, draft.1)) }
      if !text.isEmpty {
        CoachBubble(speaker: .lifter) { Text(text).textSelection(.enabled) }
          .contextMenu { Button("Copy question") { UIPasteboard.general.string = text } }
      }
    }.frame(maxWidth: .infinity, alignment: .trailing)
  }
}

// Coach's words: plain prose a bubble per paragraph, an answer with headings, lists or tables one bubble the full width.
struct CoachAnswerText: View {
  let text: String
  var body: some View {
    let blocks = CoachMarkdown.blocks(text)
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      if blocks.contains(where: \.rich) {
        CoachBubble(speaker: .coach, fullWidth: true) { CoachMarkdown(blocks: blocks) }
      } else {
        ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
          CoachBubble(speaker: .coach, tail: index == blocks.count - 1) { CoachMarkdown(blocks: [block]) }
        }
      }
    }.contextMenu { Button("Copy answer") { UIPasteboard.general.string = text } }
      .accessibilityElement(children: .combine).accessibilityIdentifier("coach-answer")
  }
}

// What one answer read, as its receipt row and What Coach read say it (Coach §9.2): the workouts its calls served, by
// identity, the weeks they fall in, and whether it read notes, movement history, or nothing.
struct CoachReading: Identifiable {
  struct Workout: Identifiable {
    let id: String
    let title: String
    let meta: String
    let available: Bool
  }
  let id = UUID()
  let workouts: [Workout]
  let weeks: Int
  let notes: Bool
  let nothing: Bool
  let stats: Bool
  init(calls: [AbilityCall], gym: GymModel) {
    var served = ReadServed()
    for call in calls where call.outcome == .ok { served.saw(call.read) }
    let sessions = served.sessions.compactMap { id in gym.sessions.first { $0.id == id } }.sorted { $0.startedAt > $1.startedAt }
    workouts = sessions.map { session in
      let readout = gym.log?.readout(session: session.id)
      let facts = readout.map { [GymCount.of($0.workingSetCount, "working set"), Readout.weight($0.volumeKg) + " kg"] } ?? []
      return Workout(id: session.id.description, title: readout?.name ?? session.displayName ?? Readout.noRoutine,
                     meta: ([gym.dates.subtitle(session.startedAt)] + facts).joined(separator: " · "), available: true)
    }
    weeks = served.weeks.count
    notes = calls.contains { $0.name == "list_notes" && $0.outcome == .ok }
    nothing = served.isEmpty
    stats = calls.contains { $0.name == "get_stats" && $0.outcome == .ok }
  }
  var count: String { GymCount.of(workouts.count, "workout") + " · " + GymCount.of(weeks, "week") }
  // The receipt row: what the sheet lists, else what it read in words with no number; none when it read what no line can say.
  var line: String? {
    if !workouts.isEmpty { return "Read " + count }
    if nothing { return "Read nothing from your log" }
    return stats ? "Read your movement history" : nil
  }
}

// What an answer's calls wrote, read from the records they created: the routines, the note, the proposals.
struct CoachWrites {
  let routines: [Routine]
  let notes: [Note]
  let proposals: [String]
  init(calls: [AbilityCall], gym: GymModel) {
    let created = calls.filter { $0.outcome == .ok }.flatMap(\.created)
    routines = created.filter { $0.type == Routine.type }.compactMap { ref in gym.routines.first { $0.id.record == ref.id } }
    notes = created.filter { $0.type == Note.type }.compactMap { ref in gym.notes.first { $0.id.record == ref.id } }
    proposals = created.filter { $0.type == Proposal.type }.map { $0.id.description }
  }
}

// Coach's answer: its words as they stream and once they stand, its read receipt, the cards of what it proposed, and the
// cards of what it wrote; a turn that ended short of an answer says so in the words the room has for it.
struct CoachAnswerView: View {
  let gym: GymModel
  let message: CoachMessage
  // Signed out, the newest answer whose call needed the account offers Sign in under it.
  var offersSignIn = false
  var signIn: () -> Void = {}
  let read: (CoachReading) -> Void
  let notes: () -> Void
  @Environment(\.coachOpenRoutine) var openRoutine
  @Environment(\.coachKeepRoutines) var keepRoutines
  var body: some View {
    let writes = CoachWrites(calls: message.calls, gym: gym)
    let ended = message.state.isTerminal
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 0) {
        if message.text.isEmpty, !ended { CoachTyping() }
        if !message.text.isEmpty { CoachAnswerText(text: message.text) }
        if ended, writes.routines.isEmpty { receiptRow }
      }
      if ended, offersSignIn, message.calls.contains(where: { $0.outcome == .refused(.seatRequired) }) {
        Button(action: signIn) { Text("Sign in").frame(maxWidth: .infinity) }.buttonStyle(ChangeCardButtonStyle(prominent: true))
          .accessibilityIdentifier("coach-sign-in")
      }
      ForEach(writes.proposals, id: \.self) { id in ProposalCard(gym: gym, id: id).id(ProposalCard.anchor(id)) }
      if !writes.routines.isEmpty {
        // One receipt per routine created, each a door to its summary and Start.
        VStack(spacing: 0) {
          ForEach(writes.routines, id: \.id) { routine in
            Button {
              gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "open_routine"])
              openRoutine?(routine.id.description)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: "checkmark.circle").font(.title3).foregroundStyle(GymPalette.ink)
                GymRow(title: routine.name, meta: "Routine created · " + GymCount.of(routine.entries.count, "movement"))
                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(GymPalette.inkFaint)
              }.padding(.vertical, 10).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Open routine · " + routine.name)
              .accessibilityIdentifier("coach-created-" + routine.id.description)
          }
        }.modifier(ChangeCard())
        // Signed out, the routines a turn created live on this phone alone until the lifter keeps them with an account.
        if gym.isAnonymous, let keepRoutines {
          Button { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "keep_routines"]); keepRoutines() } label: {
            Label("Only on this phone · Keep it", systemImage: "iphone").font(.footnote).frame(minHeight: RoomSpace.minimumTarget)
          }.buttonStyle(.plain).accessibilityIdentifier("coach-keep-routines")
        }
      }
      if ended, !writes.routines.isEmpty { receiptRow }
      ForEach(writes.notes, id: \.id) { note in
        Button(action: notes) { writeCard("Saved a note", symbol: "square.and.pencil", lines: [note.title, note.body], door: true) }.buttonStyle(.plain)
          .accessibilityElement(children: .combine).accessibilityAddTraits(.isButton)
          .accessibilityIdentifier("coach-saved-note")
      }
      if let ending = Self.ending(message) {
        Text(ending).font(.footnote).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("coach-ending")
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  // A turn that did not complete, in the room's existing words for the nearest state: an interruption or a stop, and a
  // decline in the words a refused signed-out answer had.
  static func ending(_ message: CoachMessage) -> String? {
    switch message.state {
    case .failed, .interrupted: CoachCopy.interrupted
    case .stopped: CoachCopy.stopped
    case .declined: CoachCopy.refusal("model_refused")
    case .running, .completed: nil
    }
  }
  // What Coach wrote besides answering, one card each with no buttons: its symbol in accent and what it did, the record's
  // own lines under it, and the door's chevron where the card opens what it wrote.
  func writeCard(_ title: String, symbol: String, lines: [String], door: Bool = false) -> some View {
    HStack(spacing: RoomSpace.related) {
      VStack(alignment: .leading, spacing: RoomSpace.small) {
        Label { Text(title).foregroundStyle(GymPalette.ink) } icon: { Image(systemName: symbol).foregroundStyle(GymPalette.accent) }
          .font(.headline)
        ForEach(Array(lines.filter { !$0.isEmpty }.enumerated()), id: \.offset) { index, line in
          Text(line).font(index == 0 ? .subheadline.weight(.semibold) : .subheadline).foregroundStyle(index == 0 ? GymPalette.ink : GymPalette.inkDim).lineLimit(3)
        }
      }
      Spacer(minLength: 0)
      if door { DoorChevron(room: .gym) }
    }.contentShape(Rectangle()).modifier(ChangeCard())
  }
  // The receipt row, a door to What Coach read while there are workouts to list.
  @ViewBuilder var receiptRow: some View {
    let reading = CoachReading(calls: message.calls, gym: gym)
    if let line = reading.line {
      let row = HStack(spacing: RoomSpace.related) {
        Label(line, systemImage: "book.closed")
        Spacer(minLength: 0)
        if !reading.workouts.isEmpty { DoorChevron(room: .gym) }
      }.font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim).frame(minHeight: RoomSpace.minimumTarget)
      if reading.workouts.isEmpty { row.accessibilityElement(children: .ignore).accessibilityLabel(line).accessibilityIdentifier("coach-read-receipt") }
      else {
        Button { read(reading) } label: { row.contentShape(Rectangle()) }.buttonStyle(.plain)
          .accessibilityLabel(line).accessibilityIdentifier("coach-read-receipt")
      }
    }
  }
}

// Coach's Markdown: paragraphs with inline emphasis, headings, bullet or numbered lists, tables and code, each block a
// blank line apart.
struct CoachMarkdown: View {
  enum Block {
    case paragraph(String), heading(String), list([String]), table([[String]]), code(String)
    var rich: Bool { if case .paragraph = self { false } else { true } }
  }
  let blocks: [Block]

  static func blocks(_ text: String) -> [Block] {
    text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .newlines) }.filter { !$0.isEmpty }.map { block in
      let lines = block.components(separatedBy: "\n")
      if block.hasPrefix("```") { return .code(block.replacingOccurrences(of: "```", with: "").trimmingCharacters(in: .newlines)) }
      if block.hasPrefix("#") { return .heading(String(block.drop(while: { $0 == "#" || $0 == " " }))) }
      if lines.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).hasPrefix("|") }) {
        let rows = lines.map { line in
          line.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "|")).components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        }
        return .table(rows.filter { row in !row.allSatisfy { $0.allSatisfy { "-: ".contains($0) } } })
      }
      let items = lines.map { item($0) }
      if items.allSatisfy({ $0 != nil }) { return .list(items.compactMap { $0 }) }
      return .paragraph(block)
    }
  }
  // A list item's words: *- x*, *• x* or *1. x*.
  static func item(_ line: String) -> String? {
    let line = line.trimmingCharacters(in: .whitespaces)
    for marker in ["- ", "* ", "• "] where line.hasPrefix(marker) { return String(line.dropFirst(marker.count)) }
    guard let dot = line.firstIndex(of: "."), !line[..<dot].isEmpty, line[..<dot].allSatisfy(\.isNumber) else { return nil }
    return String(line[line.index(after: dot)...]).trimmingCharacters(in: .whitespaces)
  }
  static func inline(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        switch block {
        case .paragraph(let text): Text(Self.inline(text)).textSelection(.enabled)
        case .heading(let text): Text(Self.inline(text)).font(.headline).accessibilityAddTraits(.isHeader)
        case .code(let text): Text(text).font(.body.monospaced()).textSelection(.enabled)
        case .list(let items):
          VStack(alignment: .leading, spacing: RoomSpace.small) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
              HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) { Text("•"); Text(Self.inline(item)) }
            }
          }
        case .table(let rows): table(rows)
        }
      }
    }
  }
  // A table on the ground inside the bubble: its header small and dim, its cells in monospaced digits, a hairline between rows.
  func table(_ rows: [[String]]) -> some View {
    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
        if index > 0 { Divider().overlay(GymPalette.line) }
        GridRow {
          ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
            Text(Self.inline(cell)).font(index == 0 ? .caption.weight(.semibold) : .footnote.monospacedDigit())
              .foregroundStyle(index == 0 ? GymPalette.inkDim : GymPalette.ink)
          }
        }.padding(.vertical, 8)
      }
    }.padding(.horizontal, 10).background(GymPalette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

// A photo that opens full size, fitted to its side: a sent one is a bubble 200 pt on its long side, a drafted one 80 pt. A
// sent picture is held on the phone that sent it (Coach §9.3); another phone draws its place and that it is unavailable.
struct CoachPhotoView: View {
  let gym: GymModel
  let id: String
  let side: CGFloat
  var local: (CoachAttachment, Data)?
  @State var enlarged = false
  @Namespace var zoom
  var row: CoachPictureRow? {
    guard local == nil else { return nil }
    return CoachPictureRow(id: id, json: try? gym.runner.read(Gym.scope) { try $0.device(CoachPictureRow.key(id)) })
  }
  var attachment: CoachAttachment? { local?.0 ?? row?.attachment }
  var image: UIImage? { (local?.1 ?? row?.original).flatMap(UIImage.init(data:)) }
  var size: CGSize {
    guard let attachment, attachment.width > 0, attachment.height > 0 else { return CGSize(width: side, height: side) }
    let scale = side / CGFloat(max(attachment.width, attachment.height))
    return CGSize(width: CGFloat(attachment.width) * scale, height: CGFloat(attachment.height) * scale)
  }
  var shape: RoundedRectangle { RoundedRectangle(cornerRadius: side > 100 ? 18 : 10, style: .continuous) }
  var body: some View {
    Group {
      if let image {
        Button { enlarged = true } label: {
          Image(uiImage: image).resizable().scaledToFill().frame(width: size.width, height: size.height).clipShape(shape)
        }.buttonStyle(.plain).accessibilityLabel("Enlarge photo").matchedTransitionSource(id: id, in: zoom)
      } else {
        Image(systemName: "photo").foregroundStyle(GymPalette.inkDim).frame(width: size.width, height: size.height).background(GymPalette.line, in: shape)
          .accessibilityLabel("Photo unavailable")
      }
    }.fullScreenCover(isPresented: $enlarged) {
      if let image { CoachPhotoCover(image: image).navigationTransition(.zoom(sourceID: id, in: zoom)) }
    }
  }
}

// A photo full screen on black, zoomed from its thumbnail: pinch or double-tap to zoom, drag to look around, swipe down to close.
struct CoachPhotoCover: View {
  let image: UIImage
  @State var scale: CGFloat = 1
  @State var offset: CGSize = .zero
  @GestureState var pinch: CGFloat = 1
  @GestureState var drag: CGSize = .zero
  @Environment(\.dismiss) var dismiss
  var body: some View {
    let zoomed = scale > 1
    Image(uiImage: image).resizable().scaledToFit()
      .scaleEffect(max(1, scale * pinch))
      .offset(x: offset.width + (zoomed ? drag.width : 0), y: offset.height + (zoomed ? drag.height : max(0, drag.height)))
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(GymPalette.photoGround)
      .contentShape(Rectangle())
      .gesture(MagnifyGesture().updating($pinch) { value, pinch, _ in pinch = value.magnification }.onEnded { value in
        scale = min(4, max(1, scale * value.magnification)); if scale == 1 { offset = .zero }
      })
      .simultaneousGesture(DragGesture().updating($drag) { value, drag, _ in drag = value.translation }.onEnded { value in
        if zoomed { offset.width += value.translation.width; offset.height += value.translation.height }
        else if value.translation.height > 120 || value.predictedEndTranslation.height > 320 { dismiss() }
      })
      .onTapGesture(count: 2) { withAnimation { scale = zoomed ? 1 : 2; offset = .zero } }
      .animation(.spring, value: drag == .zero)
      .ignoresSafeArea().statusBarHidden()
      .accessibilityElement().accessibilityLabel("Photo").accessibilityAddTraits(.isImage)
      .accessibilityAction(.escape) { dismiss() }.accessibilityAction(named: "Close") { dismiss() }
      .accessibilityIdentifier("coach-photo-cover")
  }
}

// When a conversation's questions were asked, in order: a question starts a group under its time when it is the first, or
// an hour or more after the one before.
struct CoachStamps {
  let times: [Int64]
  func starts(_ at: Int64) -> Bool {
    guard at > 0, let index = times.firstIndex(of: at) else { return false }
    return index == 0 || at - times[index - 1] >= 3_600_000
  }
}
