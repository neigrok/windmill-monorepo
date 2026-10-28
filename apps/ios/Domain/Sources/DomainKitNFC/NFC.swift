import Foundation

public func nfc(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }

public func nfd(_ s: String) -> String { s.decomposedStringWithCanonicalMapping }
