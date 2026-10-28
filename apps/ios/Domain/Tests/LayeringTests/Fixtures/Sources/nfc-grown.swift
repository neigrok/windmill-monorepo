// module: DomainKitNFC
// expect: nfc-pin the text is not §2.3's constant
import Foundation

public func nfc(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }
public func nfd(_ s: String) -> String { s.decomposedStringWithCanonicalMapping }

public func wallMs() -> Double { NSDate().timeIntervalSince1970 * 1000 }
