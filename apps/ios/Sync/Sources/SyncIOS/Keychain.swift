#if os(iOS)
import Foundation
import Security
import SyncEngine

// The session tokens (§7.4) in the Keychain: one generic password per account under one service. Readable after the
// first unlock, so the leave flush sends while the phone is locked, and never leaving this device, so a store restored or
// cloned from a backup finds no token and waits for the person to sign in.
public final class KeychainTokenStore: TokenStore {
  public let service: String

  public init(service: String = "windmill.sync.session") {
    self.service = service
  }

  public func token(for account: String) -> SessionToken? {
    var query = item(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
    return SessionToken(String(decoding: data, as: UTF8.self))
  }

  // An item kept already takes the new token and this store's accessibility.
  public func save(_ token: SessionToken, for account: String) throws {
    let stored: [String: Any] = [
      kSecValueData as String: Data(token.value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updated = SecItemUpdate(item(account) as CFDictionary, stored as CFDictionary)
    guard updated == errSecItemNotFound else { return try KeychainError.check(updated) }
    try KeychainError.check(SecItemAdd(item(account).merging(stored) { $1 } as CFDictionary, nil))
  }

  public func delete(for account: String) throws {
    let status = SecItemDelete(item(account) as CFDictionary)
    guard status != errSecItemNotFound else { return }
    try KeychainError.check(status)
  }

  public func accounts() -> [String] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let items = found as? [[String: Any]] else { return [] }
    return items.compactMap { $0[kSecAttrAccount as String] as? String }
  }

  func item(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }
}

// A Keychain call that failed, by its status.
public struct KeychainError: Error, Hashable, CustomStringConvertible {
  public let status: OSStatus

  static func check(_ status: OSStatus) throws {
    guard status == errSecSuccess else { throw KeychainError(status: status) }
  }

  public var description: String {
    "the Keychain answered \(status): \(SecCopyErrorMessageString(status, nil).map { $0 as String } ?? "no message")"
  }
}
#endif
