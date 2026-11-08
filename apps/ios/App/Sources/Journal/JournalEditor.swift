import SwiftUI
import UIKit

struct JournalBodyText: UIViewRepresentable {
  @Binding var text: String
  @Binding var focused: Bool
  let fontSize: CGFloat
  var editable = true
  var appendRequest = 0
  var inkVisible = false
  var didEditAtEnd: (String?) -> Void = { _ in }
  var highlightedRange: NSRange? = nil
  var day: String? = nil
  // Today's page keeps room for this many lines, measured as if a next line had begun; an earlier page keeps none.
  var minimumLines = 0
  // Today's page rides the keyboard with its own bar: the count, and Done.
  var writingBar = false
  var wordCount: String? = nil
  static let placeholder = "Start anywhere."

  static func attributes(fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = JournalType.lineSpacing
    paragraph.paragraphSpacing = 10
    return [.font: JournalType.bodyFont(size: fontSize), .paragraphStyle: paragraph, .foregroundColor: JournalPalette.uiInk]
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

  // The page sizes itself to its words at the width it is offered.
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: JournalEditorView, context: Context) -> CGSize? {
    guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
    guard minimumLines > 0 else { return CGSize(width: width, height: Self.height(for: text, width: width, fontSize: fontSize)) }
    let floor = (JournalType.bodyFont(size: fontSize).lineHeight + JournalType.lineSpacing) * CGFloat(minimumLines)
    return CGSize(width: width, height: max(floor, Self.height(for: text.isEmpty ? Self.placeholder : text + " ", width: width, fontSize: fontSize)))
  }

  func makeUIView(context: Context) -> JournalEditorView {
    #if DEBUG && targetEnvironment(simulator)
    let view = ProcessInfo.processInfo.arguments.contains("-journal-layout-test") ? JournalLayoutTextView() : JournalTextView()
    #else
    let view = JournalTextView()
    #endif
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.tintColor = JournalPalette.uiLamp
    view.isScrollEnabled = false
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    if writingBar { view.inputAccessoryView = JournalWritingBar { [weak coordinator = context.coordinator] in coordinator?.parent.focused = false } }
    return JournalEditorView(textView: view)
  }

  func updateUIView(_ editor: JournalEditorView, context: Context) {
    let view = editor.textView
    context.coordinator.parent = self
    view.isEditable = editable
    view.inkVisible = inkVisible
    // Unfocused taps belong to the page, before keyboard layout moves the text view.
    editor.isUserInteractionEnabled = focused || !editable
    view.accessibilityLabel = day.map { "\(JournalEchoStamp.long($0)), read only" } ?? (editable ? "Today's page" : nil)
    view.accessibilityIdentifier = day.map { "journal-body-\($0)" } ?? (editable ? "journal-editor" : nil)
    context.coordinator.updateText(view, text: text, fontSize: fontSize)
    context.coordinator.updateHighlight(view, range: highlightedRange)
    (view.inputAccessoryView as? JournalWritingBar)?.count(wordCount)
    let appending = context.coordinator.appendRequest != appendRequest
    context.coordinator.appendRequest = appendRequest
    guard editable && focused ? (!view.isFirstResponder || appending) : view.isFirstResponder else { return }
    // UIKit's responder change calls back into SwiftUI's focus graph, so it waits until this update has finished.
    let coordinator = context.coordinator
    DispatchQueue.main.async {
      if coordinator.parent.editable && coordinator.parent.focused {
        view.becomeFirstResponder()
        view.selectedRange = NSRange(location: view.textStorage.length, length: 0)
      } else if view.isFirstResponder { view.resignFirstResponder() }
    }
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
        view.textStorage.addAttribute(.backgroundColor, value: JournalPalette.uiHighlight, range: range)
        highlightedRange = range
        #if DEBUG && targetEnvironment(simulator)
        (view as? JournalLayoutTextView)?.echoTarget = range
        #endif
      } else { highlightedRange = nil }
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

// The keyboard's bar while writing (Journal · iOS 01.9P): today's count leading, a regular Done trailing under the right thumb.
// UIKit's own toolbar, since SwiftUI's keyboard toolbar never reaches a UIKit text view; iOS 26 draws its items in glass.
final class JournalWritingBar: UIToolbar {
  let counted = UILabel()
  let done: () -> Void

  init(done: @escaping () -> Void) {
    self.done = done
    super.init(frame: CGRect(x: 0, y: 0, width: 320, height: RoomSpace.minimumTarget))
    // The bar's words grow with Dynamic Type as the system's own bar items do, up to a cap that keeps the bar one line.
    counted.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .systemFont(ofSize: 15), maximumPointSize: 24)
    counted.textColor = JournalPalette.uiInkDim
    let count = UIBarButtonItem(customView: counted)
    if #available(iOS 26.0, *) { count.hidesSharedBackground = true }
    let finish = UIBarButtonItem(title: "Done", style: .plain, target: self, action: #selector(finishWriting))
    finish.tintColor = JournalPalette.uiInk
    finish.setTitleTextAttributes([.font: UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17, weight: .semibold), maximumPointSize: 28)], for: .normal)
    finish.accessibilityLabel = "Done writing"
    finish.accessibilityIdentifier = "done-writing"
    items = [count, .flexibleSpace(), finish]
    sizeToFit()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func count(_ words: String?) {
    guard counted.text != words else { return }
    counted.text = words
    counted.sizeToFit()
  }

  @objc func finishWriting() { done() }
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
