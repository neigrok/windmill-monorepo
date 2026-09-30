import Foundation
import Security

public enum Keychain { public static func service() -> CFString { kSecClassGenericPassword } }
