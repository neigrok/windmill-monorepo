import SyncModelServer
import Testing

// §9.1 credentials read from raw headers, past what envelope/credentials.json pins: a header name and a scheme in any
// case, the whitespace the reference reads a header by (ECMAScript's `trim` and `\s`), a cookie piece trimmed around its
// name while its token stays verbatim, a token holding `=`, and empty pieces. Each answer is the reference's.

struct CredentialsTests {
  @Test func rawHeadersResolveAsTheReferenceReadsThem_9_1() {
    let sessions = ["s-ann": "A", "s-bob": "B", "s\u{85}x": "A", "s\u{FEFF}x": "A", "a=b": "B"]
    let cases: [(headers: [(name: String, value: String)], served: Credential)] = [
      ([("Authorization", "Bearer\ts-ann")], .unresolved),
      ([("Authorization", "bearer s-bob")], .account("B")),
      ([("AUTHORIZATION", "BEARER s-bob")], .account("B")),
      ([("Authorization", "Bearer  s-ann")], .unresolved),
      ([("Authorization", "Bearer s-ann ")], .unresolved),
      ([("Authorization", "")], .unresolved),
      ([("Authorization", "Bearer s\u{85}x")], .account("A")),
      ([("Authorization", "Bearer s\u{FEFF}x")], .unresolved),
      ([("Cookie", "wm_session = s-ann")], .unresolved),
      ([("Cookie", " wm_session=s-ann\u{A0}")], .account("A")),
      ([("Cookie", "wm_session=a=b")], .account("B")),
      ([("Cookie", "x=wm_session")], .absent),
      ([("Cookie", "")], .absent),
      ([("COOKIE", "wm_session=s-ann;;")], .account("A")),
      ([("Cookie", "WM_SESSION=s-ann")], .absent),
      ([("Cookie", "wm_session=s-ann"), ("Authorization", "Bearer s-ann")], .account("A")),
    ]
    for (headers, served) in cases {
      #expect(Credential(headers: headers, sessions: sessions) == served, "\(headers)")
    }
  }
}
