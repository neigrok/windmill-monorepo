import SwiftUI
import GymDomain

struct LogPlotPoint: Identifiable, Equatable {
  let id: String
  let date: Date
  let value: Double
  let label: String
}

struct LogDatedChart: View {
  let points: [LogPlotPoint]
  let from: Date
  let through: Date
  let gapDays: Int
  var bestID: String? = nil
  var compact = false
  var select: ((String) -> Void)? = nil
  @Environment(\.colorScheme) var scheme
  @Namespace private var plotSpace
  @State var inspected: String?
  @State var revealID: String?
  @State var clearing: Task<Void, Never>?
  @State var viewportGeometry: ScrollGeometry?
  var palette: LogPalette { LogPalette(dark: scheme == .dark) }
  var ordered: [LogPlotPoint] { points.sorted { $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date } }
  var low: Double { let value = points.map(\.value).min() ?? 0; return value - padding }
  var high: Double { let value = points.map(\.value).max() ?? 1; return value + padding }
  var padding: Double { max(1, ((points.map(\.value).max() ?? 1) - (points.map(\.value).min() ?? 0)) * 0.12) }
  var gaps: [(LogPlotPoint, LogPlotPoint)] {
    zip(ordered, ordered.dropFirst()).filter { LogPresentation.day($0.date).days(until: LogPresentation.day($1.date)) > gapDays }
  }
  var visibleDates: ClosedRange<Date> {
    guard let viewportGeometry else { return from...through }
    return dateInterval(in: viewportGeometry.visibleRect, contentWidth: viewportGeometry.contentSize.width)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !compact, let point = ordered.first(where: { $0.id == inspected }) ?? ordered.last {
        Text(point.label).font(.subheadline.monospaced()).foregroundStyle(point.id == bestID ? palette.record : palette.ink)
          .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("gym-chart-reading")
      }
      HStack(alignment: .top, spacing: 8) {
        VStack {
          Text(Readout.weight(high)); Spacer(); Text(Readout.weight(low))
        }.font(.caption2.monospaced()).foregroundStyle(palette.dim).frame(height: compact ? 64 : 220).accessibilityHidden(true)
        GeometryReader { geometry in
          let width = max(geometry.size.width, compact ? 0 : CGFloat(Set(points.map(\.date)).count) * 24)
          ScrollViewReader { proxy in
          ScrollView(.horizontal) {
            Canvas { context, size in
              for fraction in [0.0, 0.5, 1.0] {
                var grid = Path(); grid.move(to: CGPoint(x: 0, y: 6 + fraction * (size.height - 12)))
                grid.addLine(to: CGPoint(x: size.width, y: 6 + fraction * (size.height - 12)))
                context.stroke(grid, with: .color(palette.dim.opacity(0.15)), lineWidth: 1)
              }
              for (a, b) in zip(ordered, ordered.dropFirst()) where LogPresentation.day(a.date).days(until: LogPresentation.day(b.date)) <= gapDays {
                var path = Path(); path.move(to: position(a, size: size)); path.addLine(to: position(b, size: size))
                context.stroke(path, with: .color(palette.accent), lineWidth: 1.5)
              }
              for point in ordered {
                let center = position(point, size: size), radius: CGFloat = point.id == inspected ? 6 : 3.5
                let dot = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
                context.fill(Path(ellipseIn: dot), with: .color(point.id == bestID ? palette.record : palette.accent))
                if point.id == inspected { context.stroke(Path(ellipseIn: dot.insetBy(dx: -3, dy: -3)), with: .color(palette.ink), lineWidth: 1) }
              }
            }.frame(width: width, height: compact ? 64 : 220).contentShape(Rectangle())
            .overlay {
              if !compact {
                ZStack(alignment: .topLeading) {
                  ForEach(ordered) { point in
                    let p = position(point, size: CGSize(width: width, height: 220))
                    if let select {
                      Button { select(point.id) } label: { Color.clear.frame(width: 44, height: 44) }
                        .buttonStyle(.plain).allowsHitTesting(false)
                        .accessibilityLabel(point.label).accessibilityIdentifier("gym-chart-point-\(point.id)")
                        .accessibilityAction { select(point.id) }.position(p).id(point.id)
                    } else {
                      Color.clear.frame(width: 1, height: 1).accessibilityElement().accessibilityHidden(false)
                        .accessibilityLabel(point.label).position(p).id(point.id)
                    }
                  }
                }.allowsHitTesting(false)
              }
            }
          }.frame(width: geometry.size.width, height: compact ? 64 : 220).contentShape(Rectangle()).clipped()
            .coordinateSpace(name: plotSpace)
            .simultaneousGesture(SpatialTapGesture(coordinateSpace: .named(plotSpace)).onEnded { value in
              guard !compact, let select else { return }
              let size = CGSize(width: width, height: 220)
              let x = value.location.x + (viewportGeometry?.visibleRect.minX ?? 0)
              if let nearest = ordered.min(by: { abs(position($0, size: size).x - x) < abs(position($1, size: size).x - x) }) {
                select(nearest.id)
              }
            }, including: !compact && select != nil ? .all : .subviews)
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.3).sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named(plotSpace)))
              .onChanged { value in
                guard !compact, select == nil, case .second(true, let drag) = value, let drag else { return }
                clearing?.cancel()
                let size = CGSize(width: width, height: 220)
                let x = drag.location.x + (viewportGeometry?.visibleRect.minX ?? 0)
                inspected = ordered.min { abs(position($0, size: size).x - x) < abs(position($1, size: size).x - x) }?.id
              }.onEnded { _ in
                clearing?.cancel()
                clearing = Task { try? await Task.sleep(for: .milliseconds(1500)); if !Task.isCancelled { inspected = nil } }
              }, including: !compact && select == nil ? .all : .subviews)
            .defaultScrollAnchor(.trailing).scrollIndicators(.hidden).scrollDisabled(compact)
            .accessibilityIdentifier("gym-chart-viewport")
            .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { _, geometry in viewportGeometry = geometry }
            .onChange(of: revealID) { _, id in if let id { proxy.scrollTo(id, anchor: .center) } }
          }
        }.frame(height: compact ? 64 : 220).contentShape(Rectangle()).clipped()
      }
      HStack { Text(LogPresentation.brief(visibleDates.lowerBound)); Spacer(); Text(LogPresentation.brief(visibleDates.upperBound)) }
        .font(.caption2.monospaced()).foregroundStyle(palette.dim)
        .accessibilityElement(children: .ignore).accessibilityLabel("Visible dates")
        .accessibilityValue("\(LogPresentation.brief(visibleDates.lowerBound)) – \(LogPresentation.brief(visibleDates.upperBound))")
        .accessibilityIdentifier("gym-chart-dates").accessibilityHidden(compact)
      if !compact {
        ForEach(Array(gaps.enumerated()), id: \.offset) { _, gap in
          Text("\(gapDays == 7 ? "no weigh-in" : "no session") · \(LogPresentation.brief(gap.0.date)) – \(LogPresentation.brief(gap.1.date))")
            .font(.caption.monospaced()).foregroundStyle(palette.dim)
        }
      }
    }.contentShape(Rectangle()).clipped().accessibilityElement(children: .contain)
      .accessibilityLabel(gapDays == 7 ? "Bodyweight chart" : "Estimated strength chart")
      .accessibilityValue((ordered.first { $0.id == inspected } ?? ordered.last)?.label ?? "No points")
      .accessibilityAction(named: gapDays == 7 ? "earlier weigh-in" : "earlier session") { step(-1) }
      .accessibilityAction(named: gapDays == 7 ? "later weigh-in" : "later session") { step(1) }
      .sensoryFeedback(.selection, trigger: inspected)
      .onDisappear { clearing?.cancel() }
      .onChange(of: points) { _, _ in clearing?.cancel(); inspected = nil }
  }

  func dateInterval(in viewport: CGRect, contentWidth: CGFloat) -> ClosedRange<Date> {
    let width = max(1, contentWidth - 12), span = max(0, through.timeIntervalSince(from))
    let leading = min(1, max(0, (viewport.minX - 6) / width))
    let trailing = min(1, max(leading, (viewport.maxX - 6) / width))
    return from.addingTimeInterval(span * leading)...from.addingTimeInterval(span * trailing)
  }

  func position(_ point: LogPlotPoint, size: CGSize) -> CGPoint {
    let span = max(1, through.timeIntervalSince(from))
    let x = min(1, max(0, point.date.timeIntervalSince(from) / span))
    return CGPoint(x: 6 + x * max(0, size.width - 12), y: 6 + (high - point.value) / max(1, high - low) * max(0, size.height - 12))
  }
  func step(_ direction: Int) {
    guard !ordered.isEmpty else { return }
    let index = ordered.firstIndex { $0.id == inspected } ?? ordered.count - 1
    let next = ordered[min(ordered.count - 1, max(0, index + direction))]
    inspected = next.id; revealID = next.id
  }
}

extension MovementProgress {
  var logPlotPoints: [LogPlotPoint] {
    estimates.compactMap { point in
      guard let fact = point.fact.estimate else { return nil }
      let date = LogPresentation.date(point.startedAt)
      return LogPlotPoint(id: point.id.description, date: date, value: fact.e1rm,
        label: "\(Readout.estimatedWeight(fact.e1rm)) kg est · \(LogPresentation.brief(date)) · \(Readout.effort(weightKg: fact.weightKg, reps: fact.reps))")
    }
  }
}
