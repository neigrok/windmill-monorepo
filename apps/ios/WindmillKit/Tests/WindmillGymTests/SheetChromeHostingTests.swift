import SwiftUI
import UIKit
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The chrome on a sheet is the platform's (`12-native-idiom.md`): the title in a navigation bar the
// system draws, its dismissal as that bar's own item, and the settings screen a `Form`. A COMMITTING
// action stays in the reach band under the thumb (§"Back, and the thumb") — the keypad's `Set` and
// the fix sheet's `Save the fix` — with the one-field rename the exception: under a keyboard there is
// no band, so `Rename` is the bar's. Proved by hosting each real view and reading the UIKit the
// platform put under it — a `UINavigationBar` carrying the title and its items, a `UICollectionView`
// under the form — because a view that draws its own heading in a `Text` is indistinguishable from
// one at the SwiftUI level. SwiftUI seats its toolbar items in the bar's item GROUPS, titled, and
// draws its text through its own renderer rather than `UILabel`, so the items are read off the groups
// and the band's commits are pinned at the source. Claims are relative (which bar, which items, how
// many segmented controls, one height against the room's own floor), never point values.
@MainActor
final class SheetChromeHostingTests: XCTestCase {
    private var stem: URL!

    override func setUp() async throws {
        stem = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("chrome-host-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        for ext in ["queue.json", "catalog.json", "local.json", "account.json", "bodyweight.json"] {
            try? FileManager.default.removeItem(at: stem.appendingPathExtension(ext))
        }
    }

    private func makeStore() -> TrainingStore {
        TrainingStore(queue: SetQueue(url: stem.appendingPathExtension("queue.json"), deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: stem.appendingPathExtension("catalog.json")),
                      accountCopy: AccountCopy(url: stem.appendingPathExtension("account.json")),
                      localLog: LocalLog(url: stem.appendingPathExtension("local.json"), deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: stem.appendingPathExtension("bodyweight.json")),
                      undoWindowMs: 0,
                      sync: { _ in FakeTraining() })
    }

    private func host<Content: View>(_ content: Content) async -> UIWindow {
        let controller = UIHostingController(rootView: content
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

    private func views<Found: UIView>(_ kind: Found.Type, in view: UIView) -> [Found] {
        var found: [Found] = []
        if let hit = view as? Found { found.append(hit) }
        for child in view.subviews { found += views(kind, in: child) }
        return found
    }

    private func bar(of window: UIWindow) throws -> UINavigationItem {
        let bars = views(UINavigationBar.self, in: window)
        XCTAssertEqual(bars.count, 1, "one navigation bar, the sheet's own")
        return try XCTUnwrap(bars.first?.topItem)
    }

    private func leading(_ item: UINavigationItem) -> [String] {
        item.leadingItemGroups.flatMap(\.barButtonItems).compactMap(\.title)
    }

    private func trailing(_ item: UINavigationItem) -> [String] {
        item.trailingItemGroups.flatMap(\.barButtonItems).compactMap(\.title)
    }

    private func sheetBody(_ sheet: String) throws -> Substring {
        let text = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/\(sheet).swift"), encoding: .utf8)
        let body = try XCTUnwrap(text.range(of: "struct \(sheet): View"))
        return text[body.upperBound...]
    }

    private func set() -> TrainingSet {
        TrainingSet(id: "s1", exerciseId: "bench-press", setNumber: 1, weightKg: 80, reps: 5, completedAtMs: 1)
    }

    func testTheFixSheetTakesItsTitleFromTheBarAndSavesFromTheBand() async throws {
        let window = await host(FixSheet(set: set(), movement: "Bench Press", number: "1", routine: nil,
                                         onSave: { _ in }, onDelete: {}))
        let item = try bar(of: window)
        XCTAssertEqual(item.title, "Fix this set")
        XCTAssertEqual(leading(item), [], "the sheet draws no dismissal of its own: the scrim and the swipe are it")
        XCTAssertEqual(trailing(item), [], "the commit is the reach band's, not the bar's")
        let body = try sheetBody("FixSheet")
        XCTAssertFalse(body.contains(".confirmationAction"), "the bar carries no affirmative")
        XCTAssertTrue(body.contains("Text(\"Save the fix\")"), "the band's commit keeps its bytes")
        XCTAssertTrue(body.contains(".disabled(SetRecord.refusal(note: note) != nil)"), "and its refusal rule")
        XCTAssertTrue(body.contains("noteRow\n                    save\n                    deleteRow"),
                      "the band sits between the note and the delete row")
    }

    // Four kinds and nine ratings: two segmented controls, both the platform's, one height, and both
    // over the room's tap floor.
    func testTheFixSheetsKindsAreASegmentedControlBesideTheRatings() async throws {
        let window = await host(FixSheet(set: set(), movement: "Bench Press", number: "1", routine: nil,
                                         onSave: { _ in }, onDelete: {}))
        let segmented = views(UISegmentedControl.self, in: window)
        XCTAssertEqual(segmented.map(\.numberOfSegments).sorted(), [SetKind.allCases.count, SetRecord.ratings.count])
        let kinds = try XCTUnwrap(segmented.first { $0.numberOfSegments == SetKind.allCases.count })
        let ratings = try XCTUnwrap(segmented.first { $0.numberOfSegments == SetRecord.ratings.count })
        XCTAssertEqual(kinds.selectedSegmentIndex, SetKind.allCases.firstIndex(of: .working))
        XCTAssertEqual(kinds.bounds.height, ratings.bounds.height, "the pair stands one height")
        XCTAssertGreaterThanOrEqual(ratings.bounds.height, GymTap.minimum, "the ratings stand under the tap floor")
    }

    func testTheJumpSheetClosesFromTheBar() async throws {
        let window = await host(JumpSheet(rows: [], assembling: true, onJump: { _ in }, onMove: { _, _ in },
                                          onDrop: { _ in }, onAdd: {}, onClose: {}))
        let item = try bar(of: window)
        XCTAssertEqual(item.title, "This session")
        XCTAssertEqual(leading(item), ["Close"], "the bar's dismissal")
        XCTAssertEqual(trailing(item), [])
    }

    func testTheKeypadNamesTheNumberInTheBarAndCommitsFromTheBand() async throws {
        var committed: Double?
        let window = await host(KeypadSheet(mode: .weight, current: 80, onCommit: { committed = $0 }, onCancel: {}))
        let item = try bar(of: window)
        XCTAssertEqual(item.title, "Weight")
        XCTAssertEqual(leading(item), ["Cancel"])
        XCTAssertEqual(trailing(item), [], "the commit is the reach band's, not the bar's")
        XCTAssertNil(committed)
        let body = try sheetBody("KeypadSheet")
        XCTAssertFalse(body.contains(".confirmationAction"), "the bar carries no affirmative")
        XCTAssertTrue(body.contains("Text(\"Set\")"), "the band's commit keeps its bytes")
        XCTAssertTrue(body.contains(".disabled(!reading.isValid)"), "and its refusal rule")

        let reps = await host(KeypadSheet(mode: .reps, current: 5, onCommit: { _ in }, onCancel: {}))
        XCTAssertEqual(try bar(of: reps).title, "Reps")
    }

    func testTheRenameSheetTakesItsTitleFromTheBarAndRenamesFromIt() async throws {
        let window = await host(RenameSheet(current: "Bench Press", title: "Rename this movement",
                                            prompt: "Movement name", save: { _ in nil }, onClose: {}))
        let item = try bar(of: window)
        XCTAssertEqual(item.title, "Rename this movement")
        XCTAssertEqual(leading(item), ["Cancel"])
        XCTAssertEqual(trailing(item), ["Rename"])
    }

    // The settings screen is the platform's form: its sections are a collection view's, and the
    // three fixed-list dials are the platform's segmented control and switch.
    func testSettingsIsAFormWithThePlatformsControlsInside() async throws {
        let store = makeStore()
        let window = await host(SettingsScreen(store: store, web: URL(string: "https://windmill.works")!,
                                               connected: .none, onConnectedLog: {}, onNotes: {}, say: { _ in }))
        XCTAssertFalse(views(UICollectionView.self, in: window).isEmpty, "a Form lays out as a collection view")
        XCTAssertEqual(views(UISegmentedControl.self, in: window).map(\.numberOfSegments).sorted(),
                       [Units.allCases.count, Rest.choices.count].sorted())
        XCTAssertEqual(views(UISwitch.self, in: window).count, 3, "rest sound, haptic, sound")

        // One caption per group, and each is its section's footer.
        let settings = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/SettingsScreen.swift"), encoding: .utf8)
        XCTAssertEqual(settings.components(separatedBy: "} footer: {").count - 1, 3, "three captioned groups")
        for footer in ["Text(unitsCaption)",
                       "Text(\"The sound needs the app awake: a rest that ends while the phone is locked ends quietly.\")",
                       "Text(Settings.coachReads)"] {
            XCTAssertEqual(settings.components(separatedBy: footer).count - 1, 1, footer)
        }
        XCTAssertFalse(settings.contains("how the room behaves at the rack"), "the bar's title is the screen's")

        // The bar names the screen `Settings` — not the room — and it is the only thing that does.
        let room = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/GymRoom.swift"), encoding: .utf8)
        XCTAssertTrue(room.contains("case .settings: return \"Settings\""), "the pushed settings screen is named by its bar")
        XCTAssertFalse(settings.contains("Text(\"Settings\")"), "the screen says its name once, in the bar")
    }

    // No sheet keeps a hand-set display title: the title is the bar's, and Dynamic Type moves it.
    func testNoSheetDrawsAFixedPointTitleOfItsOwn() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym")
        for sheet in ["FixSheet", "JumpSheet", "RenameSheet", "ReviewSheet", "KeypadSheet"] {
            let view = try sheetBody(sheet)
            XCTAssertTrue(view.contains("NavigationStack {"), sheet)
            XCTAssertTrue(view.contains(".navigationBarTitleDisplayMode(.inline)"), sheet)
            if sheet == "KeypadSheet" {
                XCTAssertFalse(view.contains("Text(mode == .weight ? \"Weight\" : \"Reps\")"),
                               "the keypad's name is the bar's title")
                continue
            }
            XCTAssertFalse(view.contains("WindmillFont.display("), "\(sheet) draws a fixed-point title")
        }
        let settings = try String(contentsOf: sources.appendingPathComponent("SettingsScreen.swift"), encoding: .utf8)
        XCTAssertTrue(settings.contains("Form {"))
        XCTAssertFalse(settings.contains("ScrollView {"))
    }
}
