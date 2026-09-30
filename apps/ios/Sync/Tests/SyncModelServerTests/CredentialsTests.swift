import SyncModelServer
import Testing

// §9.1 credentials from raw headers, past what envelope/credentials.json pins, each answer `server/credentials.js`'s on
// the same headers: header names and the scheme in ASCII case only (a dotless ı is no `i`), a Bearer token holding no `\s`
// (a NEL may sit in it, a BOM may not), a cookie's name and value trimmed of space and tab only (a no-break space, NEL or
// BOM stays), a value of only space and tab, a token holding `=`, and empty pieces.

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
      ([("Author\u{131}zation", "Bearer s-ann")], .absent),
      ([("Cookie", "wm_session = s-ann")], .account("A")),
      ([("Cookie", "\twm_session\t=\ts-ann\t")], .account("A")),
      ([("Cookie", "wm_session= \t ")], .unresolved),
      ([("Cookie", " wm_session=s-ann\u{A0}")], .unresolved),
      ([("Cookie", "\u{A0}wm_session=s-ann")], .absent),
      ([("Cookie", "wm_session=\u{85}s-ann")], .unresolved),
      ([("Cookie", "wm_session=s-ann\u{FEFF}")], .unresolved),
      ([("Cookie", "wm_session=a=b")], .account("B")),
      ([("Cookie", "x=wm_session")], .absent),
      ([("Cookie", "")], .absent),
      ([("COOKIE", "wm_session=s-ann;;")], .account("A")),
      ([("Cookie", "WM_SESSION=s-ann")], .absent),
      ([("Cook\u{131}e", "wm_session=s-ann")], .absent),
      ([("Cookie", "wm_session=s-ann"), ("Authorization", "Bearer s-ann")], .account("A")),
    ]
    for (headers, served) in cases {
      #expect(Credential(headers: headers, sessions: sessions) == served, "\(headers)")
    }
  }
}
