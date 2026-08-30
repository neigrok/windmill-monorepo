import SwiftUI
import UIKit
import XCTest
@testable import WindmillJournal

// The composer paints its links on a layer over a field whose own glyphs are transparent, which is
// only safe while the binding sees everything the field shows. A CJK writer converting kana has
// MARKED text on screen that has not been committed yet — if that never reached the binding it would
// be invisible while it was being chosen, and nothing else in the room would notice.
final class ComposerMarkedTextTests: XCTestCase {
    struct Host: View {
        @Binding var written: String

        var body: some View {
            TextField("", text: $written, axis: .vertical)
                .textFieldStyle(.plain)
        }
    }

    final class Written: ObservableObject {
        var body = ""
    }

    func testMarkedTextReachesTheBindingBeforeItIsCommitted() throws {
        let written = Written()
        let binding = Binding(get: { written.body }, set: { written.body = $0 })
        let host = UIHostingController(rootView: Host(written: binding))

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 700))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()

        let field = try XCTUnwrap(Self.firstTextInput(in: host.view), "the field never rendered")
        XCTAssertTrue(field.becomeFirstResponder(), "the field never took the keyboard")

        field.setMarkedText("にほんご", selectedRange: NSRange(location: 4, length: 0))
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(written.body, "にほんご",
                       "marked text never reached the binding — the paint layer would leave a CJK writer typing into the dark")

        field.unmarkText()
        field.replace(field.textRange(from: field.beginningOfDocument, to: field.endOfDocument)!, withText: "日本語")
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(written.body, "日本語", "the committed conversion never reached the binding")
    }

    private static func firstTextInput(in view: UIView) -> (UITextInput & UIView)? {
        if let field = view as? UITextField { return field }
        if let text = view as? UITextView { return text }
        for child in view.subviews {
            if let found = firstTextInput(in: child) { return found }
        }
        return nil
    }
}
