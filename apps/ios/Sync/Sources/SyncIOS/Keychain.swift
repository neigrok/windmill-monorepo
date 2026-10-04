#if os(iOS)
import Foundation
import Security
import SyncEngine

// The session tokens (§7.4) in the Keychain: one generic password per account under one service. Readable after the
// first unlock, so the leave flush sends while the phone is locked, and never leaving this device, so a store restored or
// cloned from a backup finds no token and waits for the person to sign in.
public final class KeychainTokenStore: TokenStore {
  public let service: String
  let telemetry: any Telemetry

  public init(service: String = "windmill.sync.session", telemetry: any Telemetry = NoopTelemetry()) {
    self.service = service
    self.telemetry = telemetry
  }

  public func token(for account: String) -> SessionToken? {
    var query = item(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    guard status != errSecItemNotFound else { return nil }
    guard status == errSecSuccess else {
      telemetry.failure("keychain_read", kind: "keychain")
      return nil
    }
    guard let data = found as? Data, let value = String(data: data, encoding: .utf8) else {
      telemetry.failure("keychain_read", kind: "decode")
      return nil
    }
    return SessionToken(value)
  }

  // An item kept already takes the new token and this store's accessibility.
  public func save(_ token: SessionToken, for account: String) throws {
    let stored: [String: Any] = [
      kSecValueData as String: Data(token.value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updated = SecItemUpdate(item(account) as CFDictionary, stored as CFDictionary)
    let status = updated == errSecItemNotFound ? SecItemAdd(item(account).merging(stored) { $1 } as CFDictionary, nil) : updated
    try check(status, operation: "keychain_save")
  }

  public func delete(for account: String) throws {
    let status = SecItemDelete(item(account) as CFDictionary)
    guard status != errSecItemNotFound else { return }
    try check(status, operation: "keychain_delete")
  }

  public func accounts() -> [String] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    guard status != errSecItemNotFound else { return [] }
    guard status == errSecSuccess else {
      telemetry.failure("keychain_accounts", kind: "keychain")
      return []
    }
    guard let items = found as? [[String: Any]] else {
      telemetry.failure("keychain_accounts", kind: "decode")
      return []
    }
    return items.compactMap { $0[kSecAttrAccount as String] as? String }
  }

  func item(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  func check(_ status: OSStatus, operation: String) throws {
    guard status == errSecSuccess else {
      telemetry.failure(operation, kind: "keychain")
      throw KeychainError(status: status)
    }
  }
}

// A Keychain call that failed, by its status.
public struct KeychainError: Error, Hashable, CustomStringConvertible {
  public let status: OSStatus

  public var description: String {
    "the Keychain answered \(status): \(SecCopyErrorMessageString(status, nil).map { $0 as String } ?? "no message")"
  }
}
#endif
