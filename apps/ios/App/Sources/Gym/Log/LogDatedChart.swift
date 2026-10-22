import SwiftUI
import UIKit
import DomainKit
import GymDomain

struct LogPlotPoint: Identifiable, Equatable {
  let id: String
  let date: Date
  let value: Double
  let label: String
}

// A dated series of dots drawn across its window, with its window line under it: the window it shows, or, while a finger
// scrubs, the reading of the point under the scrub rule in the line's place. The plot pans across a window wider than the
// screen, its month ticks moving with it.
struct LogDatedChart: View {
  // What the dots are: a workout's estimated strength in plate loads, or a typed bodyweight to one decimal.
  enum Series {
    case strength, bodyweight
    var gapDays: Int { self == .strength ? MovementProgress.gapDays : Bodyweight.gapDays }
    var axisStep: Double { self == .strength ? 5 : 0.1 }
    var point: String { self == .strength ? "workout" : "weigh-in" }
    var title: String { self == .strength ? "Estimated strength chart" : "Bodyweight chart" }
  }
  static let plotHeight: CGFloat = 176
  let points: [LogPlotPoint]
  let from: Date
  let through: Date
  let series: Series
  let dates: GymDate
  let caption: String
  let bestID: String?
  let selected: String?
  @State var inspected: String?
  @State var revealID: String?
  @State var clearing: Task<Void, Never>?
  @State var viewportGeometry: ScrollGeometry?

  // `selected` opens the chart at that point, ringed, with the window line under it.
  init(points: [LogPlotPoint], from: Date, through: Date, series: Series, dates: GymDate, caption: String,
       bestID: String? = nil, selected: String? = nil) {
    self.points = points; self.from = from; self.through = through; self.series = series
    self.dates = dates; self.caption = caption; self.bestID = bestID; self.selected = selected
  }
  var ordered: [LogPlotPoint] { points.sorted { $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date } }
  // The ringed point: the one a finger inspects, else the one the chart opened at.
  var marked: String? { inspected ?? selected }
  var axis: ClosedRange<Double> { Self.axis(points.map(\.value), step: series.axisStep) }
  var low: Double { axis.lowerBound }
  var high: Double { axis.upperBound }
  var ticks: [Double] { [high, (high + low) / 2, low] }
  var gaps: [(LogPlotPoint, LogPlotPoint)] {
    zip(ordered, ordered.dropFirst()).filter { LogPresentation.day($0.date).days(until: LogPresentation.day($1.date)) > series.gapDays }
  }
  // The first of every month inside the window, where its tick stands.
  var months: [LocalDay] {
    let first = LogPresentation.day(from), last = LogPresentation.day(through)
    var month = LocalDay("\(first.text.prefix(7))-01")!, result: [LocalDay] = []
    while month <= last {
      if month >= first { result.append(month) }
      month = month.adding(days: 32); month = LocalDay("\(month.text.prefix(7))-01")!
    }
    return result
  }
  // Where the plot first rests: on the selected point's place across the window, else at its latest end.
  var anchor: UnitPoint {
    guard let point = ordered.first(where: { $0.id == selected }) else { return .trailing }
    return UnitPoint(x: min(1, max(0, point.date.timeIntervalSince(from) / max(1, through.timeIntervalSince(from)))), y: 0.5)
  }
  var visibleDates: ClosedRange<Date> {
    guard let viewportGeometry else { return from...through }
    return dateInterval(in: viewportGeometry.visibleRect, contentWidth: viewportGeometry.contentSize.width)
  }

  var body: some View {
    let height = Self.plotHeight
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        ZStack(alignment: .topLeading) {
          VStack(alignment: .leading) { ForEach(ticks, id: \.self) { Text(Readout.weight($0)) } }.hidden()
          ForEach(ticks, id: \.self) { value in
            Text(Readout.weight(value)).fixedSize().frame(height: 14).offset(y: y(value, height: height) - 7)
          }
        }.font(.caption2.monospaced()).foregroundStyle(GymPalette.inkDim).frame(minWidth: 24, maxHeight: height, alignment: .topLeading)
          .frame(height: height, alignment: .top).accessibilityHidden(true)
        GeometryReader { geometry in
          let width = max(geometry.size.width, CGFloat(Set(points.map(\.date)).count) * 12), marked = marked
          ScrollViewReader { proxy in
          ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 4) {
              Canvas { context, size in
                for value in ticks {
                  var grid = Path(); grid.move(to: CGPoint(x: 0, y: y(value, height: size.height)))
                  grid.addLine(to: CGPoint(x: size.width, y: y(value, height: size.height)))
                  context.stroke(grid, with: .color(GymPalette.line), lineWidth: 1)
                }
                if let point = ordered.first(where: { $0.id == inspected }) {
                  var rule = Path(); rule.move(to: CGPoint(x: position(point, size: size).x, y: 0))
                  rule.addLine(to: CGPoint(x: position(point, size: size).x, y: size.height))
                  context.stroke(rule, with: .color(GymPalette.inkFaint), lineWidth: 1)
                }
                for point in ordered {
                  let center = position(point, size: size)
                  let dot = CGRect(x: center.x - 3.5, y: center.y - 3.5, width: 7, height: 7)
                  context.fill(Path(ellipseIn: dot), with: .color(point.id == bestID ? GymPalette.record : GymPalette.accent))
                  if point.id == marked { context.stroke(Path(ellipseIn: dot.insetBy(dx: -5, dy: -5)), with: .color(GymPalette.ink), lineWidth: 1.5) }
                }
              }.frame(width: width, height: height).contentShape(Rectangle())
              .overlay {
                ZStack(alignment: .topLeading) {
                  ForEach(ordered) { point in
                    Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityHidden(false)
                      .accessibilityLabel(point.label).id(point.id).position(position(point, size: CGSize(width: width, height: height)))
                  }
                }.allowsHitTesting(false)
              }
              ZStack(alignment: .topLeading) {
                ForEach(months, id: \.self) { month in
                  Text(dates.monthTick(month)).fixedSize().offset(x: x(LogPresentation.date(month), width: width))
                }
              }.font(.caption2.monospaced()).foregroundStyle(GymPalette.inkDim).frame(width: width, height: 14, alignment: .topLeading)
                .accessibilityHidden(true)
            }
          }.frame(width: geometry.size.width, height: height + 18).contentShape(Rectangle()).clipped()
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.3).sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
              .onChanged { value in
                guard case .second(true, let drag) = value, let drag else { return }
                clearing?.cancel()
                let size = CGSize(width: width, height: height)
                let x = drag.location.x + (viewportGeometry?.visibleRect.minX ?? 0)
                inspected = ordered.min { abs(position($0, size: size).x - x) < abs(position($1, size: size).x - x) }?.id
              }.onEnded { _ in
                clearing?.cancel()
                clearing = Task { try? await Task.sleep(for: .milliseconds(1500)); if !Task.isCancelled { inspected = nil } }
              })
            .defaultScrollAnchor(anchor).scrollIndicators(.hidden)
            .accessibilityIdentifier("gym-chart-viewport")
            .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { _, geometry in viewportGeometry = geometry }
            .onChange(of: revealID) { _, id in if let id { proxy.scrollTo(id, anchor: .center) } }
          }
        }.frame(height: height + 18).contentShape(Rectangle()).clipped()
      }.overlay(alignment: .bottom) {
        let first = day(visibleDates.lowerBound), last = day(visibleDates.upperBound)
        Color.clear.frame(height: 1)
          .accessibilityElement(children: .ignore).accessibilityLabel("Visible dates")
          .accessibilityValue("\(first) – \(last)").accessibilityIdentifier("gym-chart-dates")
      }
      ForEach(Array(gaps.enumerated()), id: \.offset) { _, gap in
        Text("no \(series.point) · \(day(gap.0.date)) – \(day(gap.1.date))")
          .font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
      }
      if let point = ordered.first(where: { $0.id == inspected }) {
        Text(point.label).font(.footnote.monospaced()).foregroundStyle(point.id == bestID ? GymPalette.record : GymPalette.ink)
          .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("gym-chart-reading")
      } else {
        Text(caption).font(.footnote.monospaced()).foregroundStyle(GymPalette.inkDim)
          .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("gym-chart-caption")
      }
    }.contentShape(Rectangle()).clipped().accessibilityElement(children: .contain)
      .accessibilityLabel(series.title)
      .accessibilityValue((ordered.first { $0.id == marked } ?? ordered.last)?.label ?? "No points")
      .accessibilityAction(named: "Earlier \(series.point)") { step(-1) }
      .accessibilityAction(named: "Later \(series.point)") { step(1) }
      .sensoryFeedback(.selection, trigger: inspected)
      .onDisappear { clearing?.cancel() }
      .onChange(of: points) { _, _ in clearing?.cancel(); inspected = nil }
  }

  // The plot's bounds on the series' own step, an even number of steps apart, so the axis's three labels read 110 or
  // 82.4, never 109.62 or 82.45.
  static func axis(_ values: [Double], step: Double) -> ClosedRange<Double> {
    guard let lowest = values.min(), let highest = values.max() else { return 0...(step * 2) }
    let reach = max(step, 1)
    let middle = (lowest + highest) / 2
    let bottom = ((min(lowest, middle - reach) / step + 1e-9).rounded(.down) * step)
    var top = ((max(highest, middle + reach) / step - 1e-9).rounded(.up) * step)
    if Int(((top - bottom) / step).rounded()) % 2 == 1 { top += step }
    return bottom...top
  }

  func dateInterval(in viewport: CGRect, contentWidth: CGFloat) -> ClosedRange<Date> {
    let width = max(1, contentWidth - 12), span = max(0, through.timeIntervalSince(from))
    let leading = min(1, max(0, (viewport.minX - 6) / width))
    let trailing = min(1, max(leading, (viewport.maxX - 6) / width))
    return from.addingTimeInterval(span * leading)...from.addingTimeInterval(span * trailing)
  }

  func day(_ date: Date) -> String { dates.day(Instant(date)) }

  func x(_ date: Date, width: CGFloat) -> CGFloat {
    let span = max(1, through.timeIntervalSince(from))
    return 6 + min(1, max(0, date.timeIntervalSince(from) / span)) * max(0, width - 12)
  }
  func y(_ value: Double, height: CGFloat) -> CGFloat {
    6 + (high - value) / max(series.axisStep, high - low) * max(0, height - 12)
  }
  func position(_ point: LogPlotPoint, size: CGSize) -> CGPoint {
    CGPoint(x: x(point.date, width: size.width), y: y(point.value, height: size.height))
  }
  func step(_ direction: Int) {
    guard !ordered.isEmpty else { return }
    let index = ordered.firstIndex { $0.id == marked } ?? ordered.count - 1
    let next = ordered[min(ordered.count - 1, max(0, index + direction))]
    inspected = next.id; revealID = next.id
  }
}

// A chart's span: its recent stretch or everything logged, named with what it holds by the window line, *last 12 weeks ·
// 28 workouts* or *the whole series · 14 weigh-ins*.
enum ChartWindow: Hashable {
  case recent, all

  func line(recent: String, holding count: String) -> String { "\(self == .recent ? "last \(recent)" : "the whole series") · \(count)" }
}

struct ChartWindowPicker: UIViewRepresentable {
  let recent: String
  let identifier: String
  @Binding var window: ChartWindow
  func makeCoordinator() -> Coordinator { Coordinator(window: $window) }
  func makeUIView(context: Context) -> UISegmentedControl {
    let control = UISegmentedControl(items: [recent, "All"])
    control.setTitleTextAttributes([.font: UIFont.preferredFont(forTextStyle: .subheadline)], for: .normal)
    control.accessibilityIdentifier = identifier
    control.accessibilityLabel = "Window"
    control.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .valueChanged)
    return control
  }
  func updateUIView(_ control: UISegmentedControl, context: Context) {
    context.coordinator.window = $window
    control.selectedSegmentIndex = window == .all ? 1 : 0
  }
  func sizeThatFits(_ proposal: ProposedViewSize, uiView control: UISegmentedControl, context: Context) -> CGSize? {
    CGSize(width: proposal.width ?? control.intrinsicContentSize.width, height: max(32, control.intrinsicContentSize.height))
  }
  final class Coordinator: NSObject {
    var window: Binding<ChartWindow>
    init(window: Binding<ChartWindow>) { self.window = window }
    @objc func changed(_ control: UISegmentedControl) {
      window.wrappedValue = control.selectedSegmentIndex == 1 ? .all : .recent
    }
  }
}

extension MovementProgress {
  func logPlotPoints(_ dates: GymDate) -> [LogPlotPoint] {
    estimates.compactMap { point in
      guard let fact = point.fact.estimate else { return nil }
      return LogPlotPoint(id: point.id.description, date: point.startedAt.date, value: fact.e1rm,
        label: "\(Readout.estimatedWeight(fact.e1rm)) kg est · \(dates.day(point.startedAt)) · \(Readout.effort(weightKg: fact.weightKg, reps: fact.reps))")
    }
  }
}
