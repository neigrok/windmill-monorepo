import CryptoKit

public func digest(_ bytes: [UInt8]) -> [UInt8] { Array(SHA256.hash(data: bytes)) }
