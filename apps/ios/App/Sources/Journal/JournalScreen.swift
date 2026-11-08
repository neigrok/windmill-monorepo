import SwiftUI
import UIKit
import DomainKit
import JournalDomain

nonisolated struct JournalWritingLayout: Equatable { let body: String; let contentHeight: CGFloat }

// The day canvas of the room's Pages tab: earlier pages above, today at the foot, writing in place, echoes in their sheet.
struct JournalScreen: View {
  @Bindable var model: JournalModel
  let app: AppModel
  // Each tap on the room's Write: today comes into view and the keyboard opens on it.
  let writeAsked: Int
  @Binding var inkFrames: [String: CGRect]
  @State var focused = false
  @State var writeRequest = 0
  @State var appendRequest = 0
  @State var editedBodyAtEnd: String?
  @State var inkMounted = false
  @State var echoHighlight: JournalEchoDestination?
  @State var echoDestination: JournalEchoDestination?
  @State var echoReadyDestination: JournalEchoDestination?
  @State var echoNavigationAccount: String?
  @State var echoDetent = PresentationDetent.medium
  @State var echoSheetHeight: CGFloat = 0
  // The day the sheet last showed, so a closing sheet keeps its passages until it has gone.
  @State var echoSheetDay: String?
  @AccessibilityFocusState var echoFocus: String?
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.scenePhase) var scenePhase
  @Environment(\.accessibilityReduceMotion) var systemReduceMotion
  @ScaledMetric(relativeTo: .body) var bodySize = JournalType.bodySize
  var reduceMotion: Bool { systemReduceMotion || model.runtime?.settings.board?.hasSuffix("-RM") == true }
  // What a compact account sheet covers at the foot of the canvas; today stands above it.
  static let compactSheetClearance: CGFloat = 406

  var body: some View {
    NavigationStack {
      journal
        .toolbar(model.compactAccountSheet ? .hidden : .visible, for: .navigationBar)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            RoomMenu(app: app, inkEnabled: inkMounted, inkFrames: $inkFrames)
          }
          ToolbarItem(placement: .topBarTrailing) {
            RoomAccountButton(action: app.openYou, inkEnabled: inkMounted, inkFrames: $inkFrames)
              .disabled(app.editorReadOnly)
          }
        }.roomBar(.journal)
    }
  }

  var journal: some View {
    // Today is a read of the store's clock: the canvas takes it once per render, never once per page.
    let currentDay = model.today
    let echoAccess = JournalEchoAccess(account: app.account, today: currentDay.text,
      available: scenePhase == .active && model.runtime?.engine.status.online == true &&
        !model.authPaused && !model.editorReadOnly && !model.readFailed)
    let echoesVisible = echoAccess.available && model.echoes.access == echoAccess
    return ScrollViewReader { scroll in
      let renderedBody = model.document.body
      ScrollView {
        VStack(alignment: .leading, spacing: 40) {
          ForEach(model.room?.days.filter { $0.day < currentDay } ?? [], id: \.day) { day in
            pastDay(day, echoesVisible: echoesVisible)
          }
          today(echoesVisible: echoesVisible)
            .padding(.horizontal, 24).padding(.bottom, 24)
            .contentShape(Rectangle())
            .gesture(TapGesture().onEnded { if model.writable { appendRequest += 1 } }, including: focused ? .all : .subviews)
            .id("journal-today")
        }.padding(.top, 50)
      }.accessibilityIdentifier("journal-canvas")
        .defaultScrollAnchor(model.compactAccountSheet ? .top : .bottom)
        .defaultScrollAnchor(.bottom, for: .alignment)
        .contentMargins(.bottom, model.compactAccountSheet ? Self.compactSheetClearance : echoesVisible && model.echoes.sheetDay != nil ? echoSheetHeight : 0, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .onScrollGeometryChange(for: JournalWritingLayout.self) {
          JournalWritingLayout(body: renderedBody, contentHeight: $0.contentSize.height)
        } action: { _, layout in
          guard focused, editedBodyAtEnd == layout.body else { return }
          scroll.scrollTo("journal-today", anchor: .bottom)
          editedBodyAtEnd = nil
        }
        .background { JournalPalette.canvas.ignoresSafeArea() }
        .overlay { GeometryReader { geo in inkNotes(origin: geo.frame(in: .global).origin) } }
        .simultaneousGesture(TapGesture().onEnded { model.liftInk() })
        .task(id: echoDestination) {
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
        }
        .onChange(of: writeAsked) { _, _ in write(scroll) }
        // The page whose count opened the sheet rises to stand above it, unless a passage holds the canvas.
        .onChange(of: echoSheetHeight) { _, height in
          guard height > 0, let day = model.echoes.sheetDay, model.echoes.hops.isEmpty else { return }
          withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) {
            scroll.scrollTo(day == model.editorDay.text ? "journal-today" : "journal-day-\(day)", anchor: .bottom)
          }
        }
    }
      .onAppear { model.screenViewed("journal"); focused = model.editing; model.recordInvitations() }
      .onChange(of: focused) { _, value in
        if value { model.echoes.close() }
        writeRequest += 1
        model.editing = value
        model.choose(value ? "write" : "done_writing", screen: "journal")
        if value { model.liftInk() } else { model.done() }
      }
      .onChange(of: model.editing) { _, value in if focused != value { focused = value } }
      // An account sheet takes the screen: the echo sheet steps aside first, since one presenter holds one sheet.
      .onChange(of: model.sheet) { _, sheet in writeRequest += 1; if sheet != nil { model.echoes.close(recorded: false) } }
      .onChange(of: model.editorReadOnly) { _, _ in writeRequest += 1 }
      .onDisappear { writeRequest += 1; model.echoes.suspend() }
      .onChange(of: model.echoBodies, initial: true) { _, bodies in model.echoes.updateBodies(bodies) }
      .onChange(of: model.echoes.destination) { _, destination in
        guard let destination else { return }
        echoNavigationAccount = app.account
        echoDestination = destination
      }
      .task(id: echoAccess) {
        model.echoes.activate(echoAccess)
        model.echoes.updateBodies(model.echoBodies)
        await model.echoes.poll()
      }
      .onChange(of: model.echoes.sheetDay) { _, day in if let day { echoSheetDay = day } }
      .sheet(isPresented: Binding(get: { echoesVisible && model.sheet == nil && model.echoes.sheetDay != nil }, set: { if !$0 { model.echoes.close() } })) {
        if let day = model.echoes.sheetDay ?? echoSheetDay {
          JournalEchoSheet(echoes: model.echoes, day: day, detent: $echoDetent).environment(\.dynamicTypeSize, typeSize)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { echoSheetHeight = $0 }
            .onAppear { app.roomSheetUp = true }.onDisappear { app.roomSheetUp = false }
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

  // The room's Write brings today into view, then opens the keyboard on it, unless something took the page meanwhile.
  func write(_ scroll: ScrollViewProxy) {
    guard model.writable else { return }
    model.liftInk()
    writeRequest += 1
    let request = writeRequest
    if reduceMotion {
      scroll.scrollTo("journal-today", anchor: .bottom)
      focused = true
      return
    }
    withAnimation(.easeOut(duration: 0.48)) {
      scroll.scrollTo("journal-today", anchor: .bottom)
    } completion: {
      if writeRequest == request && model.writable { focused = true }
    }
  }

  // A day's date stamp, with its echo count trailing while echoes stand and the day is not being written.
  func dateRow(_ day: LocalDay, echoesVisible: Bool) -> some View {
    HStack(spacing: 6) {
      let today = day == model.editorDay
      Text(date(day)).font(JournalType.date).tracking(JournalType.dateTracking).foregroundStyle(JournalPalette.inkDim)
        .accessibilityIdentifier(today ? "journal-date" : "")
        .inkAnchor("date", enabled: inkMounted && today, frames: $inkFrames)
      Spacer(minLength: 8)
      if echoesVisible && !(focused && today) {
        JournalEchoTab(echoes: model.echoes, day: day.text, writing: focused || model.sheet != nil) {
          focused = false; model.liftInk()
          if model.echoes.sheetDay != day.text { echoDetent = typeSize.isAccessibilitySize ? .large : .medium }
          model.echoes.toggle(day.text, expanded: typeSize.isAccessibilitySize)
        }.padding(.vertical, -11)
      }
    }.frame(minHeight: 22)
  }

  // A read-only earlier page: its date and echo count, and its words.
  func pastDay(_ day: JournalRoom.Day, echoesVisible: Bool) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      dateRow(day.day, echoesVisible: echoesVisible)
      pastBody(day.document.body, day: day.day.text, echoesVisible: echoesVisible)
    }.padding(.horizontal, 24).id("journal-day-\(day.day.text)")
      .accessibilityElement(children: .contain).accessibilityIdentifier("journal-day-\(day.day.text)")
  }

  func pastBody(_ body: String, day: String, echoesVisible: Bool) -> some View {
    let destination = echoHighlight?.day == day && echoNavigationAccount == app.account ? echoHighlight : nil
    let range = destination.flatMap { destination in
      destination.text.flatMap { JournalEchoMatch(day: day, text: $0, occurrenceHint: destination.occurrenceHint).range(in: body) }
    }
    return JournalBodyText(text: .constant(body), focused: .constant(false), fontSize: bodySize, editable: false,
      highlightedRange: echoesVisible && !model.echoes.hops.isEmpty ? range : nil, day: day)
      .accessibilityFocused($echoFocus, equals: day)
      .overlay(alignment: .topLeading) {
        if let range {
          GeometryReader { geo in
            VStack(spacing: 0) {
              Color.clear.frame(height: JournalBodyText.passageOffset(in: body, range: range, width: geo.size.width, fontSize: bodySize))
              Color.clear.frame(height: 1).id("journal-echo-passage")
                .onGeometryChange(for: Bool.self) { $0.size.height > 0 } action: { ready in
                  if ready, let destination, echoDestination == destination, validEchoDestination(destination) {
                    echoReadyDestination = destination
                  }
                }
              Spacer(minLength: 0)
            }
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

  func today(echoesVisible: Bool) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        dateRow(model.editorDay, echoesVisible: echoesVisible).padding(.bottom, 12)
        ZStack(alignment: .topLeading) {
          JournalBodyText(text: Binding(get: { model.document.body }, set: { model.type($0) }), focused: $focused, fontSize: bodySize, editable: !model.editorReadOnly, appendRequest: appendRequest, inkVisible: inkMounted && model.inkVisible && !focused && model.sheet == nil, didEditAtEnd: { editedBodyAtEnd = $0 }, minimumLines: 3, writingBar: true, wordCount: model.wordCount)
            .accessibilityFocused($echoFocus, equals: model.today.text)
            .allowsHitTesting(focused || model.editorReadOnly)
          if model.document.body.isEmpty && !focused {
            VStack(alignment: .leading, spacing: 14) {
              HStack(alignment: .top, spacing: 3) {
                Rectangle().fill(JournalPalette.lamp).frame(width: 1.5, height: bodySize * 1.4)
                if model.showPlaceholder {
                  Text(JournalBodyText.placeholder).font(JournalType.body).lineSpacing(JournalType.lineSpacing).foregroundStyle(JournalPalette.inkFaint)
                }
              }.accessibilityHidden(true)
              if model.showPrivacy { privacyLine }
            }.allowsHitTesting(false)
          }
        }.inkAnchor("caret", enabled: inkMounted, frames: $inkFrames)
        if model.showPrivacy && (!model.document.body.isEmpty || focused) { privacyLine.padding(.top, 14) }
      }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        .gesture(TapGesture().onEnded {
          if model.writable && !focused { focused = true }
        }, including: focused ? .subviews : .all)
      if !focused && model.keepDue {
        HStack {
          Image(systemName: "iphone").font(.system(size: 14)); Text("Only on this phone").font(ShellType.meta); Spacer()
          Button("Keep it") { model.keep() }.font(ShellType.secondaryAction).buttonStyle(RoomSecondaryStyle()).tint(JournalPalette.lamp)
        }.foregroundStyle(JournalPalette.inkDim).padding(.top, 18)
      }
      // A refusal speaks under the words it concerns, in ink; a failed save offers Try again (Journal · iOS 01.5P).
      if let error = model.error {
        VStack(alignment: .leading, spacing: 0) {
          Text(error).font(.footnote).foregroundStyle(JournalPalette.ink).fixedSize(horizontal: false, vertical: true)
          if model.dirty {
            Button("Try again") { model.choose("retry", screen: "journal"); model.save() }.buttonStyle(.borderless).foregroundStyle(JournalPalette.lamp).font(ShellType.secondaryAction)
              .frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("journal-try-again")
          }
        }.padding(.top, 12)
      }
    }.foregroundStyle(JournalPalette.ink)
  }

  // The first run's one fact: under the empty page's placeholder, or under the words once there are any.
  var privacyLine: some View {
    Text("Only you. No prompts, no fields, nothing to fill in — write a line or a page.")
      .font(ShellType.meta).lineSpacing(3).foregroundStyle(JournalPalette.inkFaint).inkAnchor("privacy", enabled: inkMounted, frames: $inkFrames)
  }

  func date(_ day: LocalDay) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "EEE d MMM"; f.timeZone = TimeZone(secondsFromGMT: 0)
    return f.string(from: Calendar(identifier: .gregorian).date(from: DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: day.year, month: day.month, day: day.day))!).uppercased()
  }
}
