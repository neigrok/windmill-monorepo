import SwiftUI
import UIKit
import DomainKit
import JournalDomain

struct JournalScreen: View {
  @Bindable var model: JournalModel
  @State var focused = false
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ScaledMetric(relativeTo: .body) var bodySize = 17.0
  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .topLeading) {
        JournalBackdrop()
        VStack(spacing: 0) {
          if model.sheet != .keep { header.padding(.horizontal, 16).padding(.top, 6) }
          ScrollView {
            VStack(alignment: .leading, spacing: 40) {
              ForEach(model.room?.days.filter { $0.day < model.today } ?? [], id: \.day) { day in
                VStack(alignment: .leading, spacing: 18) {
                  Text(date(day.day)).font(Design.mono()).foregroundStyle(Design.dim)
                  JournalBodyText(text: .constant(day.document.body), focused: .constant(false), fontSize: bodySize, editable: false)
                    .frame(height: JournalBodyText.height(for: day.document.body, width: geo.size.width - 48, fontSize: bodySize))
                  HStack { Text("Mood \(day.document.mood.map(String.init) ?? "–")"); Text("Energy \(day.document.energy.map(String.init) ?? "–")") }.font(Design.mono()).foregroundStyle(Design.dim)
                }.accessibilityElement(children: .combine).accessibilityLabel("\(date(day.day)), read only. \(day.document.body)")
              }
              today(width: geo.size.width - 48)
            }.padding(.horizontal, 24)
              .padding(.top, typeSize.isAccessibilitySize && model.showPlaceholder ? 430 : 50)
              .padding(.bottom, focused || model.sheet == .keep ? 18 : (geo.size.height < 700 ? 12 : 92))
              .frame(minHeight: max(0, geo.size.height - 56 - (model.sheet == .keep ? 350 : 0)), alignment: .bottom)
          }.defaultScrollAnchor(model.sheet == .keep || (typeSize.isAccessibilitySize && model.showPlaceholder) ? .top : .bottom).scrollDismissesKeyboard(.interactively)
            .onTapGesture { model.liftInk() }
        }
        if model.roomMenu { roomMenu.padding(.leading, 16).padding(.top, 58) }
      }.overlayPreferenceValue(AnchorFrames.self) { anchors in
        GeometryReader { geometry in
          InkNotes(frames: anchors.mapValues { geometry[$0] }, visible: model.inkVisible && !focused && !model.roomMenu)
        }
      }
    }.onAppear { model.screenViewed("journal"); focused = model.editing; model.recordInvitations() }.onChange(of: focused) { _, value in
      model.editing = value
      if value { model.liftInk() } else { model.done() }
    }
    .onChange(of: model.editing) { _, value in if !value { focused = false } }
    .sensoryFeedback(.success, trigger: model.firstKept)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if focused {
        HStack { Spacer(); Button { focused = false; model.done() } label: { Image(systemName: "checkmark").foregroundStyle(Design.ink).frame(width: 44, height: 44).modifier(Glass(capsule: false)) }.accessibilityLabel("Done writing").accessibilityIdentifier("done-writing") }
          .padding(.horizontal, 16).padding(.bottom, 12).background(Design.canvas)
      }
    }
  }

  var header: some View {
    HStack {
      Button { model.liftInk(); focused = false; model.roomMenu.toggle() } label: {
        HStack(spacing: 8) { Text("Journal").font(Design.strong()); Image(systemName: "chevron.down").font(.system(size: 9)) }
          .foregroundStyle(Design.ink).padding(.horizontal, 17).frame(height: 44).modifier(Glass())
      }.accessibilityLabel("Journal room menu").accessibilityIdentifier("room-menu").inkAnchor("room")
      Spacer()
      Button { model.liftInk(); focused = false; model.roomMenu = false; model.sheet = .you } label: {
        YouGlyph().stroke(Design.ink, lineWidth: 1.5).frame(width: 18, height: 18).frame(width: 44, height: 44).modifier(Glass(capsule: false))
      }.accessibilityLabel("You and settings").accessibilityIdentifier("you").inkAnchor("you")
    }.buttonStyle(.plain).dynamicTypeSize(...DynamicTypeSize.large)
  }

  func today(width: CGFloat) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Text(date(model.editorDay) + (model.words > 0 ? " · \(model.words) WORDS" : "") + (focused || model.backup.isEmpty ? "" : " · \(model.backup)"))
          .font(Design.mono()).tracking(0.7).foregroundStyle(Design.dim)
        if model.firstKept && model.scalesDue { Image(systemName: "checkmark").font(.system(size: 10)).foregroundStyle(Design.lamp) }
      }.inkAnchor("date").padding(.bottom, 16)
      ZStack(alignment: .topLeading) {
        JournalBodyText(text: Binding(get: { model.document.body }, set: { model.type($0) }), focused: $focused, fontSize: bodySize, editable: !model.editorReadOnly)
          .frame(height: editorHeight(width: width))
        if model.showPlaceholder {
          HStack(alignment: .top, spacing: 3) {
            Rectangle().fill(Design.lamp).frame(width: 1.5, height: bodySize * 1.4)
            Text("Start anywhere. Nothing here is graded.").font(.custom("Inter-Regular", fixedSize: bodySize)).lineSpacing(7).foregroundStyle(Design.faint)
          }.allowsHitTesting(false).accessibilityHidden(true)
        }
      }.inkAnchor("caret")
      if model.showPrivacy {
        Text("Only you. No prompts, no fields, nothing to fill in — write a line or a page.")
          .font(Design.text(13)).lineSpacing(3).foregroundStyle(Design.faint).inkAnchor("privacy").padding(.top, 14)
      }
      if !focused && !model.roomMenu {
        if model.scalesDue {
          HStack {
            Text("How did today feel?").font(Design.strong(14)); Spacer()
            Button("Not now") { model.dismissScales() }.font(Design.text(14)).foregroundStyle(Design.dim).frame(minHeight: 44)
          }.padding(.top, 17)
        }
        VStack(spacing: 0) {
          ScaleRow(name: "Mood", value: model.document.mood) { model.setScale("mood", $0) }
          ScaleRow(name: "Energy", value: model.document.energy) { model.setScale("energy", $0) }
        }.disabled(model.editorReadOnly).padding(.top, model.scalesDue ? 0 : 23)
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

  var roomMenu: some View {
    VStack(spacing: 0) {
      Button { model.roomMenu = false } label: {
        HStack { Image(systemName: "checkmark").font(.system(size: 12)); Text("Journal"); Spacer(); Image(systemName: "book.closed") }.padding(.horizontal, 18).frame(minHeight: 52)
      }
      Divider().overlay(Design.line)
      Button { model.showInk() } label: {
        HStack { Text("Show ink notes"); Spacer(); Image(systemName: "scribble") }.padding(.horizontal, 42).frame(minHeight: 50)
      }.accessibilityIdentifier("show-ink-notes")
      Divider().overlay(Design.line)
      Button { model.roomMenu = false; model.sheet = .you } label: {
        HStack {
          VStack(alignment: .leading, spacing: 5) {
            Text("You")
            Text(model.account == nil ? "Not signed in" : model.accountName + " · " + model.backup).font(Design.text(13)).foregroundStyle(Design.faint)
          }; Spacer(); YouGlyph().stroke(Design.ink, lineWidth: 1.5).frame(width: 18, height: 18)
        }.padding(.horizontal, 42).frame(minHeight: 70)
      }
    }.font(Design.text()).foregroundStyle(Design.ink).buttonStyle(.plain).frame(width: 262)
      .background(Color(hex: 0x242426), in: RoundedRectangle(cornerRadius: 28))
      .overlay(RoundedRectangle(cornerRadius: 28).stroke(.white.opacity(0.24), lineWidth: 0.7))
      .shadow(color: .black.opacity(0.4), radius: 15, y: 14)
  }

  func editorHeight(width: CGFloat) -> CGFloat {
    let text = model.document.body.isEmpty ? "Start anywhere. Nothing here is graded." : model.document.body + " "
    return max(bodySize * 1.5, JournalBodyText.height(for: text, width: width, fontSize: bodySize))
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
    let view = UITextView()
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
    view.accessibilityLabel = editable ? "Today's journal page" : nil
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
    if editable && focused && !view.isFirstResponder { view.becomeFirstResponder() }
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
