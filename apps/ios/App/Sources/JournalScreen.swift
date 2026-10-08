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
  @State var inkMounted = false
  @State var inkFrames: [String: CGRect] = [:]
  @State var echoHighlight: JournalEchoDestination?
  @State var echoDestination: JournalEchoDestination?
  @State var echoReadyDestination: JournalEchoDestination?
  @State var pendingEchoDestination: JournalEchoDestination?
  @State var echoNavigationAccount: String?
  @State var echoSheetPresented = false
  @AccessibilityFocusState var echoFocus: String?
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.scenePhase) var scenePhase
  @Environment(\.accessibilityReduceMotion) var systemReduceMotion
  @ScaledMetric(relativeTo: .body) var bodySize = 17.0
  @ScaledMetric(relativeTo: .callout) var echoControlWidth = 60.0
  var reduceMotion: Bool { systemReduceMotion || model.runtime?.settings.board?.hasSuffix("-RM") == true }
  var echoAccess: JournalEchoAccess {
    JournalEchoAccess(account: app.account, today: model.today.text,
      available: scenePhase == .active && model.runtime?.engine.status.online == true &&
        !model.authPaused && !model.editorReadOnly && !model.readFailed)
  }
  var echoesVisible: Bool { echoAccess.available && model.echoes.access == echoAccess }
  var body: some View {
    ScrollViewReader { scroll in
      GeometryReader { geo in
        ZStack(alignment: .topLeading) {
          JournalBackdrop()
          VStack(spacing: 0) {
            if !model.compactAccountSheet { header.padding(.horizontal, 16).padding(.top, 6) }
            if echoesVisible && !model.echoes.hops.isEmpty { JournalEchoTrail(echoes: model.echoes) }
            ScrollView {
              VStack(alignment: .leading, spacing: 40) {
                ForEach(model.room?.days.filter { $0.day < model.today } ?? [], id: \.day) { day in
                  VStack(alignment: .leading, spacing: 18) {
                    HStack {
                      Text(date(day.day)).font(Design.mono()).foregroundStyle(Design.dim)
                      Spacer(minLength: 8)
                      echoButton(day.day.text)
                    }.frame(minHeight: 44)
                    pastBody(day.document.body, day: day.day.text, width: geo.size.width - 48)
                    HStack { Text("Mood \(day.document.mood.map(String.init) ?? "–")"); Text("Energy \(day.document.energy.map(String.init) ?? "–")") }.font(Design.mono()).foregroundStyle(Design.dim)
                  }.padding(.horizontal, 24).id("journal-day-\(day.day.text)")
                    .accessibilityElement(children: .contain).accessibilityIdentifier("journal-day-\(day.day.text)")
                }
                today(width: geo.size.width - 48)
                  .padding(.horizontal, 24)
                  .padding(.bottom, focused ? 18 : (model.compactAccountSheet ? 18 : (geo.size.height < 700 ? 12 : 92)) + geo.safeAreaInsets.bottom)
                  .contentShape(Rectangle())
                  .gesture(TapGesture().onEnded {
                    if !model.editorReadOnly && model.sheet == nil && model.echoes.openDay == nil { appendRequest += 1 }
                  }, including: focused ? .all : .subviews)
                  .id("journal-today")
                if echoesVisible && !focused {
                  JournalFirstEcho(echoes: model.echoes) { day in model.echoes.open(day) }
                }
              }
                .padding(.top, typeSize.isAccessibilitySize && model.showPlaceholder ? 430 : 50)
                .frame(minHeight: max(0, geo.size.height + (focused ? 0 : geo.safeAreaInsets.bottom) - 56 - (model.compactAccountSheet ? 350 : 0)), alignment: .bottom)
            }.defaultScrollAnchor(model.compactAccountSheet || (!focused && typeSize.isAccessibilitySize && model.showPlaceholder) ? .top : .bottom).scrollDismissesKeyboard(.interactively)
              .ignoresSafeArea(.container, edges: focused ? [] : .bottom)
              .padding(.bottom, focused ? 44 + 12 : 0)
          }
          inkNotes(origin: geo.frame(in: .global).origin)
        }
      }.onChange(of: model.document.body) { old, new in
        if focused && new == old + "\n" { scroll.scrollTo("journal-today", anchor: .bottom) }
      }.task(id: echoDestination) {
        echoReadyDestination = nil
        guard let destination = echoDestination, validEchoDestination(destination) else { echoHighlight = nil; return }
        focused = false
        echoHighlight = destination
        if destination.text == nil { echoReadyDestination = destination }
      }.task(id: echoReadyDestination) {
        guard let destination = echoReadyDestination, validEchoDestination(destination) else { return }
        let anchor = destination.day == model.today.text ? "journal-today" : destination.text == nil ? "journal-day-\(destination.day)" : "journal-echo-passage"
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.35)) {
          scroll.scrollTo(anchor, anchor: destination.day == model.today.text ? .bottom : .center)
        } completion: {
          if echoDestination == destination && validEchoDestination(destination) { echoFocus = destination.day }
        }
        do { try await Task.sleep(for: .milliseconds(2600)) } catch { return }
        echoHighlight = nil
      }.overlay(alignment: .bottomTrailing) {
        if !model.editorReadOnly && model.sheet == nil && model.echoes.openDay == nil && !model.compactAccountSheet {
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
                if writeRequest == request && !model.editorReadOnly && model.sheet == nil && model.echoes.openDay == nil { focused = true }
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
      if value && model.echoes.openDay != nil { focused = false; return }
      writeRequest += 1
      model.editing = value
      model.choose(value ? "write" : "done_writing", screen: "journal")
      if value { model.liftInk() } else { model.done() }
    }
    .onChange(of: model.editing) { _, value in if !value { focused = false } }
    .onChange(of: model.sheet) { _, _ in writeRequest += 1 }
    .onChange(of: model.editorReadOnly) { _, _ in writeRequest += 1 }
    .onDisappear { writeRequest += 1; model.echoes.suspend() }
    .onChange(of: model.echoBodies, initial: true) { _, bodies in model.echoes.updateBodies(bodies) }
    .onChange(of: model.echoes.destination) { _, destination in
      if !echoSheetPresented, let destination {
        echoNavigationAccount = app.account
        echoDestination = destination
      }
    }
    .task(id: echoAccess) {
      model.echoes.activate(echoAccess)
      model.echoes.updateBodies(model.echoBodies)
      await model.echoes.poll()
    }
    .sheet(isPresented: Binding(get: { echoesVisible && model.echoes.openDay != nil }, set: { if !$0 { model.echoes.openDay = nil } }), onDismiss: {
      echoSheetPresented = false
      echoDestination = pendingEchoDestination
      pendingEchoDestination = nil
    }) {
      if let day = model.echoes.openDay {
        JournalEchoSheet(echoes: model.echoes, day: day) { destination in
          // Preserve the chosen local page across sheet dismissal, even if a refresh fails.
          echoNavigationAccount = app.account
          pendingEchoDestination = destination
        }.environment(\.dynamicTypeSize, typeSize)
          .onAppear { echoSheetPresented = true }
      }
    }
    .task(id: model.inkVisible) {
      if model.inkVisible { inkMounted = true; return }
      try? await Task.sleep(for: .milliseconds(360))
      guard !Task.isCancelled else { return }
      inkMounted = false
    }
    .sensoryFeedback(.success, trigger: model.firstKept)
  }

  func echoButton(_ day: String) -> some View {
    Color.clear.frame(width: echoControlWidth, height: 44).overlay {
      if echoesVisible {
        JournalEchoButton(echoes: model.echoes, day: day, writing: focused || model.sheet != nil || model.echoes.openDay != nil) {
          focused = false; model.liftInk(); model.echoes.open(day)
        }
      }
    }.accessibilityHidden(!echoesVisible || model.echoes.pages[day] == nil)
  }

  func pastBody(_ body: String, day: String, width: CGFloat) -> some View {
    let destination = echoHighlight?.day == day && echoNavigationAccount == app.account ? echoHighlight : nil
    let range = destination.flatMap { destination in
      destination.text.flatMap { JournalEchoMatch(day: day, text: $0, occurrenceHint: destination.occurrenceHint).range(in: body) }
    }
    return JournalBodyText(text: .constant(body), focused: .constant(false), fontSize: bodySize, editable: false,
      highlightedRange: echoesVisible && !model.echoes.hops.isEmpty ? range : nil, day: day)
      .accessibilityFocused($echoFocus, equals: day)
      .frame(height: JournalBodyText.height(for: body, width: width, fontSize: bodySize))
      .overlay(alignment: .topLeading) {
        if let range {
          VStack(spacing: 0) {
            Color.clear.frame(height: JournalBodyText.passageOffset(in: body, range: range, width: width, fontSize: bodySize))
            Color.clear.frame(height: 1).id("journal-echo-passage")
              .onGeometryChange(for: Bool.self) { $0.size.height > 0 } action: { ready in
                if ready, let destination, echoDestination == destination, validEchoDestination(destination) {
                  echoReadyDestination = destination
                }
              }
            Spacer(minLength: 0)
          }.id(destination?.id).allowsHitTesting(false).accessibilityHidden(true)
        }
      }
  }

  func validEchoDestination(_ destination: JournalEchoDestination) -> Bool {
    guard app.account != nil, echoNavigationAccount == app.account else { return false }
    if destination.day == model.today.text { return true }
    guard let body = model.echoBodies[destination.day] else { return false }
    return destination.text.map {
      JournalEchoMatch(day: destination.day, text: $0, occurrenceHint: destination.occurrenceHint).range(in: body) != nil
    } ?? true
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
          HStack(spacing: 6) {
            Text(date(model.editorDay) + (model.words > 0 ? " · \(model.words) \(model.words == 1 ? "WORD" : "WORDS")" : "") + (focused || model.backup.isEmpty ? "" : " · \(model.backup)"))
              .font(Design.mono()).tracking(0.7).foregroundStyle(Design.dim)
            if model.firstKept && model.scalesDue { Image(systemName: "checkmark").font(.system(size: 10)).foregroundStyle(Design.lamp) }
          }.accessibilityElement(children: .combine).accessibilityIdentifier("journal-date").inkAnchor("date", enabled: inkMounted, frames: $inkFrames)
          Spacer(minLength: 8)
          echoButton(model.editorDay.text)
        }.frame(minHeight: 44).padding(.bottom, 16)
        ZStack(alignment: .topLeading) {
          JournalBodyText(text: Binding(get: { model.document.body }, set: { model.type($0) }), focused: $focused, fontSize: bodySize, editable: !model.editorReadOnly, appendRequest: appendRequest, inkVisible: inkMounted && model.inkVisible && !focused && model.sheet == nil)
            .accessibilityFocused($echoFocus, equals: model.today.text)
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
          if !model.editorReadOnly && model.sheet == nil && model.echoes.openDay == nil && !focused { focused = true }
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
  var highlightedRange: NSRange? = nil
  var day: String? = nil

  static func attributes(fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 7
    paragraph.paragraphSpacing = 10
    return [.font: UIFont(name: "Inter-Regular", size: fontSize) ?? .systemFont(ofSize: fontSize), .paragraphStyle: paragraph, .foregroundColor: UIColor(Design.ink)]
  }

  static func height(for text: String, width: CGFloat, fontSize: CGFloat) -> CGFloat {
    (text as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes(fontSize: fontSize), context: nil).height + 8
  }

  static func passageOffset(in text: String, range: NSRange, width: CGFloat, fontSize: CGFloat) -> CGFloat {
    let storage = NSTextStorage(string: text, attributes: attributes(fontSize: fontSize))
    let layout = NSLayoutManager(), container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    layout.addTextContainer(container); storage.addLayoutManager(layout)
    let glyph = layout.glyphRange(forCharacterRange: NSRange(location: range.location, length: 1), actualCharacterRange: nil)
    return layout.boundingRect(forGlyphRange: glyph, in: container).minY
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
    view.accessibilityLabel = day.map { "\(JournalEchoSheet.date($0)), read only" } ?? (editable ? "Today's page" : nil)
    view.accessibilityIdentifier = day.map { "journal-body-\($0)" } ?? (editable ? "journal-editor" : nil)
    context.coordinator.updateText(view, text: text, fontSize: fontSize)
    context.coordinator.updateHighlight(view, range: highlightedRange)
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
    var highlightedRange: NSRange?
    init(_ parent: JournalBodyText) { self.parent = parent }

    func updateText(_ view: UITextView, text: String, fontSize: CGFloat) {
      // Binding publication can reenter with the snapshot from before this keystroke.
      guard !publishingText, view.markedTextRange == nil else { return }
      let textChanged = !(view.text ?? "").utf8.elementsEqual(text.utf8)
      let fontChanged = view.font?.pointSize != fontSize
      guard textChanged || fontChanged else { return }
      let selection = initialized ? view.selectedRange : NSRange(location: text.utf16.count, length: 0)
      if textChanged { view.text = text }
      let attributes = JournalBodyText.attributes(fontSize: fontSize)
      view.font = attributes[.font] as? UIFont
      view.textStorage.setAttributes(attributes, range: NSRange(location: 0, length: view.textStorage.length))
      highlightedRange = nil
      view.typingAttributes = attributes
      let selectionStart = min(selection.location, view.textStorage.length)
      view.selectedRange = NSRange(location: selectionStart, length: min(selection.length, view.textStorage.length - selectionStart))
      initialized = true
    }

    func updateHighlight(_ view: UITextView, range: NSRange?) {
      guard range != highlightedRange else { return }
      view.textStorage.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: view.textStorage.length))
      if let range, range.location >= 0, NSMaxRange(range) <= view.textStorage.length {
        view.textStorage.addAttribute(.backgroundColor, value: UIColor(Design.lamp).withAlphaComponent(0.24), range: range)
        highlightedRange = range
        #if DEBUG && targetEnvironment(simulator)
        (view as? JournalLayoutTextView)?.echoTarget = range
        #endif
      } else { highlightedRange = nil }
    }

    func textViewDidChange(_ textView: UITextView) {
      publishingText = true
      defer { publishingText = false }
      parent.text = textView.text
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
  var echoTarget: NSRange?
  override var accessibilityValue: String? {
    get {
      guard let window, let selection = selectedTextRange else { return nil }
      let caret = convert(caretRect(for: selection.end), to: window)
      let line = convert(lastLineRect, to: window)
      var metrics: [String: Any] = [
        "text": text ?? "",
        "selection": [selectedRange.location, selectedRange.length],
        "textLength": textStorage.length,
        "focused": isFirstResponder,
        "inkVisible": inkVisible,
        "editable": isEditable,
        "caret": [caret.minX, caret.minY, caret.width, caret.height],
        "lastLine": [line.minX, line.minY, line.width, line.height],
      ]
      if let target = echoTarget, NSMaxRange(target) <= textStorage.length,
         let start = position(from: beginningOfDocument, offset: target.location),
         let end = position(from: start, offset: target.length), let range = textRange(from: start, to: end) {
        let rect = convert(firstRect(for: range), to: window)
        metrics["echoRange"] = [target.location, target.length]
        metrics["echoRect"] = [rect.minX, rect.minY, rect.width, rect.height]
        metrics["echoHighlighted"] = textStorage.attribute(.backgroundColor, at: target.location, effectiveRange: nil) != nil
      }
      guard let data = try? JSONSerialization.data(withJSONObject: metrics) else { return nil }
      return String(data: data, encoding: .utf8)
    }
    set { super.accessibilityValue = newValue }
  }
}
#endif
