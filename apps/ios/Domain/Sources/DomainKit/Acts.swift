import SyncAPI
import SyncCore

public struct ScopedPlan: Sendable {
  public let scope: ScopeRef
  public let plan: Plan
  public init(_ scope: ScopeRef, _ plan: Plan) { self.scope = scope; self.plan = plan }
}

public struct ActPlan: Sendable {
  public let segments: [ScopedPlan]
  public init(_ segments: [ScopedPlan]) { self.segments = segments }
}

public protocol ActAction: Sendable {
  associatedtype Loaded
  associatedtype Result: Sendable
  associatedtype Refusal: ProductRefusal
  func load(_ read: ActReader) throws -> Loaded
  func decide(_ loaded: Loaded, ids: ActIDSource) throws(Violation) -> ActDecision<Result, Refusal>
}

public enum ActDecision<Result, Refusal> {
  case write(ActPlan, Result)
  case unchanged(Result)
  case refuse(Refusal)
}

public enum ActOutcome<Result, Refusal> {
  case committed(Result, Receipt<ActReceipt>)
  case unchanged(Result)
  case refused(Refusal)
}

extension ActDecision: Sendable where Result: Sendable, Refusal: Sendable {}
extension ActOutcome: Sendable where Result: Sendable, Refusal: Sendable {}

public final class ActReader {
  let context: any ActContext
  let registry: Registry
  public let moment: Moment
  var isOpen = true

  package init(_ context: any ActContext, registry: Registry, moment: Moment) {
    self.context = context; self.registry = registry; self.moment = moment
  }

  public func inScope<T>(_ scope: ScopeRef, _ body: (Reader) throws -> T) throws -> T {
    precondition(isOpen, "an act reads only during load")
    return try context.inScope(scope) { try body(Reader($0, scope: scope, moment: moment, registry: registry)) }
  }

  // The load is over: a read after it traps.
  package func end() {
    isOpen = false
  }
}

public struct ActIDSource {
  let context: any ActContext

  package init(context: any ActContext) {
    self.context = context
  }

  public func mint<E: Entity>(_ type: E.Type, inScope scope: ScopeRef) -> ID<E> {
    precondition(EntityFacts(type).scope.map { $0 == scope } ?? true, "an identity names its entity's scope")
    do { return ID(try context.mintID(E.type, in: scope)) }
    catch { preconditionFailure("minting an act identity failed: \(error)") }
  }

  public func mint<E: ProductEntity>(_ type: E.Type) -> ID<E> { mint(type, inScope: E.scope) }

  public func opaqueID() -> String {
    do { return try context.opaqueID() }
    catch { preconditionFailure("minting an opaque act identity failed: \(error)") }
  }
}

// §9.7 one part of a composed act: an act whose result the composed outcome carries in order, refusing in the composed
// act's words.
public struct AnyActAction<Refusal: ProductRefusal>: Sendable {
  let decide: @Sendable (ActionRunner, any ActContext, Moment) throws -> ActDecision<any Sendable, Refusal>

  public init<A: ActAction>(_ action: A) where A.Refusal == Refusal {
    decide = { (runner: ActionRunner, context: any ActContext, moment: Moment) throws -> ActDecision<any Sendable, Refusal> in
      switch try runner.decide(action, in: context, moment: moment) {
      case .write(let plan, let result): .write(plan, result)
      case .unchanged(let result): .unchanged(result)
      case .refuse(let refusal): .refuse(refusal)
      }
    }
  }
}

// §9.7 a composed act's outcome: each part's result, in order, or the refusal of the part that met it.
public enum ComposedOutcome<Refusal> {
  case committed(results: [any Sendable], receipt: Receipt<ActReceipt>)
  case unchanged(results: [any Sendable])
  case refused(part: Int, refusal: Refusal)
}

extension ComposedOutcome: Sendable where Refusal: Sendable {}

extension ActionRunner {
  public func runAct<A: ActAction>(_ action: A) throws -> ActOutcome<A.Result, A.Refusal> {
    precondition(!ActionRunner.isRunning, "a run cannot enter inside a run")
    return try ActionRunner.$isRunning.withValue(true) {
      do {
        let committed = try replica.commitAct({ context -> (ActRequest?, ActStep<A.Result, A.Refusal>) in
          switch try decide(action, in: context, moment: Moment(now: Instant(ms: context.now), zone: zone)) {
          case .refuse(let refusal): return (nil, .done(.refused(refusal)))
          case .unchanged(let result): return (nil, .done(.unchanged(result)))
          case .write(let act, let result): return (request(act.segments), .writing(act, result))
          }
        }, segment: { step, index, context in
          guard case .writing(let act, _) = step else { preconditionFailure("only a writing act has segments") }
          return try segment(act.segments[index], in: context)
        })
        switch committed.value {
        case .done(let outcome): return outcome
        case .writing(let act, let result):
          switch committed.outcome {
          case .committed(let receipt): return .committed(result, Receipt(receipt, undo: UndoHandle(receipt.gestureId, of: act.segments.map(\.plan))))
          case .refused(let index, let code, let detail): return .refused(A.Refusal(refused(act.segments[index].plan, code: code, detail: detail)))
          case nil: return .unchanged(result)
          }
        }
      } catch let prediction as ActPrediction { return .refused(A.Refusal(prediction.refusal)) }
      catch let failure as CommitFailure where failure.kind == .malformed { preconditionFailure("a malformed act is a programming fault: \(failure)") }
    }
  }

  // §9.7 several acts as one. Each part loads through the segments of the parts before it, which the engine stages on the
  // act's tentative copy, and then decides. A refusal of any part, a failed check, a gone record or a segment the engine
  // refuses locally refuses the whole act before anything is written. The parts' segments then commit as one act: one
  // gesture id, one hold (held when any part's plan holds) and one Undo carrying every part's recipes.
  public func runComposed<Refusal: ProductRefusal>(_ parts: [AnyActAction<Refusal>]) throws -> ComposedOutcome<Refusal> {
    precondition(!ActionRunner.isRunning, "a run cannot enter inside a run")
    precondition(!parts.isEmpty, "a composed act has parts")
    return try ActionRunner.$isRunning.withValue(true) {
      do {
        let committed = try replica.commitAct({ context -> (ActRequest?, ComposedStep<Refusal>) in
          let moment = Moment(now: Instant(ms: context.now), zone: zone)
          var results: [any Sendable] = []
          var segments: [PartSegment] = []
          for (part, action) in parts.enumerated() {
            if part > 0 { try context.beginPart() }
            let act: ActPlan
            switch try action.decide(self, context, moment) {
            case .refuse(let refusal): return (nil, .done(.refused(part: part, refusal: refusal)))
            case .unchanged(let result):
              results.append(result)
              continue
            case .write(let plan, let result):
              results.append(result)
              act = plan
            }
            for scoped in act.segments {
              let staged: StagedRefusal?
              do { staged = try context.stage(scoped.scope) { (input: any CommitContext) throws -> Gesture in try segment(scoped, in: input) } }
              catch let prediction as ActPrediction { return (nil, .done(.refused(part: part, refusal: Refusal(prediction.refusal)))) }
              if let staged {
                return (nil, .done(.refused(part: part, refusal: Refusal(refused(scoped.plan, code: staged.code, detail: staged.detail)))))
              }
              segments.append(PartSegment(part: part, scoped: scoped))
            }
          }
          guard !segments.isEmpty else { return (nil, .done(.unchanged(results: results))) }
          return (request(segments.map(\.scoped)), .writing(segments, results: results))
        }, segment: { step, index, context in
          guard case .writing(let segments, _) = step else { preconditionFailure("only a writing act has segments") }
          do { return try segment(segments[index].scoped, in: context) }
          catch let prediction as ActPrediction { throw ActPrediction(refusal: prediction.refusal, part: segments[index].part) }
        })
        switch committed.value {
        case .done(let outcome): return outcome
        case .writing(let segments, let results):
          switch committed.outcome {
          case .committed(let receipt):
            return .committed(results: results, receipt: Receipt(receipt, undo: UndoHandle(receipt.gestureId, of: segments.map(\.scoped.plan))))
          case .refused(let index, let code, let detail):
            return .refused(part: segments[index].part, refusal: Refusal(refused(segments[index].scoped.plan, code: code, detail: detail)))
          case nil: return .unchanged(results: results)
          }
        }
      } catch let prediction as ActPrediction { return .refused(part: prediction.part, refusal: Refusal(prediction.refusal)) }
      catch let failure as CommitFailure where failure.kind == .malformed { preconditionFailure("a malformed act is a programming fault: \(failure)") }
    }
  }

  // An act's load through its reader, then its decision, a failed check refusing it.
  func decide<A: ActAction>(_ action: A, in context: any ActContext, moment: Moment) throws -> ActDecision<A.Result, A.Refusal> {
    let read = ActReader(context, registry: registry, moment: moment)
    let loaded: A.Loaded
    do { loaded = try action.load(read) }
    catch { read.end(); throw error }
    read.end()
    try context.finishLoad()
    do throws(Violation) { return try action.decide(loaded, ids: ActIDSource(context: context)) }
    catch { return .refuse(A.Refusal(error)) }
  }

  // The engine's request for an act's segments: their scopes in order, one hold when any plan holds, and each opted
  // segment's Undo recipes by its index.
  func request(_ segments: [ScopedPlan]) -> ActRequest {
    let opted: [ActUndo.Segment] = segments.enumerated().compactMap { (index: Int, segment: ScopedPlan) -> ActUndo.Segment? in
      segment.plan.undoRecipes(in: segment.scope).map { ActUndo.Segment(index: index, recipes: $0) }
    }
    return ActRequest(scopes: segments.map(\.scope), hold: holdRemovals && segments.contains { $0.plan.isHeld },
                      undo: opted.isEmpty ? nil : ActUndo(segments: opted))
  }

  // One segment's gesture over the views through the act's earlier segments, a gone record refusing it.
  func segment(_ scoped: ScopedPlan, in context: any CommitContext) throws -> Gesture {
    if let gone = try scoped.plan.firstGone(in: context, of: scoped.scope, registry: registry) { throw ActPrediction(refusal: gone) }
    return try scoped.plan.gesture(in: scoped.scope, registry: registry, holdRemovals: holdRemovals)
  }

  // An engine refusal of a plan's segment, as the kit names it.
  func refused(_ plan: Plan, code: RefusalCode, detail: JSON?) -> Refused {
    Refused(code, subject: plan.subject(ofRefusal: code, detail: detail, registry: registry), detail: detail, path: .predicted)
  }
}

enum ActStep<Result, Refusal> {
  case done(ActOutcome<Result, Refusal>)
  case writing(ActPlan, Result)
}

// A composed act's segment, with the part it belongs to.
struct PartSegment {
  let part: Int
  let scoped: ScopedPlan
}

enum ComposedStep<Refusal> {
  case done(ComposedOutcome<Refusal>)
  case writing([PartSegment], results: [any Sendable])
}

// A segment the kit refuses before the engine writes it (a gone record), naming the composed act's part it belongs to.
struct ActPrediction: Error {
  let refusal: Refused
  var part = 0
}
