import DomainKit
import SyncCore

// Roadmap Coach §4, §6.1: the abilities of catalog `roadmap/1` that run on the device's copy, each a pure function of the
// standing roadmap (D-2), the call's input and the roadmap the conversation is about (D-7, none for all of the person's),
// and what each answers: what it read, the room's acts a direct write is carried out as with what it answers, or the
// refusal of the call. Every ability answers in this form, the vectors' `expect`; the one that proposes answers in its own
// (`ProposalAnswer`).

// §6.1 What refused a call: its code, as `id` what the failing check is about where that is a step, a ref, a kind or a
// roadmap, and for a proposal's change its index, `at` (§7).
public struct CoachRefusal: Error, Equatable, Sendable {
  public enum Code: String, Sendable {
    case invalidInput = "invalid-input"
    case roadmapUnavailable = "roadmap-unavailable"
    case unknownRoadmap = "unknown-roadmap"
    case roadmapNotReady = "roadmap-not-ready"
    case notOwner = "not-owner"
    case outOfScope = "out-of-scope"
    case overLimit = "over-limit"
    case unknownStep = "unknown-step"
    case closesCycle = "closes-cycle"
    case takesEveryStart = "takes-every-start"
    case unknownKind = "unknown-kind"
    case addressNotAllowed = "address-not-allowed"
    case opensRoadmap = "opens-roadmap"
    case stepLocked = "step-locked"
    case hueTaken = "hue-taken"
    case roadmapChanged = "roadmap-changed"
    case noChange = "no-change"
  }

  public let code: Code
  public let id: String?
  public let at: Int?

  public init(_ code: Code, _ id: String? = nil, at: Int? = nil) {
    self.code = code
    self.id = id
    self.at = at
  }

  // The refusal of a proposal's change at `at`.
  func at(_ index: Int) -> CoachRefusal { CoachRefusal(code, id, at: index) }
}

extension CoachRefusal.Code {
  // §6.1, §6 rule 4: what the door would refuse of the texts a write sends, by the spec it applies to each, none where it
  // takes every one. A text the domain cannot store, one that holds U+0000, or one it takes no blank of, a subtask's, is
  // `invalid-input`, before any cap; one past its cap, measured as its spec measures it after the trim it applies, is
  // `over-limit`. A blank address is the address rule's (rule 5). A lone surrogate, which no store takes either, never
  // reaches Swift: its decoder refuses one first.
  init?(refusing texts: [(String?, TextSpec)]) {
    var codes: [CoachRefusal.Code] = []
    for (text, spec) in texts {
      guard let text else { continue }
      do throws(Violation) {
        _ = try spec.apply(text, at: Path(spec.path))
      } catch {
        switch error.reason {
        case .tooLong: codes.append(.overLimit)
        case .nul: codes.append(.invalidInput)
        default: if spec.path != RoadmapSpecs.linkUrl.path { codes.append(.invalidInput) }
        }
      }
    }
    guard let first = codes.first else { return nil }
    self = codes.contains(.invalidInput) ? .invalidInput : first
  }
}

// One of the room's own acts a direct write is carried out as (INV-2): the domain's act the room's control runs.
public enum RoomAct: Sendable {
  case mark(MarkStep)
  case changeStep(ChangeStep)
  case addSubtask(AddSubtask)
  case createStep(CreateStep)
  case changePrerequisites(ChangePrerequisites)

  // The act as a part of the one act a write commits.
  var part: AnyActAction<RoadmapRefusal> {
    switch self {
    case .mark(let act): AnyActAction(act)
    case .changeStep(let act): AnyActAction(act)
    case .addSubtask(let act): AnyActAction(act)
    case .createStep(let act): AnyActAction(act)
    case .changePrerequisites(let act): AnyActAction(act)
    }
  }
}

public enum AbilityResponse: Sendable {
  // A read's page.
  case result(JSON)
  // A direct write: the room's acts, the parts of one act, and what the call answers once they are written (§6's table).
  case writes([RoomAct], result: JSON)
  case refused(CoachRefusal)
}

// An ability of the catalog that runs on the copy: its input, decoded from a call, and what it answers, or the refusal it
// throws. A direct write draws a new step's id from `ids`, the tool host's source of new ids, once the call is taken.
protocol RoadmapAbility: Sendable {
  static var name: String { get }
  init(_ input: JSON) throws
  func answer(over standing: StandingRoadmaps, about: String?, ids: () -> String) throws(CoachRefusal) -> AbilityResponse
}

public enum RoadmapAbilities {
  static let runs: [any RoadmapAbility.Type] = [
    GetTree.self, GetNodes.self, FindNodes.self, GetProgress.self, GetDiagnostics.self, ListTrees.self,
    SetProgress.self, UpdateNode.self, CreateNode.self, Connect.self,
  ]

  // The names of the abilities that run on the copy, in the catalog's order.
  public static var names: [String] { runs.map { $0.name } }

  // What the ability `name` answers of `input`: an input it cannot read is malformed.
  public static func answer(_ name: String, _ input: JSON, over standing: StandingRoadmaps, about: String?, ids: () -> String) -> AbilityResponse {
    guard let ability = runs.first(where: { $0.name.utf8.elementsEqual(name.utf8) }) else { preconditionFailure("no ability \(name) runs on the copy") }
    let call: any RoadmapAbility
    do { call = try ability.init(input) } catch { return .refused(CoachRefusal(.invalidInput)) }
    do throws(CoachRefusal) { return try call.answer(over: standing, about: about, ids: ids) } catch { return .refused(error) }
  }
}

extension JSON {
  // A call's member: a text, a text it may leave out, and a list of texts it may leave out.
  func text(_ key: String) throws -> String { try member(key).asString() }
  func text(ifAny key: String) throws -> String? { try self[key]?.asString() }
  func texts(ifAny key: String) throws -> [String]? { try self[key]?.asArray().map { try $0.asString() } }
}
