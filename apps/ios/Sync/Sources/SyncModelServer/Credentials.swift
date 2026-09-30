import SyncCore

// §9.1 credentials: what a request sends, read from its header fields as received, every occurrence kept in order, and
// what they resolve to, which every endpoint takes. A framework's header map keeps one of two headers, so an adapter
// hands over the fields themselves.

// What a request's credentials resolved to: none was sent, so the request is anonymous; they resolved to an account; or
// they were sent and resolved to none (revoked, expired, unknown or malformed, two of one kind, or two accounts). Ones
// that do not resolve, or resolve to an account id outside §9.1's form, fail: every endpoint answers them 401, never as
// anonymous.
public enum Credential: Sendable, Hashable {
  case absent
  case account(String)
  case unresolved

  public static let sessionCookie = "wm_session"

  // The credentials `headers` send, against `sessions`, each live session's token to its account. They resolve only when
  // at most one Authorization header and at most one session cookie are sent, each of its form, each token a live
  // session's, and a cookie and a header sent together name one account. Tokens and accounts compare byte for byte.
  public init(headers: [(name: String, value: String)], sessions: [String: String]) {
    let sent = SentCredential.all(in: headers)
    guard !sent.isEmpty else {
      self = .absent
      return
    }
    guard Set(sent.map(\.kind)).count == sent.count else {
      self = .unresolved
      return
    }
    let accounts = sent.map { credential in
      credential.token.flatMap { token in sessions.first { $0.key.utf8.elementsEqual(token.utf8) }?.value }
    }
    guard let account = accounts[0], accounts.allSatisfy({ $0?.utf8.elementsEqual(account.utf8) == true }) else {
      self = .unresolved
      return
    }
    self = .account(account)
  }

  public var fails: Bool {
    switch self {
    case .absent: false
    case .account(let account): !AccountID.isWellFormed(account)
    case .unresolved: true
    }
  }

  // The account a request is served as, nil when anonymous.
  public var account: String? {
    guard case .account(let account) = self else { return nil }
    return account
  }
}

// One credential a request sends: an Authorization header, or a Cookie piece named the session cookie, whatever its
// shape. Its token is the one `Bearer <token>` (the scheme in any ASCII case, one space, a token holding no whitespace)
// or `wm_session=<token>` carries, the cookie's with only space and tab trimmed: no quote is stripped, nothing unescaped.
// Any other shape carries none: another scheme, a bare `Bearer`, a bare `wm_session` with no `=`, or an empty value.
struct SentCredential: Hashable {
  enum Kind: Hashable {
    case authorization, cookie
  }

  let kind: Kind
  let token: String?

  // Every credential `headers` send, in their order. Header names compare in ASCII case only, so a Kelvin sign is no `k`;
  // a Cookie header splits on `;` into pieces, a piece's name is what precedes its first `=` and its value what follows
  // it. Names and tokens are read as Unicode scalars, so they compare byte for byte.
  static func all(in headers: [(name: String, value: String)]) -> [SentCredential] {
    headers.flatMap { header -> [SentCredential] in
      switch header.name.unicodeScalars.map(asciiLowercased) {
      case Array("authorization".unicodeScalars): [SentCredential(kind: .authorization, token: bearerToken(Array(header.value.unicodeScalars)))]
      case Array("cookie".unicodeScalars): sessionCookies(in: Array(header.value.unicodeScalars))
      default: []
      }
    }
  }

  static func sessionCookies(in value: [Unicode.Scalar]) -> [SentCredential] {
    value.split(separator: ";", omittingEmptySubsequences: false).compactMap { piece in
      let equals = piece.firstIndex(of: "=")
      let name = trimmingSpaceAndTab(piece[..<(equals ?? piece.endIndex)])
      guard name == Array(Credential.sessionCookie.unicodeScalars) else { return nil }
      let token = equals.map { trimmingSpaceAndTab(piece[($0 + 1)...]) } ?? []
      return SentCredential(kind: .cookie, token: token.isEmpty ? nil : String(String.UnicodeScalarView(token)))
    }
  }

  // RFC 6265's whitespace around a cookie's name and value: space and tab only, so a no-break space, a NEL or a BOM stays.
  static func trimmingSpaceAndTab(_ scalars: ArraySlice<Unicode.Scalar>) -> [Unicode.Scalar] {
    let spaceAndTab: Set<Unicode.Scalar> = [" ", "\t"]
    guard let first = scalars.firstIndex(where: { !spaceAndTab.contains($0) }),
          let last = scalars.lastIndex(where: { !spaceAndTab.contains($0) }) else { return [] }
    return Array(scalars[first...last])
  }

  static func bearerToken(_ value: [Unicode.Scalar]) -> String? {
    let scheme = Array("bearer ".unicodeScalars)
    guard value.count > scheme.count, value[..<scheme.count].map(asciiLowercased) == scheme else { return nil }
    let token = value[scheme.count...]
    guard !token.contains(where: isBearerSpace) else { return nil }
    return String(String.UnicodeScalarView(token))
  }

  // The reference's ECMAScript `\s`, which a Bearer token holds none of: Unicode's White_Space less U+0085, plus U+FEFF.
  static func isBearerSpace(_ scalar: Unicode.Scalar) -> Bool {
    scalar == "\u{FEFF}" || (scalar != "\u{85}" && scalar.properties.isWhitespace)
  }

  static func asciiLowercased(_ scalar: Unicode.Scalar) -> Unicode.Scalar {
    ("A"..."Z").contains(scalar) ? Unicode.Scalar(scalar.value + 32)! : scalar
  }
}
