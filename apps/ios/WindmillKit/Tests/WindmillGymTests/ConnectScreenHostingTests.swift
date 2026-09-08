import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The connected log's states, proved by hosting the real screen and reading back the accessibility
// tree SwiftUI hands UIKit — the screen as VoiceOver speaks it, not the source. SwiftUI builds that
// tree only for an automation client, so the suite declares itself one the way the UI-test runner
// does. The refusal row is a claim about a FAILED read: a signed-in lifter mid-read hears the head
// line and never `Couldn’t read your connections.`; the picker's card says `Sign in first` signed out.
@MainActor
final class ConnectScreenHostingTests: XCTestCase {
    private let web = URL(string: "https://windmill.works")!

    override func setUp() async throws {
        let library = try XCTUnwrap(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW))
        let symbol = try XCTUnwrap(dlsym(library, "_AXSSetAutomationEnabled"))
        unsafeBitCast(symbol, to: (@convention(c) (Int32) -> Void).self)(1)
    }

    private func host<Content: View>(_ content: Content) async -> UIWindow {
        let controller = UIHostingController(rootView: NavigationStack { content }
            .environment(\.gymSkin, GymSkin.instrument)
            .environment(\.colorScheme, .dark))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        for _ in 0..<20 {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(50))
        }
        return window
    }

    // Every label in the tree, top to bottom: the views' own elements, then their subviews'.
    private func spoken(in object: NSObject) -> [String] {
        var found: [String] = []
        if let label = object.accessibilityLabel, !label.isEmpty { found.append(label) }
        for element in object.accessibilityElements ?? [] {
            if let element = element as? NSObject { found += spoken(in: element) }
        }
        if let view = object as? UIView {
            for child in view.subviews { found += spoken(in: child) }
        }
        return found
    }

    private func screen(_ state: ConnectedLogState, signedIn: Bool) -> ConnectScreen {
        ConnectScreen(state: state, isSignedIn: signedIn, web: web, onSignIn: {}, onRefresh: {})
    }

    func testConnectedTheSectionListsEveryToolWithItsMetaAndTheDoorsStand() async {
        let day: Int64 = 86_400_000
        let claude = ConnectedTool(id: "c1", name: "Claude Desktop", grantedAtMs: 40 * day + day / 2,
                                   reach: LogReach(scope: "gym:read gym:write"), credential: .approved)
        let laptop = ConnectedTool(id: "k1", name: "laptop", grantedAtMs: 41 * day + day / 2,
                                   reach: LogReach(scope: ""), credential: .pasted)
        let window = await host(screen(.connected([claude, laptop]), signedIn: true))
        defer { window.isHidden = true }
        let heard = spoken(in: window).joined(separator: "\n")

        XCTAssertTrue(heard.contains("Connected"), heard)
        XCTAssertTrue(heard.contains("Claude Desktop"), heard)
        XCTAssertTrue(heard.contains("read · write · since 10 Feb"), heard)
        XCTAssertTrue(heard.contains("laptop"), heard)
        XCTAssertTrue(heard.contains("API key · whole account · since 11 Feb"), heard)
        XCTAssertTrue(heard.contains("Manage connections"), heard)
        XCTAssertTrue(heard.contains("Connect a tool"), heard)
        XCTAssertFalse(heard.contains(ConnectedLog.head), "the head line steps aside for the list")
        XCTAssertFalse(heard.contains(ConnectedLog.unread), heard)
    }

    func testSignedInAFailedReadDrawsTheRefusalRowAndTheActionStillStands() async {
        let window = await host(screen(.unknown, signedIn: true))
        defer { window.isHidden = true }
        let heard = spoken(in: window).joined(separator: "\n")

        XCTAssertTrue(heard.contains("Couldn’t read your connections."), heard)
        XCTAssertTrue(heard.contains("Connected"), heard)
        XCTAssertFalse(heard.contains(ConnectedLog.head), heard)
        XCTAssertFalse(heard.contains("Manage connections"), "nothing is known to be connected")
        XCTAssertTrue(heard.contains("Connect a tool"), "an invitation is not a claim about state")
    }

    func testSignedInAReadStillInFlightDrawsTheHeadLineAndNoRefusal() async {
        let window = await host(screen(.unread, signedIn: true))
        defer { window.isHidden = true }
        let heard = spoken(in: window).joined(separator: "\n")

        XCTAssertTrue(heard.contains(ConnectedLog.head), heard)
        XCTAssertFalse(heard.contains(ConnectedLog.unread), "a read that has not come back is not a refusal")
    }

    func testSignedOutTheScreenSaysSignInFirstAndNeverTheRefusal() async {
        let window = await host(screen(.unknown, signedIn: false))
        defer { window.isHidden = true }
        let heard = spoken(in: window).joined(separator: "\n")

        XCTAssertTrue(heard.contains("Sign in first"), heard)
        XCTAssertFalse(heard.contains("Connect a tool"), heard)
        XCTAssertFalse(heard.contains(ConnectedLog.unread), "signed out there was no read to fail")
    }

    // The ruling: a signed-out phone says `Sign in first` wherever the action is drawn — the
    // picker's card included.
    func testThePickerCardSaysSignInFirstSignedOutAndConnectAToolSignedIn() async {
        for (signedIn, label) in [(false, "Sign in first"), (true, "Connect a tool")] {
            let picker = OpeningPicker(catalog: [Exercise(id: "bench-press", name: "Bench Press")],
                                       taken: [], lastSets: nil, sessions: [], isSignedIn: signedIn,
                                       onPick: { _ in },
                                       onCreate: { _, _ in .success(Exercise(id: "x", name: "x")) },
                                       onConnect: {})
            let window = await host(picker)
            defer { window.isHidden = true }
            let heard = spoken(in: window).joined(separator: "\n")

            XCTAssertTrue(heard.contains(ConnectedLog.pickerLine), heard)
            XCTAssertTrue(heard.contains(label), heard)
        }
    }
}
