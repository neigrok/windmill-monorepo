import SyncAPI
import SyncCore

// D-19 one refusal as the engine states it. `predicted`: nothing was written. `notice`: a write committed on this device
// was refused by the server and now lives only in the notice.
public struct Refused: Hashable, Sendable {
  public enum Path: Hashable, Sendable {
    case predicted, notice
  }

  public let code: RefusalCode
  public let subject: RecordRef?
  public let detail: JSON?
  public let path: Path

  public init(_ code: RefusalCode, subject: RecordRef?, detail: JSON? = nil, path: Path) {
    self.code = code
    self.subject = subject
    self.detail = detail
    self.path = path
  }

  // §12.1 rule 3: a notice's subject is its first delta's record, else its command's first `ref<t>` argument in the
  // registry's argument order, else none.
  public init(_ notice: Notice, registry: Registry) {
    let fromDelta = notice.content.deltas.first.map { RecordRef(type: $0.key.type, id: $0.key.id) }
    self.init(notice.code, subject: fromDelta ?? Refused.commandSubject(notice.content.command, registry: registry),
              detail: notice.detail, path: .notice)
  }

  // A cap refusal's detail `{type, cap}`, on both paths.
  public var cap: (type: String, cap: Int)? {
    guard code == .cap, case .string(let type)? = detail?["type"], let cap = try? detail?["cap"]?.asInteger() else { return nil }
    return (type, Int(cap))
  }

  // §9.3: an executor records a growth past the cap it predicted in decide.
  public static func cap(_ type: String, cap: Int, subject: RecordRef?) -> Refused {
    Refused(.cap, subject: subject, detail: ["type": .string(type), "cap": JSON(cap)], path: .predicted)
  }

  static func commandSubject(_ command: Command?, registry: Registry) -> RecordRef? {
    guard let command, let definition = registry.command(command.name) else { return nil }
    for argument in definition.args {
      guard let type = argument.type.ref, let value = command.args[argument.name], let id = try? RecordID(json: value) else { continue }
      return RecordRef(type: type, id: id)
    }
    return nil
  }
}

// §12.2 a product's one refusal type for all its features: one total mapping of the code, the subject, the path and,
// for `cap` only, the detail. A code it does not expect maps to its generic case.
public protocol ProductRefusal: Error, Sendable {
  init(_ violation: Violation)
  init(_ refused: Refused)
  var isGeneric: Bool { get }
}

// §12.3 an engine notice as the product reads it.
public struct DomainNotice<R: ProductRefusal>: Identifiable, Sendable {
  public let id: String
  public let gestureId: String
  public let subject: RecordRef?
  public let refusal: R
  public let notice: Notice

  public init(_ notice: Notice, registry: Registry) {
    let refused = Refused(notice, registry: registry)
    id = notice.id
    gestureId = DomainNotice.gestureId(ofNotice: notice.id)
    subject = refused.subject
    refusal = R(refused)
    self.notice = notice
  }

  // What the refused content wrote to one record, its dependents' writes folded after its own; a text as its text.
  public func values(of record: RecordRef) -> [String: JSON] {
    var values: [String: JSON] = [:]
    DomainNotice.fold(notice.content, of: record.key, into: &values)
    return values
  }

  // The notice id is `notice:<gestureId>/<k>` (engine §7.7 step 4).
  static func gestureId(ofNotice id: String) -> String {
    let local = id.hasPrefix("notice:") ? id.dropFirst("notice:".count) : id[...]
    guard let slash = local.lastIndex(of: "/") else { return String(local) }
    return String(local[..<slash])
  }

  static func fold(_ content: NoticeContent, of key: RecordKey, into values: inout [String: JSON]) {
    for delta in content.deltas where delta.key == key {
      for (name, register) in delta.lattice.fields { values[name] = register.value }
      for (name, text) in delta.texts { values[name] = .string(text.text) }
    }
    for dependent in content.dependents { fold(dependent, of: key, into: &values) }
  }
}
