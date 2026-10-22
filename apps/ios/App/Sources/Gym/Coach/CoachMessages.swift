import SwiftUI
import UIKit
import DomainKit
import GymDomain

// Who speaks a bubble: the lifter's are accent and stand at the trailing edge, Coach's are card and stand at the leading.
nonisolated enum CoachSpeaker { case lifter, coach }

// A message bubble, 18 pt round; the last bubble of a group carries a tail at its foot, on its speaker's side.
struct CoachBubbleShape: Shape {
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

// *Today 18:40*, centred over the group of messages it starts.
struct CoachStamp: View {
  let dates: GymDate
  let instant: Instant
  var body: some View {
    (Text(dates.day(instant)).fontWeight(.semibold) + Text(" " + dates.time(instant)))
      .font(.caption).foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity)
  }
}

// The lifter's turn: each photo its own bubble, then the words in the bubble that closes the group, at the trailing edge.
struct CoachQuestion: View {
  let gym: GymModel
  let thread: String
  let text: String
  let attachments: [CoachAttachment]
  var draft: (id: String, data: Data)?
  var uploading = false
  var body: some View {
    VStack(alignment: .trailing, spacing: RoomSpace.small) {
      ForEach(attachments) { attachment in
        let local = draft?.id == attachment.id ? draft?.data : nil
        CoachPhotoView(gym: gym, thread: thread, attachment: attachment, local: local, side: 200)
          .overlay { if uploading, local != nil { ProgressView().accessibilityLabel("Photo upload") } }
      }
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

// Coach's answer: its words, its read receipt, the cards of what it proposed, and the doors to what it wrote.
struct CoachAnswerView: View {
  let gym: GymModel
  let text: String
  let receipt: CoachReceipt?
  let steps: [CoachStep]
  let results: [CoachResult]
  let read: (CoachReading) -> Void
  let notes: () -> Void
  @Environment(\.coachOpenRoutine) var openRoutine
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      let created = results.filter { $0.kind == "routine-created" }
      VStack(alignment: .leading, spacing: 0) {
        if !text.isEmpty { CoachAnswerText(text: text) }
        if let receipt, created.isEmpty { receiptRow(receipt) }
      }
      ForEach(receipt?.proposals ?? [], id: \.self) { id in ProposalCard(gym: gym, id: id) }
      if !created.isEmpty {
        VStack(spacing: 0) {
          ForEach(Array(created.enumerated()), id: \.element.id) { index, result in
            if index > 0 { Divider().overlay(GymPalette.line).padding(.leading, 48) }
            Button {
              gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "open_routine"])
              openRoutine?(result.routineId)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: "checkmark.circle").font(.title3).foregroundStyle(GymPalette.accent)
                GymRow(title: result.routineName, meta: "Routine created" + (result.movementCount.map { " · " + GymCount.of($0, "movement") } ?? ""))
                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(GymPalette.inkFaint)
              }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 14).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Open routine · " + result.routineName)
              .accessibilityIdentifier("coach-created-" + result.operationId)
          }
        }.background(GymPalette.card, in: RoundedRectangle(cornerRadius: 22))
          .overlay(RoundedRectangle(cornerRadius: 22).stroke(GymPalette.line, lineWidth: 1))
      }
      if let receipt, !created.isEmpty { receiptRow(receipt) }
      if let saved = CoachCopy.noteSave(steps) { door("note.text", saved, action: notes).accessibilityIdentifier("coach-saved-note") }
      if let updated = CoachCopy.movementUpdate(steps) {
        GymRow(title: updated, leading: .symbol("pencil", GymPalette.accent)).frame(minHeight: RoomSpace.minimumTarget)
          .accessibilityElement(children: .combine).accessibilityIdentifier("coach-updated-movement")
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  // What Coach wrote besides answering, one row each: its symbol in accent, what it did, and the door to it.
  func door(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      GymRow(title: title, leading: .symbol(symbol, GymPalette.accent), trailing: .door)
        .frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(title)
  }
  // The receipt row, a door to What Coach read while there are workouts to list.
  @ViewBuilder func receiptRow(_ receipt: CoachReceipt) -> some View {
    let reading = CoachReading(receipt, steps: steps, dates: gym.dates)
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

// A photo that opens full size, fitted to its side: a sent one is a bubble 200 pt on its long side, a drafted one 80 pt.
struct CoachPhotoView: View {
  let gym: GymModel
  let thread: String
  let attachment: CoachAttachment
  let local: Data?
  let owner: String?
  let side: CGFloat
  init(gym: GymModel, thread: String, attachment: CoachAttachment, local: Data?, side: CGFloat) {
    self.gym = gym; self.thread = thread; self.attachment = attachment; self.local = local; self.side = side; owner = gym.account
  }
  var size: CGSize {
    guard attachment.width > 0, attachment.height > 0 else { return CGSize(width: side, height: side) }
    let scale = side / CGFloat(max(attachment.width, attachment.height))
    return CGSize(width: CGFloat(attachment.width) * scale, height: CGFloat(attachment.height) * scale)
  }
  var shape: RoundedRectangle { RoundedRectangle(cornerRadius: side > 100 ? 18 : 10, style: .continuous) }
  @State var data: Data?
  @State var loadedOwner: String?
  @State var failed = false
  @State var connectionRequired = false
  @State var enlarged = false
  @Namespace var zoom
  var image: UIImage? {
    guard owner == gym.account, (gym.isAnonymous && !gym.accountTransition && local != nil) || (gym.coachAccountAvailable && (local != nil || loadedOwner == gym.account)) else { return nil }
    return (data ?? local).flatMap(UIImage.init(data:))
  }
  var body: some View {
    Group {
      if let image {
        Button { enlarged = true } label: {
          Image(uiImage: image).resizable().scaledToFill().frame(width: size.width, height: size.height).clipShape(shape)
        }.buttonStyle(.plain).accessibilityLabel("Enlarge photo").matchedTransitionSource(id: attachment.id, in: zoom)
      } else if failed {
        Button { Task { await load() } } label: { tile(Image(systemName: "arrow.clockwise").foregroundStyle(GymPalette.accent)) }
          .buttonStyle(.plain).accessibilityLabel(connectionRequired ? "Photo needs a connection. Retry" : "Photo unavailable. Retry")
      } else { tile(ProgressView()).accessibilityLabel("Reading photo") }
    }.task(id: "\(gym.account ?? ""):\(thread):\(attachment.id)") { data = nil; if local == nil { await load() } }
      .fullScreenCover(isPresented: $enlarged) {
        if let image { CoachPhotoCover(image: image).navigationTransition(.zoom(sourceID: attachment.id, in: zoom)) }
      }
  }
  // The photo's place while it is read or needs a retry.
  func tile(_ content: some View) -> some View { content.frame(width: size.width, height: size.height).background(GymPalette.line, in: shape) }
  func load() async {
    let owner = gym.account; failed = false; connectionRequired = false
    do {
      let loaded = try await CoachFixture.rest(gym).coachRequest("/v1/gym/threads/\(CoachCopy.escaped(thread))/attachments/\(CoachCopy.escaped(attachment.id))", expectedAccount: owner)
      guard owner == gym.account, !gym.accountTransition else { return }
      guard UIImage(data: loaded) != nil else { throw URLError(.cannotDecodeContentData) }
      loadedOwner = owner; data = loaded
    } catch {
      if owner == gym.account, !(error is CancellationError) {
        failed = true; connectionRequired = GymRESTClient.needsConnection(error)
      }
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

// When a conversation's questions were asked, in order, and when the one still on its way was: a question starts a group
// under its time when it is the first, or an hour or more after the one before.
struct CoachStamps {
  let times: [Int64]
  let asked: Int64
  func starts(_ at: Int64) -> Bool {
    guard at > 0, let index = times.firstIndex(of: at) else { return false }
    return index == 0 || at - times[index - 1] >= 3_600_000
  }
}
