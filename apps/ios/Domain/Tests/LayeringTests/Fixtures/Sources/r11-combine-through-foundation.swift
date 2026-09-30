// module: SyncEngine
// expect: 8: combine ObservableObject
// expect: 9: combine @Published
// expect: 10: combine AnyCancellable
// expect: 11: combine PassthroughSubject
// expect: 12: combine CurrentValueSubject
import Foundation
public final class SyncStatus: ObservableObject {
  @Published public private(set) var pending = 0
  var bag: Set<AnyCancellable> = []
  let changes = PassthroughSubject<Int, Never>()
  let last = CurrentValueSubject<Int, Never>(0)
}
