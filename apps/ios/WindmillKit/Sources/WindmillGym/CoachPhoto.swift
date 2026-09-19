import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct CoachAttachment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let mediaType: String
    public let width: Int
    public let height: Int
    public let bytes: Int
}

struct CoachPhotoDraft: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let mediaType: String
    let width: Int
    let height: Int
    let bytes: Int
    var uploaded = false

    var attachment: CoachAttachment {
        CoachAttachment(id: id, mediaType: mediaType, width: width, height: height, bytes: bytes)
    }
}

enum CoachPhoto {
    static let maximumBytes = 5 * 1024 * 1024
    static let maximumEdge = 4096

    static func normalized(_ data: Data) throws -> (draft: CoachPhotoDraft, data: Data) {
        guard data.count <= 60 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw AskRefusal(line: "Choose a supported photo.")
        }
        for edge in [maximumEdge, 3072, 2048] {
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: edge, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                throw AskRefusal(line: "Choose a supported photo.")
            }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
                throw AskRefusal(line: "Choose a supported photo.")
            }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw AskRefusal(line: "Choose a supported photo.") }
            let encoded = output as Data
            if encoded.count <= maximumBytes {
                return (CoachPhotoDraft(id: "photo_" + UUID().uuidString.replacingOccurrences(of: "-", with: ""),
                    mediaType: "image/jpeg", width: image.width, height: image.height, bytes: encoded.count), encoded)
            }
        }
        throw AskRefusal(line: "Choose a smaller photo.")
    }
}
