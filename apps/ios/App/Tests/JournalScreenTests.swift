import SwiftUI
import UIKit
import Testing
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

  @Test func inkFontIsRegisteredFromTheAppBundle() throws {
    let font = try #require(UIFont(name: "Caveat-Regular", size: 26))
    #expect(font.familyName == "Caveat")
    #expect((Bundle.main.object(forInfoDictionaryKey: "UIAppFonts") as? [String])?.contains("Caveat-Regular.ttf") == true)
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
}
