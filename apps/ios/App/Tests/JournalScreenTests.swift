import SwiftUI
import UIKit
import Testing
import CoreText
@testable import Windmill

@Suite @MainActor struct JournalScreenTests {
  func editor(_ text: String) -> JournalEditorView {
    let view = JournalTextView()
    view.isScrollEnabled = false
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.attributedText = NSAttributedString(string: text, attributes: JournalBodyText.attributes(fontSize: 17))
    let editor = JournalEditorView(textView: view)
    editor.frame = CGRect(x: 0, y: 0, width: 320, height: 1000)
    editor.layoutIfNeeded()
    return editor
  }

  @Test func journalEditorUsesNightInkInALightShell() throws {
    let light = UITraitCollection(userInterfaceStyle: .light)
    let dark = UITraitCollection(userInterfaceStyle: .dark)
    var foreground: UIColor?
    light.performAsCurrent {
      let attributes = JournalBodyText.attributes(fontSize: JournalType.bodySize)
      foreground = attributes[.foregroundColor] as? UIColor
    }
    let ink = try #require(foreground)
    // Independent §2 values catch a broken SwiftUI → UIKit bridge as well as wrong appearance.
    let colors: [(UIColor, [CGFloat])] = [
      (ink.resolvedColor(with: light), [241, 240, 236]),
      (UIColor(ShellPalette.canvas).resolvedColor(with: light), [249, 245, 235]),
      (UIColor(ShellPalette.canvas).resolvedColor(with: dark), [11, 11, 12]),
    ]
    for (color, expected) in colors {
      var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
      try #require(color.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
      for (component, value) in zip([red, green, blue], expected) {
        #expect(abs(component * 255 - value) < 0.01)
      }
      #expect(alpha == 1)
    }
  }

  @Test func inkFontIsRegisteredFromTheAppBundle() throws {
    let font = try #require(UIFont(name: "Caveat-Regular", size: 26))
    #expect(font.familyName == "Caveat")
    #expect((Bundle.main.object(forInfoDictionaryKey: "UIAppFonts") as? [String])?.contains("Caveat-Regular.ttf") == true)
  }

  @Test(arguments: [140.0, 160, 180, 200, 220, 240, 320], [24.0, 32, 40])
  func inkLetteringPreservesCompleteGlyphOutlines(width: Double, size: Double) throws {
    let font = CTFontCreateWithName("Caveat-Regular" as CFString, size, nil)
    for text in ["Your journal", "You, and settings", "Today’s page", "Saves as you go.",
                 "Just start typing", "Just start\ntyping", "Tap to write"] {
      let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
      var renderedTexts: Set<String> = [text]
      for start in words.indices {
        for end in (start + 1)...words.count {
          renderedTexts.insert(words[start..<end].joined(separator: " "))
        }
      }
      for renderedText in renderedTexts.sorted() {
        let lines = renderedText.split(separator: "\n").map { line in
          CTLineCreateWithAttributedString(NSAttributedString(string: String(line), attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
        }
        let fits = lines.allSatisfy { CTLineGetTypographicBounds($0, nil, nil, nil) <= width - size / 2 }
        if width == 320 { #expect(fits, "Full label must fit the widest snapshot: \(renderedText)") }
        guard fits else { continue }
        let outlines = lines.map { CTLineGetBoundsWithOptions($0, .useGlyphPathBounds) }
        let expected = outlines.reduce(CGRect.null) { $0.union($1) }
        let actual = try renderedInkBounds(renderedText, size: size, width: width)
        #expect(actual.width + 2.0 / 3 >= expected.width,
                "Clipped Caveat outline: \(renderedText), size \(size), width \(width); rendered \(actual.width), glyph paths \(expected.width)")
        if !renderedText.contains("\n") {
          #expect(actual.height + 2.0 / 3 >= expected.height,
                  "Clipped Caveat height: \(renderedText), size \(size), width \(width); rendered \(actual.height), glyph paths \(expected.height)")
        }
      }
    }
  }

  func renderedInkBounds(_ text: String, size: Double, width: Double) throws -> CGRect {
    let renderer = ImageRenderer(content: InkLabel(text: text, size: size, width: width, index: 0, dim: false, visible: true).lettering)
    renderer.proposedSize = ProposedViewSize(width: width, height: nil)
    renderer.scale = 3
    let image = try #require(renderer.cgImage)
    return try paintedInkBounds(image, scale: renderer.scale)
  }

  @Test(arguments: [24.0, 40]) func nativeInkLetteringPreservesCompleteGlyphOutlines(size: Double) async throws {
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let font = CTFontCreateWithName("Caveat-Regular" as CFString, size, nil)
    for text in ["Your journal", "Just start\ntyping"] {
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(x: 0, y: 0, width: 300, height: 180)
      window.backgroundColor = .clear
      let host = UIHostingController(rootView: InkLabel(text: text, size: size, width: 240, index: 0, dim: false, visible: true).lettering
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).ignoresSafeArea())
      host.view.backgroundColor = .clear
      host.view.isOpaque = false
      window.rootViewController = host
      defer { window.isHidden = true; window.rootViewController = nil }
      window.isHidden = false
      host.view.layoutIfNeeded()
      try await Task.sleep(for: .milliseconds(100))
      host.view.layoutIfNeeded()
      let format = UIGraphicsImageRendererFormat()
      format.scale = 3; format.opaque = false
      let snapshot = UIGraphicsImageRenderer(size: host.view.bounds.size, format: format).image { _ in
        #expect(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
      }
      let actual = try paintedInkBounds(#require(snapshot.cgImage), scale: snapshot.scale)
      let outlines = text.split(separator: "\n").map { line in
        CTLineGetBoundsWithOptions(CTLineCreateWithAttributedString(NSAttributedString(string: String(line),
          attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])), .useGlyphPathBounds)
      }
      let expected = outlines.reduce(CGRect.null) { $0.union($1) }
      #expect(actual.width + 2.0 / 3 >= expected.width,
              "Native Caveat clipping: \(text), size \(size); painted \(actual.width), glyph paths \(expected.width)")
      #expect(actual.width <= expected.width + 2,
              "Native ink snapshot contains unexpected paint: \(text), size \(size); painted \(actual.width), glyph paths \(expected.width)")
      if !text.contains("\n") { #expect(actual.height + 2.0 / 3 >= expected.height) }
    }
  }

  func paintedInkBounds(_ image: CGImage, scale: CGFloat) throws -> CGRect {
    var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
    try pixels.withUnsafeMutableBytes { buffer in
      let context = try #require(CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                                          bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    var bounds = CGRect.null
    for y in 0..<image.height {
      for x in 0..<image.width where pixels[(y * image.width + x) * 4 + 3] > 4 {
        bounds = bounds.union(CGRect(x: x, y: y, width: 1, height: 1))
      }
    }
    #expect(!bounds.isNull, "Ink label rendered no pixels")
    return bounds.applying(CGAffineTransform(scaleX: 1 / scale, y: 1 / scale))
  }

  @Test(arguments: ["", "Short walk, then an early night.", "A walk 🌙 e\u{301}.",
                    "First line.\nLast line.", "A trailing empty line.\n",
                    String(repeating: "A longer wrapped page. ", count: 12)])
  func blankTapsBypassNativeSelectionAndAppend(text: String) {
    let editor = editor(text), view = editor.textView
    for x in [CGFloat(0), editor.bounds.midX, editor.bounds.maxX - 1] {
      for y in [view.lastLineRect.maxY + 1, editor.bounds.maxY - 1] {
        #expect(editor.hitTest(CGPoint(x: x, y: y), with: nil) === editor.appendArea)
      }
    }
    view.selectedRange = NSRange(location: 0, length: text.utf16.count)
    editor.appendAtEnd()
    #expect(view.selectedRange == NSRange(location: text.utf16.count, length: 0))
    view.insertText(" More.")
    #expect(view.text == text + " More.")
  }

  @Test func onTextTapsRetainNativeSelection() {
    let editor = editor("A page."), view = editor.textView
    let start = view.caretRect(for: view.beginningOfDocument)
    let hit = editor.hitTest(CGPoint(x: start.midX, y: start.midY), with: nil)
    #expect(hit === view || hit?.isDescendant(of: view) == true)
  }

  @Test(arguments: [true, false]) func lockedOrDismissedPageRetainsSelection(readOnly: Bool) {
    let editor = editor("An earlier page."), view = editor.textView
    view.isEditable = !readOnly
    editor.isUserInteractionEnabled = readOnly
    let selection = NSRange(location: 3, length: 4)
    view.selectedRange = selection
    editor.appendAtEnd()
    #expect(view.selectedRange == selection)
    #expect(view.text == "An earlier page.")
    let point = CGPoint(x: 1, y: view.lastLineRect.maxY + 1)
    #expect(editor.hitTest(point, with: nil) !== editor.appendArea)
  }

  @Test func blankTapPrecedesPageTapsWithoutDelayingScrolling() {
    let editor = editor("A page.")
    #expect(editor.gestureRecognizer(editor.appendTap, shouldBeRequiredToFailBy: UITapGestureRecognizer()))
    #expect(!editor.gestureRecognizer(editor.appendTap, shouldBeRequiredToFailBy: UIPanGestureRecognizer()))
  }

  @Test func nativeEndEditsReportTheirBodyAndKeepMiddleSelections() throws {
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    let controller = UIViewController()
    window.rootViewController = controller
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previousKeyWindow?.makeKeyAndVisible()
    }
    let edits: [(selection: NSRange, focused: Bool, body: String, report: String?)] = [
      (NSRange(location: 4, length: 0), true, "aaaaa", "aaaaa"),
      (NSRange(location: 2, length: 0), true, "aaaaa", nil),
      (NSRange(location: 4, length: 0), false, "aaaaa", nil),
      (NSRange(location: 3, length: 1), true, "aaaa", "aaaa"),
    ]
    for edit in edits {
      let editor = editor(""), view = editor.textView
      editor.frame = CGRect(x: 0, y: 0, width: 320, height: 300)
      controller.view.addSubview(editor)
      editor.layoutIfNeeded()
      defer { view.resignFirstResponder(); editor.removeFromSuperview() }
      var published = "aaaa", reports = [String?]()
      var reportedBeforePublication = false
      let binding = Binding(get: { published }, set: { value in
        reportedBeforePublication = !reports.isEmpty
        published = value
      })
      let coordinator = JournalBodyText(text: binding, focused: .constant(edit.focused), fontSize: 17,
                                        didEditAtEnd: { reports.append($0) }).makeCoordinator()
      coordinator.updateText(view, text: published, fontSize: 17)
      view.delegate = coordinator
      if edit.focused { #expect(view.becomeFirstResponder()) }
      #expect(view.isFirstResponder == edit.focused)
      view.selectedRange = edit.selection
      withExtendedLifetime(coordinator) {
        view.insertText("a")
        #expect(published == edit.body)
        #expect(reports == [edit.report])
        #expect(reportedBeforePublication)
        #expect(view.selectedRange == NSRange(location: edit.selection.location + 1, length: 0))
        if edit.selection.length == 1 {
          published = "An unrelated update."
          coordinator.updateText(view, text: published, fontSize: 17)
          #expect(view.text == published)
          #expect(reports == ["aaaa"])
        }
      }
    }
  }

  @Test func nativeEndInsertionScrollsAfterThePageGrows() throws {
    let (_, app) = try JournalModelTests().fixture()
    app.openJournal()
    let original = "First filled line.\nSecond filled line.\nThird filled line."
    app.journal.type(original); app.journal.editing = true
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 400)
    let host = UIHostingController(rootView: JournalScreen(model: app.journal, app: app).ignoresSafeArea(.keyboard))
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer {
      app.journal.saveTask?.cancel()
      window.isHidden = true
      window.rootViewController = nil
      previousKeyWindow?.makeKeyAndVisible()
    }
    host.view.layoutIfNeeded()
    func descendants(_ view: UIView) -> [UIView] {
      view.subviews.flatMap { [$0] + descendants($0) }
    }
    let text = try #require(descendants(host.view).compactMap { $0 as? JournalTextView }.first)
    #expect(text.becomeFirstResponder())
    #expect(text.isFirstResponder)
    text.selectedRange = NSRange(location: original.utf16.count, length: 0)
    var ancestor = text.superview
    while ancestor != nil && !(ancestor is UIScrollView) { ancestor = ancestor?.superview }
    let scroll = try #require(ancestor as? UIScrollView)
    var expected = original
    for insertion in [String(repeating: "\nA longer page keeps the caret clear of the Done seat.", count: 12), "\n"] {
      text.insertText(insertion)
      expected += insertion
      host.view.setNeedsLayout(); host.view.layoutIfNeeded()
      #expect(app.journal.document.body == expected)
      #expect(text.selectedRange == NSRange(location: expected.utf16.count, length: 0))
      #expect(scroll.contentSize.height > scroll.bounds.height)
      for rect in [text.caretRect(for: text.endOfDocument), text.lastLineRect] {
        let visible = text.convert(rect, to: scroll)
        #expect(visible.minY >= scroll.bounds.minY)
        #expect(visible.maxY < scroll.bounds.maxY)
      }
    }
  }

  @Test func reentrantBindingUpdateCannotRewindTyping() {
    let view = editor("A page.").textView
    var published = view.text ?? ""
    let coordinator = JournalBodyText(text: .constant(published), focused: .constant(true), fontSize: 17).makeCoordinator()
    let text = Binding(get: { published }, set: { value in
      coordinator.updateText(view, text: published, fontSize: 17)
      published = value
    })
    coordinator.parent = JournalBodyText(text: text, focused: .constant(true), fontSize: 17)
    coordinator.updateText(view, text: published, fontSize: 17)
    view.selectedRange = NSRange(location: published.utf16.count, length: 0)
    view.delegate = coordinator
    for character in " At the end." {
      view.insertText(String(character))
      coordinator.updateText(view, text: published, fontSize: 17)
      #expect(view.text == published)
      #expect(view.selectedRange == NSRange(location: published.utf16.count, length: 0))
    }
    #expect(published == "A page. At the end.")
    coordinator.updateText(view, text: "External page.", fontSize: 19)
    #expect(view.text == "External page.")
    #expect(view.font?.pointSize == 19)
  }

  @Test func equivalentSourceEditsRefreshNativeBytesAndHighlightTheCurrentRange() throws {
    let initial = "An e\u{301} before. I remembered the cafe\u{301} by the river."
    let revised = initial.precomposedStringWithCanonicalMapping
    let view = editor(initial).textView
    let coordinator = JournalBodyText(text: .constant(initial), focused: .constant(false), fontSize: 17).makeCoordinator()
    coordinator.updateText(view, text: initial, fontSize: 17)
    coordinator.updateText(view, text: revised, fontSize: 17)
    #expect((view.text ?? "").utf8.elementsEqual(revised.utf8))
    let quote = "I remembered the café by the river."
    let range = try #require(JournalEchoMatch(day: "2026-05-29", text: quote).range(in: revised))
    coordinator.updateHighlight(view, range: range)
    #expect((view.text as NSString).substring(with: range) == quote)
    #expect(view.textStorage.attribute(.backgroundColor, at: range.location, effectiveRange: nil) != nil)
    #expect(!view.isFirstResponder)
  }
}
