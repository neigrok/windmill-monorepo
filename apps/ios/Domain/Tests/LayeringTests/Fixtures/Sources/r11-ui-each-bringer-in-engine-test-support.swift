// module: SyncTesting
// expect: 10: import StoreKit
// expect: 12: import SafariServices
// expect: 14: import LinkPresentation
// expect: 15: import QuickLook
// expect: 16: import PhotosUI
// expect: 17: import MapKit
// expect: 18: import AVKit
#if canImport(StoreKit)
import StoreKit
#elseif os(macOS)
import SafariServices
#else
import LinkPresentation
import QuickLook
import PhotosUI
import MapKit
import AVKit
#endif
