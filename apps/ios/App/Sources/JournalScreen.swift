import SwiftUI
import UIKit
import DomainKit
import JournalDomain

struct JournalScreen: View {
  @Bindable var model: JournalModel
  @State var focused = false
  @State var writeRequest = 0
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var systemReduceMotion
  @ScaledMetric(relativeTo: .body) var bodySize = 17.0
  var reduceMotion: Bool { systemReduceMotion || model.runtime?.settings.board?.hasSuffix("-RM") == true }
  var body: some View {
    ScrollViewReader { scroll in
      GeometryReader { geo in
        ZStack(alignment: .topLeading) {
          JournalBackdrop()
          VStack(spacing: 0) {
            if !model.compactAccountSheet { header.padding(.horizontal, 16).padding(.top, 6) }
            ScrollView {
              VStack(alignment: .leading, spacing: 40) {
                ForEach(model.room?.days.filter { $0.day < model.today } ?? [], id: \.day) { day in
                  VStack(alignment: .leading, spacing: 18) {
                    Text(date(day.day)).font(Design.mono()).foregroundStyle(Design.dim)
                    JournalBodyText(text: .constant(day.document.body), focused: .constant(false), fontSize: bodySize, editable: false)
                      .frame(height: JournalBodyText.height(for: day.document.body, width: geo.size.width - 48, fontSize: bodySize))
                    HStack { Text("Mood \(day.document.mood.map(String.init) ?? "–")"); Text("Energy \(day.document.energy.map(String.init) ?? "–")") }.font(Design.mono()).foregroundStyle(Design.dim)
                  }.padding(.horizontal, 24).accessibilityElement(children: .combine).accessibilityLabel("\(date(day.day)), read only. \(day.document.body)")
                }
                today(width: geo.size.width - 48)
                  .padding(.horizontal, 24)
                  .padding(.bottom, focused ? 18 : (model.compactAccountSheet ? 18 : (geo.size.height < 700 ? 12 : 92)) + geo.safeAreaInsets.bottom)
                  .id("journal-today")
              }
                .padding(.top, typeSize.isAccessibilitySize && model.showPlaceholder ? 430 : 50)
                .frame(minHeight: max(0, geo.size.height + (focused ? 0 : geo.safeAreaInsets.bottom) - 56 - (model.compactAccountSheet ? 350 : 0)), alignment: .bottom)
            }.defaultScrollAnchor(model.compactAccountSheet || (!focused && typeSize.isAccessibilitySize && model.showPlaceholder) ? .top : .bottom).scrollDismissesKeyboard(.interactively)
              .ignoresSafeArea(.container, edges: focused ? [] : .bottom)
              .padding(.bottom, focused ? 44 + 12 : 0)
          }
        }
      }.overlay(alignment: .bottomTrailing) {
        if !model.editorReadOnly && model.sheet == nil && !model.compactAccountSheet {
          Button {
            writeRequest += 1
            let request = writeRequest
            if focused { focused = false; return }
            if reduceMotion {
              scroll.scrollTo("journal-today", anchor: .bottom)
              focused = true
            } else {
              withAnimation(.easeOut(duration: 0.48)) {
                scroll.scrollTo("journal-today", anchor: .bottom)
              } completion: {
                if writeRequest == request && !model.editorReadOnly && model.sheet == nil { focused = true }
              }
            }
          } label: {
            Image(systemName: focused ? "checkmark" : "square.and.pencil")
              .contentTransition(reduceMotion ? .opacity : .symbolEffect(.replace))
              .animation(.easeInOut(duration: 0.3), value: focused)
              .font(.system(size: 18)).foregroundStyle(Design.ink)
              .frame(width: 44, height: 44).modifier(Glass(capsule: false))
          }.buttonStyle(.plain)
            .accessibilityLabel(focused ? "Done writing" : "Write")
            .accessibilityHint(focused ? "" : "Opens the keyboard on today's page")
            .accessibilityIdentifier(focused ? "done-writing" : "write-today")
            .padding(.trailing, 16).padding(.bottom, 12)
        }
      }
    }.onAppear { model.screenViewed("journal"); focused = model.editing; model.recordInvitations() }.onChange(of: focused) { _, value in
      writeRequest += 1
      model.editing = value
      model.choose(value ? "write" : "done_writing", screen: "journal")
      if !value { model.done() }
    }
    .onChange(of: model.editing) { _, value in if !value { focused = false } }
    .onChange(of: model.sheet) { _, _ in writeRequest += 1 }
    .onChange(of: model.editorReadOnly) { _, _ in writeRequest += 1 }
    .onDisappear { writeRequest += 1 }
    .sensoryFeedback(.success, trigger: model.firstKept)
  }

  var header: some View {
    HStack {
      roomName
      Spacer()
      Button { focused = false; model.sheet = .you } label: {
        YouGlyph().stroke(Design.ink, lineWidth: 1.5).frame(width: 18, height: 18).frame(width: 44, height: 44).modifier(Glass(capsule: false))
      }.accessibilityLabel("You and settings").accessibilityIdentifier("you")
    }.buttonStyle(.plain).dynamicTypeSize(...DynamicTypeSize.large)
  }

  // The room menu mounts in this seat when the phone carries a second room.
  var roomName: some View {
    Text("Journal").font(Design.strong(17)).foregroundStyle(Design.ink)
      .padding(.leading, 16).padding(.trailing, 14).frame(height: 44)
      .accessibilityAddTraits(.isHeader).accessibilityIdentifier("room-name")
  }

  func today(width: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          Text(date(model.editorDay) + (model.words > 0 ? " · \(model.words) \(model.words == 1 ? "WORD" : "WORDS")" : "") + (focused || model.backup.isEmpty ? "" : " · \(model.backup)"))
            .font(Design.mono()).tracking(0.7).foregroundStyle(Design.dim)
          if model.firstKept && model.scalesDue { Image(systemName: "checkmark").font(.system(size: 10)).foregroundStyle(Design.lamp) }
        }.accessibilityElement(children: .combine).accessibilityIdentifier("journal-date").padding(.bottom, 16)
        ZStack(alignment: .topLeading) {
          JournalBodyText(text: Binding(get: { model.document.body }, set: { model.type($0) }), focused: $focused, fontSize: bodySize, editable: !model.editorReadOnly)
            .frame(height: editorHeight(width: width))
            .allowsHitTesting(focused || model.editorReadOnly)
          if model.document.body.isEmpty && !focused {
            VStack(alignment: .leading, spacing: 14) {
              HStack(alignment: .top, spacing: 3) {
                Rectangle().fill(Design.lamp).frame(width: 1.5, height: bodySize * 1.4)
                if model.showPlaceholder {
                  Text("Start anywhere. Nothing here is graded.").font(.custom("Inter-Regular", fixedSize: bodySize)).lineSpacing(7).foregroundStyle(Design.faint)
                }
              }.accessibilityHidden(true)
              if model.showPrivacy {
                Text("Only you. No prompts, no fields, nothing to fill in — write a line or a page.")
                  .font(Design.text(13)).lineSpacing(3).foregroundStyle(Design.faint)
              }
            }.allowsHitTesting(false)
          }
        }
        if model.showPrivacy && (!model.document.body.isEmpty || focused) {
          Text("Only you. No prompts, no fields, nothing to fill in — write a line or a page.")
            .font(Design.text(13)).lineSpacing(3).foregroundStyle(Design.faint).padding(.top, 14)
        }
      }.padding(.bottom, focused ? 0 : 23)
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        .onTapGesture { if !model.editorReadOnly && model.sheet == nil && !focused { focused = true } }
      if !focused {
        if model.scalesDue {
          HStack {
            Text("How did today feel?").font(Design.strong(14)); Spacer()
            Button("Not now") { model.dismissScales() }.font(Design.text(14)).foregroundStyle(Design.dim).frame(minHeight: 44)
          }.padding(.top, 17)
        }
        VStack(spacing: 0) {
          ScaleRow(name: "Mood", value: model.document.mood) { model.setScale("mood", $0) }
          ScaleRow(name: "Energy", value: model.document.energy) { model.setScale("energy", $0) }
        }.disabled(model.editorReadOnly)
        if model.scalesDue {
          Text("Mood is what you see when you zoom out to the year.").font(Design.text(13)).foregroundStyle(Design.faint).padding(.top, 10)
        }
        if model.keepDue {
          HStack {
            Image(systemName: "iphone").font(.system(size: 14)); Text("Only on this phone").font(Design.text(13)); Spacer()
            Button("Keep it") { model.keep() }.font(Design.strong(14)).foregroundStyle(Design.brand).padding(.horizontal, 16).frame(minHeight: 44).modifier(Glass())
          }.foregroundStyle(Design.dim).padding(.top, 18)
        }
      }
      if let error = model.error {
        Text(error).font(Design.text(13)).foregroundStyle(Design.brand).padding(.top, 12)
        if model.dirty { Button("Try saving again") { model.save() }.frame(minHeight: 44).font(Design.strong(14)) }
      }
    }.foregroundStyle(Design.ink)
  }

  func editorHeight(width: CGFloat) -> CGFloat {
    let text = model.document.body.isEmpty ? "Start anywhere. Nothing here is graded." : model.document.body + " "
    let font = UIFont(name: "Inter-Regular", size: bodySize) ?? .systemFont(ofSize: bodySize)
    return max((font.lineHeight + 7) * 3, JournalBodyText.height(for: text, width: width, fontSize: bodySize))
  }

  func date(_ day: LocalDay) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "EEE d MMM"; f.timeZone = TimeZone(secondsFromGMT: 0)
    return f.string(from: Calendar(identifier: .gregorian).date(from: DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: day.year, month: day.month, day: day.day))!).uppercased()
  }
}

struct JournalBodyText: UIViewRepresentable {
  @Binding var text: String
  @Binding var focused: Bool
  let fontSize: CGFloat
  var editable = true

  static func attributes(fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 7
    paragraph.paragraphSpacing = 10
    return [.font: UIFont(name: "Inter-Regular", size: fontSize) ?? .systemFont(ofSize: fontSize), .paragraphStyle: paragraph, .foregroundColor: UIColor(Design.ink)]
  }

  static func height(for text: String, width: CGFloat, fontSize: CGFloat) -> CGFloat {
    (text as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes(fontSize: fontSize), context: nil).height + 8
  }

  func makeUIView(context: Context) -> UITextView {
    #if DEBUG && targetEnvironment(simulator)
    let view = ProcessInfo.processInfo.arguments.contains("-journal-layout-test") ? JournalLayoutTextView() : UITextView()
    #else
    let view = UITextView()
    #endif
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.tintColor = UIColor(Design.lamp)
    view.isScrollEnabled = false
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.parent = self
    view.isEditable = editable
    view.accessibilityLabel = editable ? "Today's page" : nil
    view.accessibilityIdentifier = editable ? "journal-editor" : nil
    let textChanged = view.text != text
    let fontChanged = view.font?.pointSize != fontSize
    if view.markedTextRange == nil && (textChanged || fontChanged) {
      let selection = context.coordinator.initialized ? view.selectedRange : NSRange(location: text.utf16.count, length: 0)
      if textChanged { view.text = text }
      let attributes = Self.attributes(fontSize: fontSize)
      view.font = attributes[.font] as? UIFont
      view.textStorage.setAttributes(attributes, range: NSRange(location: 0, length: view.textStorage.length))
      view.typingAttributes = attributes
      let selectionStart = min(selection.location, view.textStorage.length)
      view.selectedRange = NSRange(location: selectionStart, length: min(selection.length, view.textStorage.length - selectionStart))
      context.coordinator.initialized = true
    }
    if editable && focused && !view.isFirstResponder {
      view.becomeFirstResponder()
      view.selectedRange = NSRange(location: view.textStorage.length, length: 0)
    }
    if (!editable || !focused) && view.isFirstResponder { view.resignFirstResponder() }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: JournalBodyText
    var initialized = false
    init(_ parent: JournalBodyText) { self.parent = parent }
    func textViewDidChange(_ textView: UITextView) { parent.text = textView.text }
    func textViewDidBeginEditing(_ textView: UITextView) { if !parent.focused { parent.focused = true } }
    func textViewDidEndEditing(_ textView: UITextView) { if parent.focused { parent.focused = false } }
  }
}

#if DEBUG && targetEnvironment(simulator)
final class JournalLayoutTextView: UITextView {
  override var accessibilityValue: String? {
    get {
      guard let window, let selection = selectedTextRange,
            let lastCharacter = position(from: endOfDocument, offset: -1),
            let lastLine = tokenizer.rangeEnclosingPosition(lastCharacter, with: .line,
              inDirection: UITextDirection(rawValue: UITextStorageDirection.backward.rawValue)) else { return nil }
      let caret = convert(caretRect(for: selection.end), to: window)
      let line = convert(firstRect(for: lastLine), to: window)
      let metrics = [
        "caret": [caret.minX, caret.minY, caret.width, caret.height],
        "lastLine": [line.minX, line.minY, line.width, line.height],
      ]
      guard let data = try? JSONSerialization.data(withJSONObject: metrics) else { return nil }
      return String(data: data, encoding: .utf8)
    }
    set { super.accessibilityValue = newValue }
  }
}
#endif
