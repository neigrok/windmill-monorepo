import SwiftUI
import UIKit
import DomainKit
import JournalDomain

struct JournalScreen: View {
  @Bindable var model: JournalModel
  let app: AppModel
  @State var focused = false
  @State var writeRequest = 0
  @State var appendRequest = 0
  @State var editedBodyAtEnd: String?
  @State var inkMounted = false
  @State var inkFrames: [String: CGRect] = [:]
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
                  .contentShape(Rectangle())
                  .gesture(TapGesture().onEnded {
                    if !model.editorReadOnly && model.sheet == nil { appendRequest += 1 }
                  }, including: focused ? .all : .subviews)
                  .id("journal-today")
              }
                .padding(.top, typeSize.isAccessibilitySize && model.showPlaceholder ? 430 : 50)
                .frame(minHeight: max(0, geo.size.height + (focused ? 0 : geo.safeAreaInsets.bottom) - 56 - (model.compactAccountSheet ? 350 : 0)), alignment: .bottom)
            }.defaultScrollAnchor(model.compactAccountSheet || (!focused && typeSize.isAccessibilitySize && model.showPlaceholder) ? .top : .bottom).scrollDismissesKeyboard(.interactively)
              .ignoresSafeArea(.container, edges: focused ? [] : .bottom)
              .padding(.bottom, focused ? 44 + 12 : 0)
          }
          inkNotes(origin: geo.frame(in: .global).origin)
        }
      }.onChange(of: model.document.body) { _, new in
        if focused && editedBodyAtEnd == new { scroll.scrollTo("journal-today", anchor: .bottom) }
        editedBodyAtEnd = nil
      }.overlay(alignment: .bottomTrailing) {
        if !model.editorReadOnly && model.sheet == nil && !model.compactAccountSheet {
          Button {
            model.liftInk()
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
            .inkAnchor("write", enabled: inkMounted, frames: $inkFrames)
            .padding(.trailing, 16).padding(.bottom, 12)
        }
      }
    }.simultaneousGesture(TapGesture().onEnded { model.liftInk() })
      .onAppear { model.screenViewed("journal"); focused = model.editing; model.recordInvitations() }.onChange(of: focused) { _, value in
      writeRequest += 1
      model.editing = value
      model.choose(value ? "write" : "done_writing", screen: "journal")
      if value { model.liftInk() } else { model.done() }
    }
    .onChange(of: model.editing) { _, value in if !value { focused = false } }
    .onChange(of: model.sheet) { _, _ in writeRequest += 1 }
    .onChange(of: model.editorReadOnly) { _, _ in writeRequest += 1 }
    .onDisappear { writeRequest += 1 }
    .task(id: model.inkVisible) {
      if model.inkVisible { inkMounted = true; return }
      try? await Task.sleep(for: .milliseconds(360))
      guard !Task.isCancelled else { return }
      inkMounted = false
    }
    .sensoryFeedback(.success, trigger: model.firstKept)
  }

  @ViewBuilder func inkNotes(origin: CGPoint) -> some View {
    if inkMounted {
      InkNotes(frames: inkFrames.mapValues { $0.offsetBy(dx: -origin.x, dy: -origin.y) }, visible: model.inkVisible && !focused && model.sheet == nil)
        .allowsHitTesting(false)
    }
  }

  var header: some View {
    HStack {
      RoomSeat(app: app).inkAnchor("title", enabled: inkMounted, frames: $inkFrames)
        .simultaneousGesture(TapGesture().onEnded { model.liftInk() })
      Spacer()
      AccountButton(app: app).inkAnchor("you", enabled: inkMounted, frames: $inkFrames)
    }.buttonStyle(.plain).dynamicTypeSize(...DynamicTypeSize.large)
  }

  func today(width: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          Text(date(model.editorDay) + (model.words > 0 ? " · \(model.words) \(model.words == 1 ? "WORD" : "WORDS")" : "") + (focused || model.backup.isEmpty ? "" : " · \(model.backup)"))
            .font(Design.mono()).tracking(0.7).foregroundStyle(Design.dim)
          if model.firstKept && model.scalesDue { Image(systemName: "checkmark").font(.system(size: 10)).foregroundStyle(Design.lamp) }
        }.accessibilityElement(children: .combine).accessibilityIdentifier("journal-date").inkAnchor("date", enabled: inkMounted, frames: $inkFrames).padding(.bottom, 16)
        ZStack(alignment: .topLeading) {
          JournalBodyText(text: Binding(get: { model.document.body }, set: { model.type($0) }), focused: $focused, fontSize: bodySize, editable: !model.editorReadOnly, appendRequest: appendRequest, inkVisible: inkMounted && model.inkVisible && !focused && model.sheet == nil, didEditAtEnd: { editedBodyAtEnd = $0 })
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
                  .font(Design.text(13)).lineSpacing(3).foregroundStyle(Design.faint).inkAnchor("privacy", enabled: inkMounted, frames: $inkFrames)
              }
            }.allowsHitTesting(false)
          }
        }.inkAnchor("caret", enabled: inkMounted, frames: $inkFrames)
        if model.showPrivacy && (!model.document.body.isEmpty || focused) {
          Text("Only you. No prompts, no fields, nothing to fill in — write a line or a page.")
            .font(Design.text(13)).lineSpacing(3).foregroundStyle(Design.faint).inkAnchor("privacy", enabled: inkMounted, frames: $inkFrames).padding(.top, 14)
        }
      }.padding(.bottom, focused ? 0 : 23)
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        .gesture(TapGesture().onEnded {
          if !model.editorReadOnly && model.sheet == nil && !focused { focused = true }
        }, including: focused ? .subviews : .all)
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
  var appendRequest = 0
  var inkVisible = false
  var didEditAtEnd: (String?) -> Void = { _ in }

  static func attributes(fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 7
    paragraph.paragraphSpacing = 10
    return [.font: UIFont(name: "Inter-Regular", size: fontSize) ?? .systemFont(ofSize: fontSize), .paragraphStyle: paragraph, .foregroundColor: UIColor(Design.ink)]
  }

  static func height(for text: String, width: CGFloat, fontSize: CGFloat) -> CGFloat {
    (text as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes(fontSize: fontSize), context: nil).height + 8
  }

  func makeUIView(context: Context) -> JournalEditorView {
    #if DEBUG && targetEnvironment(simulator)
    let view = ProcessInfo.processInfo.arguments.contains("-journal-layout-test") ? JournalLayoutTextView() : JournalTextView()
    #else
    let view = JournalTextView()
    #endif
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.tintColor = UIColor(Design.lamp)
    view.isScrollEnabled = false
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return JournalEditorView(textView: view)
  }

  func updateUIView(_ editor: JournalEditorView, context: Context) {
    let view = editor.textView
    context.coordinator.parent = self
    view.isEditable = editable
    view.inkVisible = inkVisible
    // Unfocused taps belong to the page, before keyboard layout moves the text view.
    editor.isUserInteractionEnabled = focused || !editable
    view.accessibilityLabel = editable ? "Today's page" : nil
    view.accessibilityIdentifier = editable ? "journal-editor" : nil
    context.coordinator.updateText(view, text: text, fontSize: fontSize)
    if editable && focused && (!view.isFirstResponder || context.coordinator.appendRequest != appendRequest) {
      view.becomeFirstResponder()
      view.selectedRange = NSRange(location: view.textStorage.length, length: 0)
    }
    context.coordinator.appendRequest = appendRequest
    if (!editable || !focused) && view.isFirstResponder { view.resignFirstResponder() }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: JournalBodyText
    var initialized = false
    var publishingText = false
    var appendRequest = 0
    init(_ parent: JournalBodyText) { self.parent = parent }

    func updateText(_ view: UITextView, text: String, fontSize: CGFloat) {
      // Binding publication can reenter with the snapshot from before this keystroke.
      guard !publishingText, view.markedTextRange == nil else { return }
      let textChanged = view.text != text
      let fontChanged = view.font?.pointSize != fontSize
      guard textChanged || fontChanged else { return }
      let selection = initialized ? view.selectedRange : NSRange(location: text.utf16.count, length: 0)
      if textChanged { view.text = text }
      let attributes = JournalBodyText.attributes(fontSize: fontSize)
      view.font = attributes[.font] as? UIFont
      view.textStorage.setAttributes(attributes, range: NSRange(location: 0, length: view.textStorage.length))
      view.typingAttributes = attributes
      let selectionStart = min(selection.location, view.textStorage.length)
      view.selectedRange = NSRange(location: selectionStart, length: min(selection.length, view.textStorage.length - selectionStart))
      initialized = true
    }

    func textViewDidChange(_ textView: UITextView) {
      publishingText = true
      defer { publishingText = false }
      // Native selection distinguishes end edits from insertions into repeated text.
      let selection = textView.selectedRange
      let text = textView.text ?? ""
      parent.didEditAtEnd(textView.isFirstResponder && selection.length == 0 && selection.location == textView.textStorage.length ? text : nil)
      parent.text = text
    }
    func textViewDidBeginEditing(_ textView: UITextView) { if !parent.focused { textView.resignFirstResponder() } }
    func textViewDidEndEditing(_ textView: UITextView) { if parent.focused { parent.focused = false } }
  }
}

final class JournalEditorView: UIView, UIGestureRecognizerDelegate {
  let textView: JournalTextView
  let appendArea = UIView()
  let appendTap = UITapGestureRecognizer()

  init(textView: JournalTextView) {
    self.textView = textView
    super.init(frame: .zero)
    addSubview(textView)
    addSubview(appendArea)
    appendArea.accessibilityElementsHidden = true
    appendTap.addTarget(self, action: #selector(appendAtEnd))
    appendTap.delegate = self
    appendArea.addGestureRecognizer(appendTap)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    appendArea.frame = bounds
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard isUserInteractionEnabled, !isHidden, alpha > 0.01, self.point(inside: point, with: event) else { return nil }
    let textPoint = convert(point, to: textView)
    if textView.isEditable && textPoint.y >= textView.lastLineRect.maxY {
      return appendArea.hitTest(convert(point, to: appendArea), with: event)
    }
    return textView.hitTest(textPoint, with: event)
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                         shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    gestureRecognizer === appendTap && otherGestureRecognizer is UITapGestureRecognizer
  }

  @objc func appendAtEnd() {
    guard isUserInteractionEnabled, textView.isEditable else { return }
    textView.becomeFirstResponder()
    textView.selectedTextRange = textView.textRange(from: textView.endOfDocument, to: textView.endOfDocument)
  }
}

class JournalTextView: UITextView {
  var inkVisible = false
  var lastLineRect: CGRect {
    let lastCharacter = position(from: endOfDocument, offset: -1) ?? endOfDocument
    guard let lastLine = tokenizer.rangeEnclosingPosition(lastCharacter, with: .line,
      inDirection: UITextDirection(rawValue: UITextStorageDirection.backward.rawValue)) else { return caretRect(for: endOfDocument) }
    return firstRect(for: lastLine)
  }
}

#if DEBUG && targetEnvironment(simulator)
final class JournalLayoutTextView: JournalTextView {
  override var accessibilityValue: String? {
    get {
      guard let window, let selection = selectedTextRange else { return nil }
      let caret = convert(caretRect(for: selection.end), to: window)
      let line = convert(lastLineRect, to: window)
      let metrics: [String: Any] = [
        "text": text ?? "",
        "selection": [selectedRange.location, selectedRange.length],
        "textLength": textStorage.length,
        "focused": isFirstResponder,
        "inkVisible": inkVisible,
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
