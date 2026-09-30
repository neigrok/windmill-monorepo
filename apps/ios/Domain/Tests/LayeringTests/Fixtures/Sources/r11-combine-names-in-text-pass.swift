// module: SyncTesting
// expect: pass
import Foundation
// An ObservableObject with @Published fields is a UI concern; AnyCancellable too.
let note = "ObservableObject, Published, AnyCancellable, PassthroughSubject, CurrentValueSubject"
let published = true
